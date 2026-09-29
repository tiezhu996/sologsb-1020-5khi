import type {
  AffectedPair, AuditEntry, BootResult, Checkpoint, ConflictInfo, ErrorBundle,
  LeaseRecord, PendingMarker, RecoveryNotice, SupersededPair, WorkspaceData, WorkspaceEnvelope
} from '../types';
import { fieldValue } from './matching';
import { fieldLabel } from './fields';

/* ------------------------------------------------------------------ */
/* 存储键与常量                                                        */
/* ------------------------------------------------------------------ */

export const WORKSPACE_KEY = 'sologsb-1020-archive-v2';
export const CHECKPOINTS_KEY = 'sologsb-1020-checkpoints-v2';
export const LEASE_KEY = 'sologsb-1020-edit-lease';
export const PENDING_KEY = 'sologsb-1020-pending';
export const ERRORS_KEY = 'sologsb-1020-errors-v2';
export const LEGACY_V1_KEY = 'sologsb-1020-archive-state-v1';
const QUARANTINE_PREFIX = 'sologsb-1020-error-';

export const CHECKPOINT_LIMIT = 20;
export const ERROR_BUNDLE_LIMIT = 5;
export const LEASE_TTL_MS = 20_000;
export const LEASE_RENEW_MS = 8_000;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const nowIso = () => new Date().toISOString();
export const createHolder = () => `页面-${(crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 8)}`;

const recordStatusText: Record<string, string> = {
  unreviewed: '未核对', confirmed: '已确认', rejected: '已忽略', merged: '已合并'
};
const matchStatusText: Record<string, string> = {
  suggested: '待复核', confirmed: '已确认', rejected: '已忽略', merged: '已合并'
};

/* ------------------------------------------------------------------ */
/* 结构校验                                                            */
/* ------------------------------------------------------------------ */

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export function isValidData(value: unknown): value is WorkspaceData {
  if (!isObject(value)) return false;
  const { records, matches, merges, audit } = value as Record<string, unknown>;
  return typeof value.revision === 'number'
    && Array.isArray(records) && records.every((r) => isObject(r) && typeof r.id === 'string' && typeof r.title === 'string')
    && Array.isArray(matches) && matches.every((m) => isObject(m) && typeof m.id === 'string')
    && Array.isArray(merges) && Array.isArray(audit);
}

const isEnvelope = (value: unknown): value is WorkspaceEnvelope =>
  isObject(value) && value.schemaVersion === 2 && typeof value.version === 'number' && isValidData(value.data);

const isCheckpoint = (value: unknown): value is Checkpoint =>
  isObject(value) && typeof value.id === 'string' && typeof value.at === 'string' && isValidData(value.data);

/* ------------------------------------------------------------------ */
/* 错误包与隔离区                                                      */
/* ------------------------------------------------------------------ */

export function loadErrorBundles(storage: StorageLike): ErrorBundle[] {
  const raw = safeGet(storage, ERRORS_KEY);
  if (raw == null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((b) => isObject(b) && typeof b.raw === 'string') as ErrorBundle[] : [];
  } catch {
    return [];
  }
}

function keepBundles(storage: StorageLike, extra: ErrorBundle): ErrorBundle[] {
  const bundles = [extra, ...loadErrorBundles(storage)].slice(0, ERROR_BUNDLE_LIMIT);
  safeSet(storage, ERRORS_KEY, JSON.stringify(bundles));
  return bundles;
}

/** 读取失败时保留原数据：写入隔离区并登记错误包。 */
export function quarantine(
  storage: StorageLike,
  storageKey: string,
  raw: string,
  error: string,
  kind: ErrorBundle['kind'] = 'parse'
): ErrorBundle {
  const bundle: ErrorBundle = { id: crypto.randomUUID?.() ?? `err-${Date.now()}`, at: nowIso(), kind, storageKey, error, raw };
  // 原始数据单独再存一份，错误索引损坏时仍可找回。
  safeSet(storage, `${QUARANTINE_PREFIX}${bundle.id}`, raw);
  keepBundles(storage, bundle);
  return bundle;
}

export function dismissErrorBundle(storage: StorageLike, id: string): ErrorBundle[] {
  const bundles = loadErrorBundles(storage).filter((bundle) => bundle.id !== id);
  safeSet(storage, ERRORS_KEY, JSON.stringify(bundles));
  return bundles;
}

export function downloadJson(filename: string, value: unknown) {
  if (typeof document === 'undefined') return;
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const safeGet = (storage: StorageLike, key: string) => {
  try { return storage.getItem(key); } catch { return null; }
};
const safeSet = (storage: StorageLike, key: string, value: string) => {
  try { storage.setItem(key, value); } catch { /* 配额失败时静默，检查点尽力落盘 */ }
};

/* ------------------------------------------------------------------ */
/* 信封：版本凭据                                                      */
/* ------------------------------------------------------------------ */

export function makeEnvelope(data: WorkspaceData, version: number, holder: string, lastAction: string): WorkspaceEnvelope {
  return { schemaVersion: 2, version, updatedAt: nowIso(), updatedBy: holder, lastAction, data };
}

export interface LoadResult {
  envelope?: WorkspaceEnvelope;
  raw?: string;
  error?: string;
}

export function loadEnvelope(storage: StorageLike): LoadResult {
  const raw = safeGet(storage, WORKSPACE_KEY);
  if (raw == null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isEnvelope(parsed)) return { raw, error: '版本信封结构无效（缺少 schemaVersion / version / data）' };
    return { envelope: parsed, raw };
  } catch (error) {
    return { raw, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface SaveResult {
  ok: boolean;
  envelope?: WorkspaceEnvelope;
  conflict?: ConflictInfo;
}

/**
 * 乐观锁提交：baseVersion 必须等于当前存储版本才允许写入。
 * 版本落后则拦截，并返回对方动作与版本，供页面展示冲突。
 */
export function saveEnvelope(
  storage: StorageLike,
  data: WorkspaceData,
  baseVersion: number,
  holder: string,
  action: string
): SaveResult {
  const current = loadEnvelope(storage);
  if (current.error) {
    const bundle = quarantine(storage, WORKSPACE_KEY, current.raw ?? '', current.error);
    return {
      ok: false,
      conflict: {
        kind: 'unreadable', action, detail: '本地工作区数据无法读取，已隔离原数据',
        baseVersion, currentVersion: baseVersion, pairs: [],
        ...(isValidData(data) ? { local: data } : {})
      }
    };
  }
  if (current.envelope && current.envelope.version !== baseVersion) {
    return {
      ok: false,
      conflict: buildVersionConflict(action, data, baseVersion, current.envelope)
    };
  }
  const envelope = makeEnvelope(data, baseVersion + 1, holder, action);
  safeSet(storage, WORKSPACE_KEY, JSON.stringify(envelope));
  return { ok: true, envelope };
}

/** 直接落盘（仅启动恢复、迁移等无竞争场景使用）。 */
export function replaceEnvelope(storage: StorageLike, envelope: WorkspaceEnvelope) {
  safeSet(storage, WORKSPACE_KEY, JSON.stringify(envelope));
}

/* ------------------------------------------------------------------ */
/* 编辑权租约                                                          */
/* ------------------------------------------------------------------ */

export function getLease(storage: StorageLike): LeaseRecord | null {
  const raw = safeGet(storage, LEASE_KEY);
  if (!raw) return null;
  try {
    const lease = JSON.parse(raw) as LeaseRecord;
    if (!lease || typeof lease.holder !== 'string' || !lease.expiresAt) return null;
    return new Date(lease.expiresAt).getTime() > Date.now() ? lease : null;
  } catch {
    return null;
  }
}

export interface LeaseOutcome {
  ok: boolean;
  lease?: LeaseRecord;
  conflict?: { holder: string; expiresAt: string; action?: string };
}

/** 提交前领取编辑权：其他页面持有有效租约时拒绝。 */
export function acquireLease(storage: StorageLike, holder: string, action = '编辑'): LeaseOutcome {
  const current = getLease(storage);
  if (current && current.holder !== holder) {
    return { ok: false, conflict: { holder: current.holder, expiresAt: current.expiresAt, action: current.action } };
  }
  const lease: LeaseRecord = {
    holder,
    acquiredAt: nowIso(),
    expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
    action
  };
  safeSet(storage, LEASE_KEY, JSON.stringify(lease));
  return { ok: true, lease };
}

/** 续租：只有持权页面或租约过期后才能续上。 */
export function renewLease(storage: StorageLike, holder: string, action?: string): boolean {
  const current = getLease(storage);
  if (current && current.holder !== holder) return false;
  safeSet(storage, LEASE_KEY, JSON.stringify({
    holder,
    acquiredAt: current?.acquiredAt ?? nowIso(),
    expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString(),
    action: action ?? current?.action
  } satisfies LeaseRecord));
  return true;
}

export function releaseLease(storage: StorageLike, holder: string) {
  const current = getLease(storage);
  if (current && current.holder === holder) storage.removeItem(LEASE_KEY);
}

/* ------------------------------------------------------------------ */
/* 检查点与进行中标记                                                  */
/* ------------------------------------------------------------------ */

export function loadCheckpoints(storage: StorageLike): { checkpoints: Checkpoint[]; bundles: ErrorBundle[] } {
  const raw = safeGet(storage, CHECKPOINTS_KEY);
  if (raw == null) return { checkpoints: [], bundles: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('检查点索引不是数组');
    const checkpoints = parsed.filter(isCheckpoint);
    if (checkpoints.length !== parsed.length) throw new Error('部分检查点结构无效');
    return { checkpoints, bundles: [] };
  } catch (error) {
    const bundle = quarantine(storage, CHECKPOINTS_KEY, raw, error instanceof Error ? error.message : String(error));
    return { checkpoints: [], bundles: [bundle] };
  }
}

/** 每批确认、忽略、合并和导入前留下检查点。 */
export function createCheckpoint(
  storage: StorageLike,
  action: string,
  detail: string,
  baseVersion: number,
  data: WorkspaceData,
  pairs: AffectedPair[]
): Checkpoint {
  const checkpoint: Checkpoint = {
    id: crypto.randomUUID?.() ?? `cp-${Date.now()}`,
    at: nowIso(),
    action,
    detail,
    baseVersion,
    data: structuredClone(data),
    pairs
  };
  const { checkpoints } = loadCheckpoints(storage);
  const next = [checkpoint, ...checkpoints].slice(0, CHECKPOINT_LIMIT);
  try {
    safeSet(storage, CHECKPOINTS_KEY, JSON.stringify(next));
  } catch {
    // 配额紧张时只保留最近十条再试一次。
    safeSet(storage, CHECKPOINTS_KEY, JSON.stringify(next.slice(0, 10)));
  }
  return checkpoint;
}

export function writePending(storage: StorageLike, marker: PendingMarker) {
  safeSet(storage, PENDING_KEY, JSON.stringify(marker));
}
export function readPending(storage: StorageLike): PendingMarker | null {
  const raw = safeGet(storage, PENDING_KEY);
  if (!raw) return null;
  try {
    const marker = JSON.parse(raw) as PendingMarker;
    return marker && typeof marker.baseVersion === 'number' ? marker : null;
  } catch {
    return null;
  }
}
export const clearPending = (storage: StorageLike) => storage.removeItem(PENDING_KEY);

/* ------------------------------------------------------------------ */
/* 旧版本地数据迁移                                                    */
/* ------------------------------------------------------------------ */

interface LegacyV1 extends Partial<WorkspaceData> {
  revision?: number;
}

export function migrateV1(raw: string): { data?: WorkspaceData; audit: AuditEntry[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { audit: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (!isObject(parsed) || !Array.isArray(parsed.records) || !Array.isArray(parsed.matches)) {
    return { audit: [], error: 'v1 数据缺少 records / matches 数组' };
  }
  const legacy = parsed as LegacyV1;
  const data: WorkspaceData = {
    revision: typeof legacy.revision === 'number' ? legacy.revision : 1,
    records: legacy.records ?? [],
    matches: legacy.matches ?? [],
    merges: Array.isArray(legacy.merges) ? legacy.merges : [],
    audit: Array.isArray(legacy.audit) ? legacy.audit : []
  };
  if (!isValidData(data)) return { audit: [], error: 'v1 数据结构不完整' };
  const entry: AuditEntry = {
    id: crypto.randomUUID?.() ?? `migrate-${Date.now()}`,
    at: nowIso(),
    action: '迁移旧版本地数据',
    detail: `检测到 v1 本地数据（r${data.revision}），已自动迁移到带版本凭据的 v2 工作区，原数据保留在 ${LEGACY_V1_KEY}`,
    recordIds: []
  };
  return { data, audit: [entry, ...data.audit] };
}

/* ------------------------------------------------------------------ */
/* 启动：迁移 / 崩溃恢复 / 隔离                                        */
/* ------------------------------------------------------------------ */

export function boot(storage: StorageLike, seed: () => WorkspaceData): BootResult {
  const notices: RecoveryNotice[] = [];
  const pushNotice = (notice: Omit<RecoveryNotice, 'id' | 'at' | 'bundles'>, bundles: ErrorBundle[] = []) => {
    notices.push({ id: crypto.randomUUID?.() ?? `notice-${Date.now()}`, at: nowIso(), bundles, ...notice });
  };

  let envelope: WorkspaceEnvelope | null = null;
  let cpLoad = loadCheckpoints(storage);
  if (cpLoad.bundles.length) {
    pushNotice({
      kind: 'quarantine',
      title: '检查点索引损坏',
      detail: `检查点读取失败，原始数据已保留并可导出错误包：${cpLoad.bundles[0].error}`,
      pairs: []
    }, cpLoad.bundles);
  }

  const loaded = loadEnvelope(storage);
  if (loaded.envelope) {
    envelope = loaded.envelope;
  } else if (loaded.error) {
    // 主数据损坏：保留原数据，回退到最近检查点，没有检查点才新建。
    const bundle = quarantine(storage, WORKSPACE_KEY, loaded.raw ?? '', loaded.error);
    const latest = cpLoad.checkpoints[0];
    if (latest) {
      envelope = makeEnvelope(structuredClone(latest.data), latest.baseVersion, '系统恢复', '主数据损坏后回退检查点');
      replaceEnvelope(storage, envelope);
      pushNotice({
        kind: 'checkpoint',
        title: '工作区数据损坏，已回到最近检查点',
        detail: `主数据读取失败（${loaded.error}），已保留原数据并恢复检查点「${latest.action}」。`,
        pairs: latest.pairs
      }, [bundle]);
    } else {
      const data = seed();
      envelope = makeEnvelope(data, data.revision, '系统恢复', '主数据损坏后新建工作区');
      replaceEnvelope(storage, envelope);
      pushNotice({
        kind: 'quarantine',
        title: '工作区数据损坏且没有可用检查点',
        detail: '已保留损坏的原数据并导出错误包，当前为全新工作区。',
        pairs: []
      }, [bundle]);
    }
  } else {
    // 全新启动：尝试自动迁移旧版 v1 数据。
    const legacyRaw = safeGet(storage, LEGACY_V1_KEY);
    if (legacyRaw != null) {
      const migrated = migrateV1(legacyRaw);
      if (migrated.data) {
        const data = { ...migrated.data, audit: migrated.audit };
        envelope = makeEnvelope(data, data.revision, '系统迁移', 'v1 本地数据自动迁移');
        replaceEnvelope(storage, envelope);
        pushNotice({
          kind: 'migrated',
          title: '旧版本地数据已自动迁移',
          detail: `原 v1 数据（r${data.revision}）已迁移到带版本凭据的工作区，原始数据未删除。`,
          pairs: []
        });
      } else {
        const bundle = quarantine(storage, LEGACY_V1_KEY, legacyRaw, migrated.error ?? 'v1 数据无效');
        const data = seed();
        envelope = makeEnvelope(data, data.revision, '系统恢复', 'v1 数据迁移失败后新建工作区');
        replaceEnvelope(storage, envelope);
        pushNotice({
          kind: 'quarantine',
          title: '旧版本地数据读取失败',
          detail: `迁移失败（${migrated.error}），原数据已保留并可导出错误包，当前为全新工作区。`,
          pairs: []
        }, [bundle]);
      }
    } else {
      const data = seed();
      envelope = makeEnvelope(data, data.revision, '系统初始化', '新建工作区');
      replaceEnvelope(storage, envelope);
    }
  }

  // 进行中标记：判断刷新或崩溃发生在保存前还是保存后。
  const pending = readPending(storage);
  if (pending) {
    const finished = envelope.version > pending.baseVersion;
    if (finished) {
      pushNotice({
        kind: 'completed',
        title: '检测到上次操作在保存后中断',
        detail: `「${pending.action}」已保存（r${pending.baseVersion} → r${envelope.version}），无需回退。`,
        pairs: []
      });
    } else {
      const cp = cpLoad.checkpoints.find((item) => item.id === pending.checkpointId) ?? cpLoad.checkpoints[0];
      const fresh = loadEnvelope(storage);
      if (cp && fresh.envelope && fresh.envelope.version === pending.baseVersion) {
        envelope = makeEnvelope(structuredClone(cp.data), cp.baseVersion, '系统恢复', `崩溃后回退：${cp.action}`);
        replaceEnvelope(storage, envelope);
        cpLoad = { checkpoints: cpLoad.checkpoints, bundles: cpLoad.bundles };
        pushNotice({
          kind: 'interrupted',
          title: '刷新或崩溃中断了未完成的操作，已回到最近检查点',
          detail: `操作「${pending.action}」尚未写入，已恢复检查点，以下记录对回到操作前状态。`,
          pairs: cp.pairs
        });
      } else {
        pushNotice({
          kind: 'completed',
          title: '中断操作的版本已被其他页面推进',
          detail: `「${pending.action}」的回退会覆盖其他页面的保存，已保留当前版本 r${fresh.envelope?.version ?? envelope.version}。`,
          pairs: []
        });
      }
    }
    clearPending(storage);
  }

  return { envelope, checkpoints: cpLoad.checkpoints, notices };
}

/* ------------------------------------------------------------------ */
/* 冲突差异：列出被取代的记录对                                        */
/* ------------------------------------------------------------------ */

const findAuditAction = (data: WorkspaceData, id: string): string => {
  const entry = data.audit.find((item) => item.recordIds.includes(id));
  return entry ? `${entry.action} · ${entry.detail}` : '';
};

export function buildVersionConflict(
  action: string,
  local: WorkspaceData,
  baseVersion: number,
  remoteEnvelope: WorkspaceEnvelope
): ConflictInfo {
  const remote = remoteEnvelope.data;
  const pairs: SupersededPair[] = [];
  const localRecords = new Map(local.records.map((record) => [record.id, record]));
  const remoteRecords = new Map(remote.records.map((record) => [record.id, record]));

  localRecords.forEach((lr, id) => {
    const rr = remoteRecords.get(id);
    if (!rr) {
      pairs.push({
        kind: 'record', id, label: lr.title,
        localAction: findAuditAction(local, id) || `本地保留（${recordStatusText[lr.status]}）`,
        remoteAction: findAuditAction(remote, id) || '对方工作区已无此记录（可能被合并取代）'
      });
      return;
    }
    const fields: SupersededPair['fields'] = [];
    (['title', 'date', 'people', 'places', 'identifier', 'medium', 'extent', 'rights', 'notes'] as const).forEach((field) => {
      const lv = fieldValue(lr, field);
      const rv = fieldValue(rr, field);
      if (lv !== rv) fields.push({ field, local: lv, remote: rv });
    });
    if (fields.length || lr.status !== rr.status || lr.updatedAt !== rr.updatedAt) {
      pairs.push({
        kind: 'record', id, label: lr.title,
        localAction: findAuditAction(local, id) || `本地：${recordStatusText[lr.status]}`,
        remoteAction: findAuditAction(remote, id) || `对方：${recordStatusText[rr.status]}`,
        fields
      });
    }
  });
  remoteRecords.forEach((rr, id) => {
    if (!localRecords.has(id)) {
      pairs.push({
        kind: 'record', id, label: rr.title,
        localAction: findAuditAction(local, id) || '本地工作区没有这条记录',
        remoteAction: findAuditAction(remote, id) || `对方新增（${recordStatusText[rr.status]}）`
      });
    }
  });

  const localMatches = new Map(local.matches.map((match) => [match.id, match]));
  const remoteMatches = new Map(remote.matches.map((match) => [match.id, match]));
  localMatches.forEach((lm, id) => {
    const rm = remoteMatches.get(id);
    if (!rm) return;
    if (lm.status !== rm.status) {
      const left = remoteRecords.get(rm.leftId) ?? localRecords.get(rm.leftId);
      const right = remoteRecords.get(rm.rightId) ?? localRecords.get(rm.rightId);
      pairs.push({
        kind: 'match', id,
        label: `${left?.title ?? rm.leftId} ↔ ${right?.title ?? rm.rightId}`,
        localAction: `本地复核为「${matchStatusText[lm.status]}」`,
        remoteAction: `对方复核为「${matchStatusText[rm.status]}」`
      });
    }
  });

  const localMerges = new Set(local.merges.map((merge) => merge.id));
  remote.merges.forEach((merge) => {
    if (!localMerges.has(merge.id)) {
      const left = remoteRecords.get(merge.leftId);
      const right = remoteRecords.get(merge.rightId);
      pairs.push({
        kind: 'merge', id: merge.id,
        label: `${left?.title ?? merge.leftId} ↔ ${right?.title ?? merge.rightId}`,
        localAction: '本地尚未合并',
        remoteAction: '对方已生成合并记录'
      });
    }
  });

  return {
    kind: 'version',
    action,
    detail: `你的版本 r${baseVersion} 已落后，对方在 r${remoteEnvelope.version} 保存了「${remoteEnvelope.lastAction}」`,
    baseVersion,
    currentVersion: remoteEnvelope.version,
    remote,
    local,
    remoteBy: remoteEnvelope.updatedBy,
    remoteAt: remoteEnvelope.updatedAt,
    remoteAction: remoteEnvelope.lastAction,
    pairs
  };
}

/** 租约冲突（对方正持有编辑权）。 */
export function buildLeaseConflict(
  action: string,
  baseVersion: number,
  holder: string,
  expiresAt: string,
  leaseAction?: string
): ConflictInfo {
  return {
    kind: 'lease',
    action,
    detail: `对方页面 ${holder} 正在执行「${leaseAction ?? '编辑'}」，编辑权约在 ${new Date(expiresAt).toLocaleTimeString('zh-CN')} 后释放`,
    baseVersion,
    currentVersion: baseVersion,
    leaseHolder: holder,
    leaseExpiresAt: expiresAt,
    pairs: []
  };
}

export const diffFieldLabel = fieldLabel;
