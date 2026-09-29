import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  AffectedPair, ArchiveRecord, ArchiveState, Checkpoint, ConflictInfo,
  ErrorPackage, FieldKey, LeaseHolder, PersistedSlice
} from './types';
import { fieldValue } from './utils/matching';
import { fieldLabels, matchStatusLabel, newId, parseDate, recordStatusLabel, sourceLabel } from './utils/labels';
import { intentLabel, previewIntent, type WorkspaceIntent } from './utils/intents';
import {
  WorkspaceError, acquireLease, commitIntent, commitSnapshot, currentLeaseHolder,
  downloadErrorPackage, loadWorkspace, readCheckpoints, releaseLease, saveCheckpoint,
  STATE_STORAGE_KEY, writeCommitMarker
} from './utils/workspace';
import { seedSlice, seedState } from './data/seed';

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);

const sliceOf = (state: ArchiveState): PersistedSlice => ({
  revision: state.revision,
  records: state.records,
  matches: state.matches,
  merges: state.merges,
  audit: state.audit
});
const assignSlice = (state: ArchiveState, slice: PersistedSlice) => {
  state.revision = slice.revision;
  state.records = slice.records;
  state.matches = slice.matches;
  state.merges = slice.merges;
  state.audit = slice.audit;
};

const pairTitle = (pair: AffectedPair) =>
  [pair.leftTitle, pair.rightTitle].filter(Boolean).join(' ↔ ') || pair.detail;

interface HistoryEntry {
  snapshot: PersistedSlice;
  affected: AffectedPair[];
}

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const history = useSignal<HistoryEntry[]>([]);
  const future = useSignal<HistoryEntry[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | ArchiveRecord['group']>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const leaseOpen = useSignal(false);
  const conflictOpen = useSignal(false);
  const importGroup = useSignal<ArchiveRecord['group']>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);

  const sessionId = useSignal('');
  const checkpoints = useSignal<Checkpoint[]>([]);
  const conflict = useSignal<ConflictInfo | null>(null);
  const heldBy = useSignal<LeaseHolder | null>(null);
  const pendingIntent = useSignal<WorkspaceIntent | null>(null);
  const pendingAffected = useSignal<AffectedPair[]>([]);
  const pendingUndo = useSignal(false);
  const pendingLabel = useSignal('');
  const recoveryPairs = useSignal<AffectedPair[]>([]);
  const recoveryLabel = useSignal('');
  const errorPkg = useSignal<ErrorPackage | null>(null);
  const migrationNotice = useSignal(false);
  const externalNotice = useSignal('');

  const choices = useStore<Record<FieldKey, ArchiveRecord['group'] | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A',
    medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const notify = (message: string) => {
    if (!message) return;
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3200);
  };

  const pruneSelection = () => {
    const live = new Set(state.matches.map((match) => match.id));
    selectedMatchIds.value = selectedMatchIds.value.filter((id) => live.has(id));
    const active = state.matches.find((match) => match.id === state.activeMatchId);
    if (!active || !recordById(state, active.leftId) || !recordById(state, active.rightId)) {
      state.activeMatchId = '';
    }
  };

  const filteredRecords = useComputed$(() => {
    const term = query.value.trim().toLowerCase();
    return state.records
      .filter((record) => groupFilter.value === 'all' || record.group === groupFilter.value)
      .filter((record) => !term || [record.title, record.date, record.identifier, ...record.people, ...record.places].join(' ').toLowerCase().includes(term))
      .sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title, 'zh-CN'))
      .slice(0, visibleCount.value);
  });

  const filteredMatches = useComputed$(() => state.matches
    .filter((match) => statusFilter.value === 'all' || match.status === statusFilter.value)
    .sort((a, b) => b.score - a.score));
  const visibleMatches = useComputed$(() => filteredMatches.value.slice(0, 120));
  const activeMatch = useComputed$(() =>
    state.matches.find((match) => match.id === state.activeMatchId
      && recordById(state, match.leftId) && recordById(state, match.rightId))
    ?? filteredMatches.value.find((match) => recordById(state, match.leftId) && recordById(state, match.rightId)));
  const conflictScoreCount = useComputed$(() => state.matches.filter((match) => match.status === 'suggested' && match.score < .68).length);

  /**
   * 带版本凭据的提交：
   * 1) 领取编辑权并携带存储中的当时版本；2) 动作前落检查点与进行中标记；
   * 3) 提交时重读版本，落后就拦住写入并给出冲突说明。
   * snapshotTarget 用于撤销 / 重做（直接提交已备快照），其余按意图在最新基准上重放。
   */
  const guardedCommit = $(async (opts: {
    label: string;
    kind: AffectedPair['kind'];
    affected: AffectedPair[];
    intent?: WorkspaceIntent;
    snapshotTarget?: PersistedSlice;
    resultText?: { action: string; detail: string; toast: string };
    isUndo?: boolean;
  }): Promise<'ok' | 'conflict' | 'held' | 'error'> => {
    const storage = localStorage;
    const sid = sessionId.value;

    const leaseResult = acquireLease(storage, sid, `核对页 ${sid.slice(0, 8)}`, opts.label);
    if ('holder' in leaseResult) {
      heldBy.value = leaseResult.holder;
      leaseOpen.value = true;
      notify(`编辑权正被「${leaseResult.holder.sessionLabel}」占用，请稍后重试`);
      return 'held';
    }
    const { base } = leaseResult;

    // 意图在领取到的最新基准上重新预览，避免用本页可能过期的记忆
    let affected = opts.affected;
    if (opts.intent && opts.intent.type !== 'rollback') {
      try {
        affected = previewIntent(base, opts.intent);
      } catch {
        affected = opts.affected;
      }
      if (opts.intent.type === 'review' && !affected.length) {
        releaseLease(storage, sid);
        notify('所选匹配已不存在或已被另一个核对页处理，本批未提交');
        return 'error';
      }
    }

    let point: Checkpoint;
    try {
      // 检查点基于租约携带的存储版本（即对方动作之后、本批动作之前）
      point = saveCheckpoint(storage, base, opts.label, opts.kind, affected);
    } catch (error) {
      releaseLease(storage, sid);
      notify(error instanceof WorkspaceError ? error.message : '检查点写入失败，本次操作已中止');
      return 'error';
    }
    checkpoints.value = readCheckpoints(storage);

    let outcome;
    try {
      writeCommitMarker(storage, point, opts.kind);
      if (opts.snapshotTarget && opts.resultText) {
        outcome = commitSnapshot(
          storage, sid, point, opts.snapshotTarget,
          { action: opts.resultText.action, detail: opts.resultText.detail, affected, toast: opts.resultText.toast },
          affected
        );
      } else if (opts.intent) {
        outcome = commitIntent(storage, sid, point, opts.intent);
      } else {
        releaseLease(storage, sid);
        return 'error';
      }
    } catch (error) {
      releaseLease(storage, sid);
      notify(error instanceof Error ? error.message : '提交失败，工作区保持在检查点状态');
      return 'error';
    }

    if (outcome.heldBy) {
      heldBy.value = outcome.heldBy;
      leaseOpen.value = true;
      notify(`编辑权正被「${outcome.heldBy.sessionLabel}」占用，请稍后重试`);
      return 'held';
    }
    if (outcome.conflict) {
      // 写入已被拦截：本页载入对方最新版本，暂存本批供查看差异后重新领取
      assignSlice(state, outcome.slice);
      pruneSelection();
      conflict.value = outcome.conflict;
      conflictOpen.value = true;
      pendingIntent.value = opts.intent ?? null;
      pendingAffected.value = affected;
      pendingUndo.value = opts.isUndo ?? false;
      pendingLabel.value = opts.label;
      history.value = [];
      future.value = [];
      return 'conflict';
    }

    assignSlice(state, outcome.slice);
    pruneSelection();
    checkpoints.value = readCheckpoints(storage);
    notify(outcome.result.toast);
    return 'ok';
  });

  /** 执行一个批次意图；成功后登记本页撤销线 */
  const runIntent = $(async (intent: WorkspaceIntent, affectedOverride?: AffectedPair[]) => {
    const before = sliceOf(state);
    const result = await guardedCommit({
      label: intentLabel(intent),
      kind: intent.type === 'review' ? 'review' : intent.type === 'merge' ? 'merge' : intent.type === 'import' ? 'import' : 'rollback',
      affected: affectedOverride ?? previewIntent(before, intent),
      intent
    });
    if (result === 'ok') {
      const affected = affectedOverride ?? previewIntent(before, intent);
      history.value = [...history.value.slice(-49), { snapshot: before, affected }];
      future.value = [];
    }
  });

  const updateMatch = $((id: string, status: 'confirmed' | 'rejected') => {
    runIntent({ type: 'review', ids: [id], status });
  });

  const bulkMatch = $((status: 'confirmed' | 'rejected') => {
    const ids = [...selectedMatchIds.value];
    if (!ids.length) return;
    selectedMatchIds.value = [];
    runIntent({ type: 'review', ids, status });
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => { choices[field] = 'A'; });
    mergeOpen.value = true;
  });

  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    const mergeChoices = fieldLabels.reduce((acc, [field]) => {
      acc[field] = choices[field];
      return acc;
    }, {} as Record<FieldKey, ArchiveRecord['group'] | 'combine'>);
    mergeOpen.value = false;
    runIntent({ type: 'merge', matchId: match.id, choices: mergeChoices });
  });

  const parseImport = $(() => {
    const raw = importRaw.value.trim();
    if (!raw) return;
    let rows: Array<Partial<ArchiveRecord>> = [];
    try {
      if (raw.startsWith('[')) rows = JSON.parse(raw) as Array<Partial<ArchiveRecord>>;
      else {
        const lines = raw.split(/\r?\n/).filter(Boolean);
        rows = lines.map((line, index) => {
          const cells = line.split(/\t|\|/).map((cell) => cell.trim());
          return {
            title: cells[0] || `未命名记录 ${index + 1}`,
            date: cells[1] || '',
            people: (cells[2] || '').split(/[，,、]/).filter(Boolean),
            places: (cells[3] || '').split(/[，,、]/).filter(Boolean),
            identifier: cells[4] || '',
            medium: cells[5] || '',
            extent: cells[6] || '',
            rights: cells[7] || '',
            notes: cells[8] || ''
          };
        });
      }
    } catch {
      notify('导入内容格式不正确，请使用 JSON 数组或制表符分隔文本');
      return;
    }
    if (!rows.length) return;
    importOpen.value = false;
    importRaw.value = '';
    importText.value = '';
    runIntent({ type: 'import', group: importGroup.value, rows });
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  const exportAudit = $(() => {
    const blob = new Blob([JSON.stringify({
      exportedAt: new Date().toISOString(),
      session: sessionId.value,
      revision: state.revision,
      records: state.records, matches: state.matches, merges: state.merges, audit: state.audit
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `档案元数据核对结果-r${state.revision}-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  });

  const moveReview = $((delta: number) => {
    const list = filteredMatches.value;
    const index = list.findIndex((match) => match.id === activeMatch.value?.id);
    const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
    if (next) {
      state.activeMatchId = next.id;
      document.querySelector(`[data-match-id="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  const undo = $(async () => {
    const entry = history.value.at(-1);
    if (!entry) return;
    const current = sliceOf(state);
    const result = await guardedCommit({
      label: '撤销上一批',
      kind: 'undo',
      affected: entry.affected,
      snapshotTarget: entry.snapshot,
      resultText: { action: '撤销', detail: '回退到上一批动作之前的工作区状态', toast: '已撤销' },
      isUndo: true
    });
    if (result === 'ok') {
      future.value = [...future.value, { snapshot: current, affected: entry.affected }];
      history.value = history.value.slice(0, -1);
    }
  });

  const redo = $(async () => {
    const entry = future.value.at(-1);
    if (!entry) return;
    const current = sliceOf(state);
    const result = await guardedCommit({
      label: '重做',
      kind: 'undo',
      affected: entry.affected,
      snapshotTarget: entry.snapshot,
      resultText: { action: '重做', detail: '重新应用已撤销的批次', toast: '已重做' },
      isUndo: true
    });
    if (result === 'ok') {
      history.value = [...history.value, { snapshot: current, affected: entry.affected }];
      future.value = future.value.slice(0, -1);
    }
  });

  const rollbackCheckpoint = $((point: Checkpoint) => {
    // 列出回退将取代的后续批次记录对
    const pointTime = new Date(point.at).getTime();
    const superseded = checkpoints.value
      .filter((item) => item.id !== point.id && new Date(item.at).getTime() > pointTime)
      .flatMap((item) => item.affected);
    runIntent({ type: 'rollback', checkpointId: point.id }, superseded.length ? superseded : point.affected);
  });

  const discardPending = $(() => {
    conflictOpen.value = false;
    conflict.value = null;
    pendingIntent.value = null;
    pendingAffected.value = [];
    pendingUndo.value = false;
    notify('已放弃本批，当前为最新版本');
  });

  /** 看差异后重新领取编辑权，本批在最新版本上重放 */
  const reclaimAndRetry = $(async () => {
    const intent = pendingIntent.value;
    const affected = pendingAffected.value;
    const label = pendingLabel.value;
    conflictOpen.value = false;
    conflict.value = null;
    pendingIntent.value = null;
    pendingAffected.value = [];
    pendingUndo.value = false;

    if (!intent) {
      notify('该操作基于旧版本快照，无法跨版本重放，请在新版本上重新操作');
      return;
    }
    const before = sliceOf(state);
    const result = await guardedCommit({
      label: `重新领取 · ${label}`,
      kind: intent.type === 'review' ? 'review' : intent.type === 'merge' ? 'merge' : intent.type === 'import' ? 'import' : 'rollback',
      affected,
      intent
    });
    if (result === 'ok') {
      history.value = [...history.value.slice(-49), { snapshot: before, affected }];
      future.value = [];
    }
  });

  const closeLeaseModal = $(() => { leaseOpen.value = false; });

  // 启动：迁移旧数据 / 崩溃恢复检查点 / 初始化工作区
  useVisibleTask$(() => {
    sessionId.value = newId();
    let loaded;
    try {
      loaded = loadWorkspace(localStorage);
    } catch (error) {
      notify(`工作区读取失败：${(error as Error).message}`);
      loaded = {
        slice: null, checkpoints: [], recoveredFromCheckpoint: false, recoveryPairs: [],
        migratedFromLegacy: false, errorPackage: null, legacyKept: false
      };
    }
    let slice = loaded.slice;
    if (!slice) {
      slice = seedSlice();
      localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(slice));
    }
    assignSlice(state, slice);
    checkpoints.value = loaded.checkpoints;
    state.hydrated = true;
    pruneSelection();
    if (loaded.recoveredFromCheckpoint) {
      recoveryPairs.value = loaded.recoveryPairs;
      recoveryLabel.value = '上次提交在写入前中断';
    }
    if (loaded.errorPackage) {
      errorPkg.value = loaded.errorPackage;
      downloadErrorPackage(loaded.errorPackage);
    }
    migrationNotice.value = loaded.migratedFromLegacy;
  });

  // 其他核对页写入后同步版本；轮询编辑权归属；离开时释放租约
  useVisibleTask$(({ cleanup }) => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STATE_STORAGE_KEY || conflictOpen.value || leaseOpen.value) return;
      try {
        const latest = JSON.parse(event.newValue ?? 'null') as PersistedSlice | null;
        if (latest && latest.revision > state.revision) {
          const prev = state.revision;
          assignSlice(state, latest);
          pruneSelection();
          checkpoints.value = readCheckpoints(localStorage);
          history.value = [];
          future.value = [];
          externalNotice.value = `另一个核对页已提交 r${prev} → r${latest.revision}，本页已同步为最新版本`;
          window.setTimeout(() => { externalNotice.value = ''; }, 5000);
        }
      } catch { /* 数据损坏由下次启动的迁移 / 错误包流程处理 */ }
    };
    window.addEventListener('storage', onStorage);
    const refreshHolder = window.setInterval(() => {
      if (!leaseOpen.value) heldBy.value = currentLeaseHolder(localStorage);
    }, 2500);
    const releaseOnExit = () => releaseLease(localStorage, sessionId.value);
    window.addEventListener('beforeunload', releaseOnExit);
    cleanup(() => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('beforeunload', releaseOnExit);
      window.clearInterval(refreshHolder);
      releaseLease(localStorage, sessionId.value);
    });
  });

  useVisibleTask$(({ cleanup }) => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') { event.preventDefault(); importOpen.value = true; return; }
      if (editing) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); moveReview(1); }
      if (key === 'k') { event.preventDefault(); moveReview(-1); }
      if (event.key === 'Enter' && activeMatch.value) { event.preventDefault(); openMerge(); }
      if (key === 'c' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'confirmed'); }
      if (key === 'r' && activeMatch.value) { event.preventDefault(); updateMatch(activeMatch.value.id, 'rejected'); }
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 3; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat">
          <span class="online-dot" />
          {state.hydrated
            ? `版本 r${state.revision} · 本页 ${sessionId.value.slice(0, 8)}${heldBy.value && heldBy.value.sessionId !== sessionId.value ? ` · 编辑权：${heldBy.value.sessionLabel}` : ' · 编辑权空闲'}`
            : '正在恢复本地工作区'}
        </div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button light" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      {recoveryPairs.value.length > 0 && (
        <div class="banner banner-warn">
          <div class="banner-text">
            <strong>已从最近检查点恢复</strong>
            <span>{recoveryLabel.value}，该批次未完成的写入已撤回，下列记录对保持在动作前状态。</span>
          </div>
          <ul class="banner-pairs">
            {recoveryPairs.value.slice(0, 6).map((pair) => <li>{pairTitle(pair)}<small>{pair.detail}</small></li>)}
          </ul>
          <button class="button small ghost" onClick$={() => { recoveryPairs.value = []; recoveryLabel.value = ''; }}>知道了</button>
        </div>
      )}

      {migrationNotice.value && (
        <div class="banner banner-info">
          <div class="banner-text">
            <strong>旧版本地数据已自动迁移</strong>
            <span>v1 工作区已升级为带版本凭据的 v2 工作区，原始数据已另存备份，未被覆盖或删除。</span>
          </div>
          <button class="button small ghost" onClick$={() => migrationNotice.value = false}>知道了</button>
        </div>
      )}

      {errorPkg.value && (
        <div class="banner banner-danger">
          <div class="banner-text">
            <strong>本地数据读取失败，原数据已原样保留</strong>
            <span>键 {errorPkg.value.key}：{errorPkg.value.message}。损坏原件{errorPkg.value.quarantineKey ? `已隔离到 ${errorPkg.value.quarantineKey}，并` : ''}打包为含原文的错误包开始下载，可据此人工修复。</span>
          </div>
          <button class="button small danger" onClick$={() => downloadErrorPackage(errorPkg.value!)}>重新导出错误包</button>
          <button class="button small ghost" onClick$={() => errorPkg.value = null}>稍后处理</button>
        </div>
      )}

      {externalNotice.value && (
        <div class="banner banner-info">
          <div class="banner-text"><strong>检测到另一个核对页的提交</strong><span>{externalNotice.value}</span></div>
        </div>
      )}

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>提交前领取带版本号的编辑权，每批动作先留检查点；版本落后会被拦截，看清差异后重新领取。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class="danger"><strong>{conflictScoreCount.value}</strong><span>低分可疑项</span></div>
        </div>
      </div>

      <main class="desk-grid">
        <section class="panel match-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">01 / MATCH QUEUE</span><h3>匹配核对队列</h3></div>
            <span class="shortcut-hint">J / K 移动 · Enter 合并</span>
          </div>
          <div class="toolbar-row">
            <select class="input" value={statusFilter.value} onChange$={(event) => { statusFilter.value = (event.target as HTMLSelectElement).value as typeof statusFilter.value; }}>
              <option value="all">全部匹配</option><option value="suggested">待复核</option><option value="confirmed">已确认</option><option value="rejected">已忽略</option>
            </select>
            <button class="button small" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('confirmed')}>批量确认</button>
            <button class="button small ghost" disabled={!selectedMatchIds.value.length} onClick$={() => bulkMatch('rejected')}>批量忽略</button>
          </div>
          <div class="match-list">
            {visibleMatches.value.map((match) => {
              const left = recordById(state, match.leftId);
              const right = recordById(state, match.rightId);
              const isActive = () => state.activeMatchId === match.id;
              return (
                <article
                  data-match-id={match.id}
                  class={`match-card ${isActive() ? 'active' : ''}`}
                  onClick$={() => { state.activeMatchId = match.id; }}
                  tabIndex={0}
                >
                  <div class="match-topline">
                    <Checkbox.Root
                      class="qwik-check"
                      aria-label={`选择匹配 ${match.id}`}
                      initialValue={selectedMatchIds.value.includes(match.id)}
                      onClick$={(event: Event) => {
                        event.stopPropagation();
                        selectedMatchIds.value = selectedMatchIds.value.includes(match.id)
                          ? selectedMatchIds.value.filter((id) => id !== match.id)
                          : [...selectedMatchIds.value, match.id];
                      }}
                    ><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Root>
                    <span class={`score ${match.score < .68 ? 'low' : ''}`}>{Math.round(match.score * 100)}%</span>
                    <span class={`status ${match.status}`}>{matchStatusLabel(match.status)}</span>
                    <span class="record-id">{left?.identifier}</span>
                  </div>
                  <div class="pair-preview">
                    <div><small>A · {left?.group}</small><strong>{left?.title}</strong><span>{parseDate(left?.date ?? '')} · {left?.people.join('、')}</span></div>
                    <i>↔</i>
                    <div><small>B · {right?.group}</small><strong>{right?.title}</strong><span>{parseDate(right?.date ?? '')} · {right?.people.join('、')}</span></div>
                  </div>
                  <div class="reason-line">{match.reasons.join(' · ')}</div>
                </article>
              );
            })}
            {!visibleMatches.value.length && <div class="empty-state">没有符合当前筛选条件的匹配。</div>}
          </div>
        </section>

        <section class="panel records-panel">
          <div class="panel-heading">
            <div><span class="eyebrow">02 / RECORD INDEX</span><h3>档案记录索引</h3></div>
            <span class="shortcut-hint">分页渲染 · 当前 {filteredRecords.value.length} 条</span>
          </div>
          <div class="toolbar-row">
            <input class="input search" placeholder="搜索标题、日期、人物、地点或编号" value={query.value} onInput$={(event) => { query.value = (event.target as HTMLInputElement).value; visibleCount.value = 80; }} />
            <select class="input compact" value={groupFilter.value} onChange$={(event) => { groupFilter.value = (event.target as HTMLSelectElement).value as typeof groupFilter.value; visibleCount.value = 80; }}>
              <option value="all">A + B</option><option value="A">A 组</option><option value="B">B 组</option>
            </select>
          </div>
          <div class="record-table">
            <div class="table-head"><span>来源</span><span>标题</span><span>日期 / 人物 / 地点</span><span>编号</span><span>状态</span></div>
            {filteredRecords.value.map((record) => (
              <div class="table-row" key={record.id}>
                <span class={`group-badge ${record.group.toLowerCase()}`}>{record.group}</span>
                <strong>{record.title}</strong>
                <span>{parseDate(record.date)}<small>{record.people.join('、')} · {record.places.join('、')}</small></span>
                <code>{record.identifier}</code>
                <span class={`record-status ${record.status}`}>{recordStatusLabel(record.status)}</span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list">
              <Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>恢复点</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const left = recordById(state, activeMatch.value!.leftId);
                const right = recordById(state, activeMatch.value!.rightId);
                if (!left || !right) return <div class="empty-state">该匹配的记录已被合并或移除。</div>;
                return <>
                  <div class="active-score"><span>{Math.round(activeMatch.value!.score * 100)}</span><div><strong>综合匹配分</strong><small>{activeMatch.value!.reasons.join(' · ')}</small></div></div>
                  <div class="field-compare compact"><div class="field-label">字段</div><div>A 来源</div><div>B 来源</div>
                    {fieldLabels.map(([field, label]) => <><div class="field-label">{label}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(left, field) || '—'}</div><div class={fieldValue(left, field) !== fieldValue(right, field) ? 'different' : ''}>{fieldValue(right, field) || '—'}</div></>)}
                  </div>
                  <div class="action-stack"><button class="button primary wide" onClick$={openMerge}>逐字段合并</button><div class="split-actions"><button class="button confirm" onClick$={() => updateMatch(activeMatch.value!.id, 'confirmed')}>确认匹配</button><button class="button ghost" onClick$={() => updateMatch(activeMatch.value!.id, 'rejected')}>忽略</button></div></div>
                </>;
              })() : <div class="empty-state">从左侧选择一条匹配查看字段来源。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel">
              {state.merges.length ? state.merges.map((merge) => {
                const left = recordById(state, merge.leftId);
                const right = recordById(state, merge.rightId);
                return <details class="merge-log" key={merge.id}><summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>{sourceLabel(choice ?? 'A')}：{merge.values[field as FieldKey]}</span></li>)}</ul></details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel checkpoint-panel">
              <p class="panel-note">每批确认、忽略、合并和导入前都会留下检查点。刷新或崩溃后自动回到最近检查点，也可以在此手动回退；回退会列出被取代的记录对。</p>
              {checkpoints.value.length ? checkpoints.value.map((point, index) => (
                <div class="checkpoint-row" key={point.id}>
                  <div class="checkpoint-info">
                    <strong>{point.label}</strong>
                    <small>{new Date(point.at).toLocaleString('zh-CN')} · 基准 r{point.baseRevision}{index === 0 ? ' · 最近' : ''}</small>
                    <ul>
                      {point.affected.slice(0, 4).map((pair, pairIndex) => <li key={pairIndex}>{pairTitle(pair)}<small>{pair.detail}</small></li>)}
                      {point.affected.length > 4 && <li>另 {point.affected.length - 4} 对…</li>}
                    </ul>
                  </div>
                  {index > 0 && <button class="button small ghost" onClick$={() => rollbackCheckpoint(point)}>回到此点</button>}
                </div>
              )) : <div class="empty-state">还没有检查点。执行第一批复核后出现。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做（同样经过版本闸门）</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}{typeof entry.rev === 'number' ? ` · r${entry.rev}` : ''}</strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>版本与保护规则</h3></div></div>
          <div class="rule-row"><span>1</span><p>提交前领取编辑权并携带当时版本号；存储版本已被别的核对页推进时写入被拦截，绝不盖写对方复核。</p></div>
          <div class="rule-row"><span>2</span><p>冲突面板列出对方动作、版本与字段级差异；看清差异后重新领取编辑权，本批在新版本上重放。</p></div>
          <div class="rule-row"><span>3</span><p>每批确认、忽略、合并、导入和回退前先落检查点；刷新或崩溃后自动回到最近检查点，并列出被取代的记录对。</p></div>
          <div class="rule-row"><span>4</span><p>旧版本地数据自动迁移；读取失败时保留原数据并导出错误包，不删除、不覆盖原件。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      {/* 编辑权被占用 */}
      <Modal.Root bind:show={leaseOpen} closeOnBackdropClick={false}>
        <Modal.Panel class="modal-panel conflict-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">EDIT LEASE</span><Modal.Title>编辑权暂被占用</Modal.Title></div></Modal.Header>
          {heldBy.value && <Modal.Description class="modal-description">
            「{heldBy.value.sessionLabel}」正在执行「{heldBy.value.action}」（领取于 {new Date(heldBy.value.acquiredAt).toLocaleTimeString('zh-CN')}）。
            编辑权 10 秒无提交自动过期，稍后重试即可。
          </Modal.Description>}
          <Modal.Footer class="modal-footer"><button class="button primary" onClick$={closeLeaseModal}>稍后再试</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      {/* 版本冲突 */}
      <Modal.Root bind:show={conflictOpen} closeOnBackdropClick={false}>
        <Modal.Panel class="modal-panel conflict-modal conflict-wide">
          {conflict.value && (() => {
            const info = conflict.value!;
            return <>
              <Modal.Header class="modal-header">
                <div><span class="eyebrow">VERSION CONFLICT · 领取时 r{info.baseRevision} · 尝试写入 r{info.triedRevision} · 最新 r{info.latestRevision}</span><Modal.Title>写入已被拦截：工作区版本落后</Modal.Title></div>
              </Modal.Header>
              <Modal.Description class="modal-description">
                你的「{info.label}」基于 r{info.baseRevision} 领取编辑权，但工作区已被推进到 r{info.latestRevision}。
                本次写入没有发生，对方的复核未被覆盖。请先查看差异，再决定重新领取或放弃。
              </Modal.Description>
              <div class="conflict-body">
                <section>
                  <h4>对方在此期间的动作</h4>
                  {info.incomingActions.length ? <ul class="conflict-actions">
                    {info.incomingActions.slice(0, 8).map((entry) => <li key={entry.id}>
                      <strong>{entry.action}{typeof entry.rev === 'number' ? ` · r${entry.rev}` : ''}</strong>
                      <span>{entry.detail}</span>
                      <time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                    </li>)}
                  </ul> : <p class="muted-line">没有检测到带版本号的新动作（可能来自旧版本页面）。</p>}
                </section>
                <section>
                  <h4>记录差异（{info.recordChanges.length} 项{info.mergeAdded ? `，含 ${info.mergeAdded} 次新合并` : ''}）</h4>
                  <div class="conflict-diff">
                    {info.recordChanges.slice(0, 12).map((change) => <div class="diff-record" key={change.id}>
                      <div class="diff-title">
                        <span class={`diff-tag ${change.change}`}>{change.change === 'added' ? '新增' : change.change === 'removed' ? '删除' : '修改'}</span>
                        <strong>{change.title}</strong>
                        {change.change === 'modified' && change.statusBefore !== change.statusAfter && (
                          <small>{recordStatusLabel(change.statusBefore ?? '')} → {recordStatusLabel(change.statusAfter ?? '')}</small>
                        )}
                      </div>
                      {change.fields.slice(0, 5).map((field) => <div class="diff-field" key={field.field}>
                        <b>{field.label}</b>
                        <span class="diff-old">{field.before || '—'}</span>
                        <i>→</i>
                        <span class="diff-new">{field.after || '—'}</span>
                      </div>)}
                    </div>)}
                    {!info.recordChanges.length && <p class="muted-line">记录内容无字段级差异。</p>}
                  </div>
                </section>
                <section>
                  <h4>匹配状态差异（{info.matchChanges.length} 项）</h4>
                  {info.matchChanges.length ? <ul class="conflict-matches">
                    {info.matchChanges.slice(0, 10).map((change) => <li key={change.id}>
                      <strong>{change.leftTitle} ↔ {change.rightTitle}</strong>
                      <span class={`diff-tag ${change.change}`}>{change.change === 'added' ? '新增候选' : change.change === 'removed' ? '候选消失' : '状态变化'}</span>
                      {change.before && change.after && <small>{matchStatusLabel(change.before)} → {matchStatusLabel(change.after)}</small>}
                    </li>)}
                  </ul> : <p class="muted-line">匹配列表无差异。</p>}
                </section>
                <section>
                  <h4>本批被拦下、尚未生效的记录对</h4>
                  <ul class="conflict-matches">
                    {info.affected.slice(0, 8).map((pair, index) => <li key={index}><strong>{pairTitle(pair)}</strong><small>{pair.detail}</small></li>)}
                  </ul>
                </section>
              </div>
              <Modal.Footer class="modal-footer">
                <button class="button ghost" onClick$={discardPending}>放弃本批（保留对方版本）</button>
                {pendingUndo.value
                  ? <span class="lease-hint">撤销 / 重做基于旧快照，请在新版本上重新操作</span>
                  : <button class="button primary" onClick$={reclaimAndRetry}>看过差异，重新领取并重放本批</button>}
              </Modal.Footer>
            </>;
          })()}
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">导入前会自动留下检查点，并领取带当前版本号的编辑权；与另一个核对页冲突时会被拦截。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。</Modal.Description>
          <div class="import-controls">
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'A'} onChange$={() => importGroup.value = 'A'} /><span><strong>A 组</strong><small>口述史 / 主要记录</small></span></label>
            <label class="radio-card"><input type="radio" checked={importGroup.value === 'B'} onChange$={() => importGroup.value = 'B'} /><span><strong>B 组</strong><small>手稿 / 待合并记录</small></span></label>
            <label class="file-button">选择文件<input type="file" accept=".json,.txt,.csv,.tsv" onChange$={(event, element) => importFile(event, element)} /></label>
          </div>
          <textarea class="modal-textarea" value={importRaw.value} onInput$={(event) => importRaw.value = (event.target as HTMLTextAreaElement).value} placeholder="李秀珍口述史访谈 | 2019-04-12 | 李秀珍、周明远 | 临河县 | OH-LXZ-2019-01 | 数字录音 | 02:14:38 | 研究者授权 | ..." />
          {importText.value && <div class="file-name">已读取：{importText.value}</div>}
          <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" disabled={!importRaw.value.trim()} onClick$={parseImport}>导入并重新匹配</button></Modal.Footer>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={mergeOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel merge-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">FIELD MERGE</span><Modal.Title>逐字段选择保留来源</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          {activeMatch.value && (() => {
            const left = recordById(state, activeMatch.value!.leftId);
            const right = recordById(state, activeMatch.value!.rightId);
            if (!left || !right) return <Modal.Description class="modal-description">该匹配的记录已不存在。</Modal.Description>;
            return <>
              <Modal.Description class="modal-description">合并提交前会先写检查点并校验版本；若对方已改动这对记录，合并会被拦下并展示差异。</Modal.Description>
              <div class="field-picker-head"><span>字段</span><span>A 组来源</span><span>B 组来源</span></div>
              <div class="field-picker">
                {fieldLabels.map(([field, label]) => {
                  const leftValue = fieldValue(left, field) || '—';
                  const rightValue = fieldValue(right, field) || '—';
                  const same = leftValue === rightValue;
                  return <div class={`field-picker-row ${same ? 'same' : 'conflict'}`} key={field}><div class="picker-label"><strong>{label}</strong>{same ? <small>一致</small> : <small>冲突</small>}</div><label class={`source-option ${choices[field] === 'A' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'A'} onChange$={() => choices[field] = 'A'} /><span><b>A</b>{leftValue}</span></label><label class={`source-option ${choices[field] === 'B' ? 'selected' : ''}`}><input type="radio" name={`field-${field}`} checked={choices[field] === 'B'} onChange$={() => choices[field] = 'B'} /><span><b>B</b>{rightValue}</span></label><button class={`combine-button ${choices[field] === 'combine' ? 'selected' : ''}`} onClick$={() => choices[field] = 'combine'} title="拼接两侧内容">拼接</button></div>;
                })}
              </div>
              <Modal.Footer class="modal-footer"><Modal.Close class="button ghost">取消</Modal.Close><button class="button primary" onClick$={mergeCurrent}>生成合并记录</button></Modal.Footer>
            </>;
          })}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
