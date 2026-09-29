import type {
  AffectedPair, AuditEntry, Checkpoint, CommitMarker, ConflictFieldChange, ConflictInfo,
  ConflictMatchChange, ConflictRecordChange, EditLease, ErrorPackage, LeaseHolder,
  PersistedSlice
} from '../types';
import { fieldLabelOf, newId } from './labels';
import { applyIntent, type IntentResult, type WorkspaceIntent } from './intents';

const LEGACY_KEY = 'sologsb-1020-archive-state-v1';
export const STATE_STORAGE_KEY = 'sologsb-1020-workspace-v2';
const BASE_KEY = STATE_STORAGE_KEY;
const STATE_KEY = STATE_STORAGE_KEY;
const CHECKPOINTS_KEY = `${BASE_KEY}::checkpoints`;
const LEASE_KEY = `${BASE_KEY}::lease`;
const COMMIT_KEY = `${BASE_KEY}::commit`;
const LEGACY_BACKUP_KEY = `${LEGACY_KEY}::migration-backup`;
const CURRENT_SCHEMA = 2;
const MAX_CHECKPOINTS = 15;
/** 编辑权租约有效期：覆盖一次提交窗口，过期自动释放，崩溃不留死锁 */
export const LEASE_TTL_MS = 10_000;

export interface LoadResult {
  slice: PersistedSlice | null;
  recoveredFromCheckpoint: boolean;
  checkpoints: Checkpoint[];
  recoveryPairs: AffectedPair[];
  migratedFromLegacy: boolean;
  errorPackage: ErrorPackage | null;
  legacyKept: boolean;
}

export class WorkspaceError extends Error {
  constructor(public code: 'lease-held' | 'version-stale' | 'invalid-state' | 'storage-full' | 'conflict', message: string) {
    super(message);
  }
}

const readJSON = <T>(storage: Storage, key: string): T | null => {
  const raw = storage.getItem(key);
  if (raw == null) return null;
  return JSON.parse(raw) as T;
};

const writeJSON = (storage: Storage, key: string, value: unknown) => {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (error) {
    throw new WorkspaceError('storage-full', `本地存储空间不足，未能写入 ${key}：${(error as Error).message}`);
  }
};

const nowIso = () => new Date().toISOString();
const shortSession = (id: string) => id.slice(0, 8);

/** 判定落盘切片是否结构可用 */
const isSlice = (value: unknown): value is PersistedSlice => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.records) && Array.isArray(candidate.matches)
    && Array.isArray(candidate.merges) && Array.isArray(candidate.audit)
    && typeof candidate.revision === 'number';
};

/** 旧版本地数据迁移：v1 裸切片 → v2；成功后保留原始数据副本 */
const migrateLegacy = (storage: Storage): { slice: PersistedSlice | null; migrated: boolean; error: ErrorPackage | null } => {
  const raw = storage.getItem(LEGACY_KEY);
  if (raw == null) return { slice: null, migrated: false, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      slice: null, migrated: false,
      error: buildErrorPackage('workspace-migration-error', LEGACY_KEY, (error as Error).message, raw)
    };
  }
  if (!isSlice(parsed)) {
    return {
      slice: null, migrated: false,
      error: buildErrorPackage('workspace-migration-error', LEGACY_KEY, '旧版数据缺少 records / matches / merges / audit / revision 字段', raw)
    };
  }
  const slice: PersistedSlice = {
    revision: parsed.revision,
    records: parsed.records,
    matches: parsed.matches,
    merges: parsed.merges,
    audit: parsed.audit.map((entry) => ({ ...entry }))
  };
  // 迁移成功也先把原始数据原样保留，迁移绝不破坏原件
  storage.setItem(LEGACY_BACKUP_KEY, raw);
  slice.audit.unshift({
    id: newId(), at: nowIso(), action: '迁移本地数据',
    detail: `旧版本地数据（v1）已迁移为工作区 v${CURRENT_SCHEMA}，原数据保留于 ${LEGACY_BACKUP_KEY}`,
    recordIds: [], rev: slice.revision
  });
  writeJSON(storage, STATE_KEY, slice);
  return { slice, migrated: true, error: null };
};

export const buildErrorPackage = (
  kind: ErrorPackage['kind'], key: string, message: string, raw: string, quarantineKey?: string
): ErrorPackage => ({
  kind, at: nowIso(), key, quarantineKey, message,
  userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
  raw
});

/** 导出错误包：读取 / 迁移失败时保留原数据并下载 */
export const downloadErrorPackage = (pkg: ErrorPackage) => {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `workspace-error-${pkg.kind}-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
};

export const loadWorkspace = (storage: Storage): LoadResult => {
  let errorPackage: ErrorPackage | null = null;
  let slice: PersistedSlice | null = null;

  const v2raw = storage.getItem(STATE_KEY);
  if (v2raw != null) {
    try {
      const parsed = JSON.parse(v2raw) as unknown;
      if (!isSlice(parsed)) throw new Error('工作区数据结构不完整');
      slice = parsed;
    } catch (error) {
      // v2 读取失败：先把损坏原件原样隔离到独立键，再导出错误包并尝试从 v1 兜底。
      // 绝不删除或就地覆盖原数据。
      const quarantineKey = `${STATE_KEY}::quarantine-${Date.now()}`;
      try { storage.setItem(quarantineKey, v2raw); } catch { /* 隔离失败仍可下载错误包 */ }
      errorPackage = buildErrorPackage(
        'workspace-read-error', STATE_KEY, (error as Error).message, v2raw, quarantineKey
      );
      slice = null;
    }
  }

  let migratedFromLegacy = false;
  let legacyKept = false;
  if (!slice) {
    const legacy = migrateLegacy(storage);
    if (legacy.error) errorPackage = errorPackage ?? legacy.error;
    if (legacy.slice) {
      slice = legacy.slice;
      migratedFromLegacy = legacy.migrated;
      legacyKept = legacy.migrated;
    }
  } else if (storage.getItem(LEGACY_KEY) != null) {
    legacyKept = true;
  }

  let checkpoints: Checkpoint[] = [];
  try {
    const saved = readJSON<Checkpoint[]>(storage, CHECKPOINTS_KEY);
    if (Array.isArray(saved)) checkpoints = saved.filter((point) => point && point.snapshot);
  } catch {
    checkpoints = [];
  }

  // 崩溃 / 刷新恢复：上次提交留有进行中标记时，回到该检查点
  let recoveredFromCheckpoint = false;
  let recoveryPairs: AffectedPair[] = [];
  const marker = (() => { try { return readJSON<CommitMarker>(storage, COMMIT_KEY); } catch { return null; } })();
  if (marker && slice) {
    const target = checkpoints.find((point) => point.id === marker.checkpointId) ?? checkpoints[0];
    // 存储版本仍停在动作前版本，说明标记写入后、提交落盘前断开；版本已推进则说明提交其实成功
    const interrupted = slice.revision === marker.baseRevision;
    if (interrupted && target && isSlice(target.snapshot)) {
      const restored: PersistedSlice = {
        ...target.snapshot,
        revision: slice.revision + 1,
        audit: [{
          id: newId(), at: nowIso(), action: '崩溃恢复',
          detail: `检测到「${marker.label}」在提交过程中断开，已回到最近检查点（r${target.baseRevision}）`,
          recordIds: [], rev: slice.revision + 1
        }, ...target.snapshot.audit]
      };
      slice = restored;
      writeJSON(storage, STATE_KEY, restored);
      recoveredFromCheckpoint = true;
      recoveryPairs = target.affected;
    }
    storage.removeItem(COMMIT_KEY);
  }

  // 启动时清理过期租约
  const lease = (() => { try { return readJSON<EditLease>(storage, LEASE_KEY); } catch { return null; } })();
  if (lease && new Date(lease.expiresAt).getTime() <= Date.now()) storage.removeItem(LEASE_KEY);

  return {
    slice, recoveredFromCheckpoint, checkpoints, recoveryPairs,
    migratedFromLegacy, errorPackage, legacyKept
  };
};

export const readCheckpoints = (storage: Storage): Checkpoint[] => {
  try {
    const saved = readJSON<Checkpoint[]>(storage, CHECKPOINTS_KEY);
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
};

const persistCheckpoints = (storage: Storage, points: Checkpoint[]) => {
  writeJSON(storage, CHECKPOINTS_KEY, points.slice(0, MAX_CHECKPOINTS));
};

/** 提交前领取编辑权并携带当时版本；他人持有时返回持有人 */
export const acquireLease = (
  storage: Storage, sessionId: string, sessionLabel: string, action: string
): { lease: EditLease; base: PersistedSlice } | { holder: LeaseHolder } => {
  const raw = storage.getItem(STATE_KEY);
  if (raw == null) throw new WorkspaceError('invalid-state', '工作区尚未初始化');
  const base = JSON.parse(raw) as PersistedSlice;
  if (!isSlice(base)) throw new WorkspaceError('invalid-state', '本地工作区数据无法解析');

  const existing = (() => { try { return readJSON<EditLease>(storage, LEASE_KEY); } catch { return null; } })();
  if (existing && existing.sessionId !== sessionId && new Date(existing.expiresAt).getTime() > Date.now()) {
    return { holder: existing };
  }
  const lease: EditLease = {
    sessionId,
    sessionLabel,
    action,
    baseRevision: base.revision,
    acquiredAt: nowIso(),
    expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString()
  };
  writeJSON(storage, LEASE_KEY, lease);
  return { lease, base };
};

export const currentLeaseHolder = (storage: Storage): LeaseHolder | null => {
  try {
    const lease = readJSON<EditLease>(storage, LEASE_KEY);
    if (!lease || new Date(lease.expiresAt).getTime() <= Date.now()) return null;
    return lease;
  } catch {
    return null;
  }
};

export const releaseLease = (storage: Storage, sessionId: string) => {
  try {
    const lease = readJSON<EditLease>(storage, LEASE_KEY);
    if (lease?.sessionId === sessionId) storage.removeItem(LEASE_KEY);
  } catch { /* 忽略 */ }
};

/**
 * 每批确认 / 忽略 / 合并 / 导入 / 回退前留下检查点。
 * 检查点先于任何写入落盘，保证提交中断时能整体回到动作前。
 */
export const saveCheckpoint = (
  storage: Storage, slice: PersistedSlice, label: string, kind: AffectedPair['kind'], affected: AffectedPair[]
): Checkpoint => {
  const point: Checkpoint = {
    id: newId(),
    at: nowIso(),
    label,
    kind,
    baseRevision: slice.revision,
    affected,
    snapshot: {
      revision: slice.revision,
      records: slice.records,
      matches: slice.matches,
      merges: slice.merges,
      audit: slice.audit
    }
  };
  const points = readCheckpoints(storage);
  persistCheckpoints(storage, [point, ...points]);
  return point;
};

const fieldText = (record: Record<string, unknown>, field: string): string => {
  const value = record[field];
  return Array.isArray(value) ? (value as string[]).join('、') : String(value ?? '');
};

/** 基于检查点（动作前版本）与最新落盘版本，构造对方动作与字段级差异 */
export const buildConflict = (
  storage: Storage, info: {
    label: string;
    checkpoint: Checkpoint;
    lease: EditLease;
    triedRevision: number;
    affected: AffectedPair[];
  }
): ConflictInfo => {
  const latest = JSON.parse(storage.getItem(STATE_KEY) ?? 'null') as PersistedSlice | null;
  const base = info.checkpoint.snapshot;
  const incomingActions: AuditEntry[] = latest
    ? latest.audit.filter((entry) => typeof entry.rev === 'number' && entry.rev > base.revision)
    : [];

  const recordChanges: ConflictRecordChange[] = [];
  if (latest) {
    latest.records.forEach((record) => {
      const before = base.records.find((item) => item.id === record.id);
      if (!before) {
        recordChanges.push({ id: record.id, title: record.title, change: 'added', statusAfter: record.status, fields: [] });
        return;
      }
      const fields: ConflictFieldChange[] = [];
      (['title', 'date', 'people', 'places', 'identifier', 'medium', 'extent', 'rights', 'notes'] as const)
        .forEach((field) => {
          const oldText = fieldText(before as unknown as Record<string, unknown>, field);
          const newText = fieldText(record as unknown as Record<string, unknown>, field);
          if (oldText !== newText) {
            fields.push({ field, label: fieldLabelOf(field), before: oldText, after: newText });
          }
        });
      if (fields.length || before.status !== record.status) {
        recordChanges.push({
          id: record.id, title: record.title, change: 'modified',
          statusBefore: before.status, statusAfter: record.status, fields
        });
      }
    });
    base.records.forEach((before) => {
      if (!latest.records.some((record) => record.id === before.id)) {
        recordChanges.push({ id: before.id, title: before.title, change: 'removed', statusBefore: before.status, fields: [] });
      }
    });
  }

  const matchChanges: ConflictMatchChange[] = [];
  if (latest) {
    const titleOf = (id: string) => latest.records.find((record) => record.id === id)?.title
      ?? base.records.find((record) => record.id === id)?.title ?? id;
    latest.matches.forEach((match) => {
      const before = base.matches.find((item) => item.id === match.id);
      if (!before) {
        matchChanges.push({
          id: match.id, leftTitle: titleOf(match.leftId), rightTitle: titleOf(match.rightId),
          change: 'added', after: match.status
        });
      } else if (before.status !== match.status) {
        matchChanges.push({
          id: match.id, leftTitle: titleOf(match.leftId), rightTitle: titleOf(match.rightId),
          change: 'status', before: before.status, after: match.status
        });
      }
    });
    base.matches.forEach((before) => {
      if (!latest.matches.some((match) => match.id === before.id)) {
        matchChanges.push({
          id: before.id,
          leftTitle: titleOf2(base, before.leftId), rightTitle: titleOf2(base, before.rightId),
          change: 'removed', before: before.status
        });
      }
    });
  }

  const holder = currentLeaseHolder(storage) ?? undefined;
  return {
    label: info.label,
    checkpointId: info.checkpoint.id,
    baseRevision: info.checkpoint.baseRevision,
    triedRevision: info.triedRevision,
    latestRevision: latest?.revision ?? info.checkpoint.baseRevision,
    holder,
    incomingActions,
    recordChanges: recordChanges.slice(0, 60),
    matchChanges: matchChanges.slice(0, 60),
    mergeAdded: latest ? Math.max(0, latest.merges.length - base.merges.length) : 0,
    affected: info.affected
  };
};

const titleOf2 = (slice: PersistedSlice, id: string) =>
  slice.records.find((record) => record.id === id)?.title ?? id;

export interface CommitOutcome {
  slice: PersistedSlice;
  result: IntentResult;
  conflict: ConflictInfo | null;
  heldBy: LeaseHolder | null;
}

/** 公共提交闸门：重读存储，校验租约与版本，落后则拦住写入 */
const runCommit = (
  storage: Storage, sessionId: string, checkpoint: Checkpoint,
  prepare: (base: PersistedSlice) => { next: PersistedSlice; result: IntentResult; conflictAffected: AffectedPair[] }
): CommitOutcome => {
  const lease = (() => { try { return readJSON<EditLease>(storage, LEASE_KEY); } catch { return null; } })();
  if (!lease || lease.sessionId !== sessionId) {
    const parsed = (() => { try { return JSON.parse(storage.getItem(STATE_KEY) ?? 'null') as PersistedSlice | null; } catch { return null; } })();
    return {
      slice: parsed ?? { revision: 0, records: [], matches: [], merges: [], audit: [] },
      result: { action: '', detail: '', affected: [], toast: '' },
      conflict: null,
      heldBy: currentLeaseHolder(storage)
    };
  }
  const stored = JSON.parse(storage.getItem(STATE_KEY) ?? 'null') as PersistedSlice | null;
  if (!stored || !isSlice(stored)) throw new WorkspaceError('invalid-state', '本地工作区数据无法解析');

  // 检查点必须属于本次领取：提交前领取的编辑权携带当时版本，
  // 旧检查点（基准与租约不一致）一律拒绝，防止绕过版本检查
  if (checkpoint.baseRevision !== lease.baseRevision) {
    storage.removeItem(LEASE_KEY);
    throw new WorkspaceError(
      'version-stale',
      `编辑权基于 r${lease.baseRevision}，检查点却停留在 r${checkpoint.baseRevision}，请重新领取编辑权`
    );
  }

  // 版本落后：拦截写入，指出冲突动作和版本
  if (stored.revision !== lease.baseRevision) {
    storage.removeItem(LEASE_KEY);
    // 冲突说明只使用动作前检查点，不在对方新版本上重放（目标可能已被处理）
    const fallback = prepare(checkpoint.snapshot);
    return {
      slice: stored,
      result: { action: '', detail: '', affected: [], toast: '' },
      conflict: buildConflict(storage, {
        label: checkpoint.label,
        checkpoint,
        lease,
        triedRevision: checkpoint.baseRevision + 1,
        affected: fallback.conflictAffected
      }),
      heldBy: null
    };
  }

  const { next, result } = prepare(stored);
  next.revision = stored.revision + 1;
  const entry: AuditEntry = {
    id: newId(),
    at: nowIso(),
    action: result.action,
    detail: result.detail,
    recordIds: next.records
      .filter((record) => result.affected.some((pair) =>
        (pair.leftId && pair.leftId === record.id) || (pair.rightId && pair.rightId === record.id)))
      .map((record) => record.id),
    before: `r${checkpoint.baseRevision}`,
    after: `r${next.revision}`,
    rev: next.revision
  };
  next.audit = [entry, ...next.audit].slice(0, 400);

  writeJSON(storage, STATE_KEY, next);
  storage.removeItem(LEASE_KEY);
  storage.removeItem(COMMIT_KEY);
  return { slice: next, result, conflict: null, heldBy: null };
};

/**
 * 带版本凭据的意图提交（确认 / 忽略 / 合并 / 导入 / 回退）：
 * 重新读取存储版本，落后就拦住写入并产出冲突说明；
 * 只有版本仍是领取时版本才写入并推进版本号。
 */
export const commitIntent = (
  storage: Storage,
  sessionId: string,
  checkpoint: Checkpoint,
  intent: WorkspaceIntent
): CommitOutcome => runCommit(storage, sessionId, checkpoint, (base) => {
  // 回退到检查点：采用目标检查点快照；其余意图在动作前快照草稿上重放
  let next: PersistedSlice;
  let result: IntentResult;
  if (intent.type === 'rollback') {
    const points = readCheckpoints(storage);
    const target = points.find((point) => point.id === intent.checkpointId);
    if (!target || !isSlice(target.snapshot)) throw new WorkspaceError('invalid-state', '要回退的检查点已不存在');
    next = { ...target.snapshot, revision: 0 };
    result = applyIntent(next, intent);
  } else {
    next = {
      revision: 0,
      records: base.records,
      matches: base.matches,
      merges: base.merges,
      audit: base.audit
    };
    result = applyIntent(next, intent);
  }
  return { next, result, conflictAffected: checkpoint.affected };
});

/** 撤销 / 重做：直接提交已准备好的目标快照，仍经过同样的版本闸门 */
export const commitSnapshot = (
  storage: Storage,
  sessionId: string,
  checkpoint: Checkpoint,
  target: PersistedSlice,
  result: IntentResult,
  conflictAffected: AffectedPair[]
): CommitOutcome => runCommit(storage, sessionId, checkpoint, () => ({
  next: { ...target, revision: 0 },
  result,
  conflictAffected
}));

export const writeCommitMarker = (storage: Storage, checkpoint: Checkpoint, kind: string) => {
  writeJSON(storage, COMMIT_KEY, {
    checkpointId: checkpoint.id, kind, label: checkpoint.label, baseRevision: checkpoint.baseRevision, at: nowIso()
  } satisfies CommitMarker);
};

export const sessionLabelOf = (id: string) => `核对页 ${shortSession(id)}`;
