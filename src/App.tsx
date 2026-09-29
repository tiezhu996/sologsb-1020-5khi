import {
  $, component$, useComputed$, useSignal, useStore, useVisibleTask$
} from '@builder.io/qwik';
import { Checkbox, Modal, Tabs } from '@qwik-ui/headless';
import type {
  AffectedPair, ArchiveRecord, ArchiveState, Checkpoint, ConflictInfo,
  FieldKey, MatchCandidate, PendingMarker, RecoveryNotice, RecordGroup, WorkspaceData
} from './types';
import { computeMatches, fieldValue } from './utils/matching';
import { fieldLabels } from './utils/fields';
import { seedState } from './data/seed';
import {
  acquireLease, boot, buildLeaseConflict, buildVersionConflict, clearPending, createCheckpoint,
  downloadJson, loadCheckpoints, loadEnvelope, loadErrorBundles,
  releaseLease, saveEnvelope, writePending, createHolder, nowIso, type StorageLike
} from './utils/workspace';

const parseDate = (value: string) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split('-').reverse().join('/');
  if (/^\d{4}$/.test(value)) return `${value}年`;
  return value || '未知';
};

const recordById = (state: ArchiveState, id: string) => state.records.find((record) => record.id === id);
const matchLabel = (state: ArchiveState, match: MatchCandidate) => {
  const left = recordById(state, match.leftId);
  const right = recordById(state, match.rightId);
  return `${left?.title ?? '未知记录'} ↔ ${right?.title ?? '未知记录'}`;
};
const pairText = (state: ArchiveState, pair: AffectedPair) =>
  `${pair.leftTitle ?? recordById(state, pair.leftId)?.title ?? pair.leftId} ↔ ${pair.rightTitle ?? recordById(state, pair.rightId)?.title ?? pair.rightId}`;
const conflictKindLabel: Record<string, string> = { record: '记录', match: '匹配', merge: '合并' };

export default component$(() => {
  const state = useStore<ArchiveState>(seedState());
  const history = useSignal<string[]>([]);
  const future = useSignal<string[]>([]);
  const query = useSignal('');
  const groupFilter = useSignal<'all' | RecordGroup>('all');
  const statusFilter = useSignal<'all' | 'suggested' | 'confirmed' | 'rejected'>('all');
  const visibleCount = useSignal(80);
  const selectedMatchIds = useSignal<string[]>([]);
  const importOpen = useSignal(false);
  const mergeOpen = useSignal(false);
  const checkpointOpen = useSignal(false);
  const conflictOpen = useSignal(false);
  const importGroup = useSignal<RecordGroup>('A');
  const importRaw = useSignal('');
  const importText = useSignal('');
  const toast = useSignal('');
  const panelTab = useSignal(0);

  // 版本凭据与多页面协作
  const holder = useSignal('');
  const baseVersion = useSignal(1);
  const checkpoints = useSignal<Checkpoint[]>([]);
  const conflict = useSignal<ConflictInfo | null>(null);
  const notices = useSignal<RecoveryNotice[]>([]);
  const remoteAhead = useSignal<{ version: number; action: string; by: string } | null>(null);
  const remotePending = useSignal<string>('');

  const snapshot = () => JSON.stringify({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit
  });
  const snapshotData = (): WorkspaceData => ({
    revision: state.revision,
    records: state.records,
    matches: state.matches,
    merges: state.merges,
    audit: state.audit
  });

  const restore = (raw: string) => {
    const next = JSON.parse(raw) as Partial<ArchiveState>;
    state.revision = next.revision ?? state.revision;
    state.records = next.records ?? state.records;
    state.matches = next.matches ?? state.matches;
    state.merges = next.merges ?? state.merges;
    state.audit = next.audit ?? state.audit;
  };

  const notify = (message: string) => {
    toast.value = message;
    window.setTimeout(() => { if (toast.value === message) toast.value = ''; }, 3200);
  };

  const showConflict = (info: ConflictInfo) => {
    conflict.value = info;
    conflictOpen.value = true;
  };

  const commit = (action: string, detail: string, recordIds: string[] = []) => {
    state.revision += 1;
    state.audit.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), action, detail, recordIds });
    state.audit = state.audit.slice(0, 300);
  };

  /**
   * 受版本保护的提交流程：
   * 1. 提交前领取编辑权（其他页面正在保存则拦截）
   * 2. 记录撤销快照，并在提交前落盘检查点与进行中标记
   * 3. 执行本地修改；写入时携带当时版本做乐观锁校验
   * 4. 版本落后则拦住写入、回滚本地改动，交由冲突弹窗指出对方动作与差异
   */
  const runGuarded = (
    action: string,
    detail: string,
    pairs: AffectedPair[],
    mutate: () => void,
    options: { manageHistory?: boolean } = {}
  ): boolean => {
    const storage: StorageLike = localStorage;
    if (!state.hydrated || !holder.value) { notify('工作区仍在恢复，请稍候再操作'); return false; }

    const lease = acquireLease(storage, holder.value, action);
    if (!lease.ok || !lease.lease) {
      const c = lease.conflict!;
      showConflict(buildLeaseConflict(action, baseVersion.value, c.holder, c.expiresAt, c.action));
      return false;
    }

    const before = snapshot();
    let pushedHistory = false;
    if (!options.manageHistory) {
      history.value = [...history.value.slice(-49), before];
      pushedHistory = true;
    }

    let checkpointId = '';
    try {
      const cp = createCheckpoint(storage, action, detail, baseVersion.value, JSON.parse(before) as WorkspaceData, pairs);
      checkpointId = cp.id;
      checkpoints.value = [cp, ...checkpoints.value].slice(0, 20);
    } catch {
      // 检查点落盘失败不应阻止正常提交，进行中标记会记录无检查点的情况。
    }
    writePending(storage, {
      startedAt: nowIso(), action, detail, baseVersion: baseVersion.value, checkpointId, holder: holder.value
    });

    try {
      mutate();
    } catch (error) {
      restore(before);
      clearPending(storage);
      releaseLease(storage, holder.value);
      notify(`操作未完成，已回到操作前状态：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }

    const result = saveEnvelope(storage, snapshotData(), baseVersion.value, holder.value, action);
    clearPending(storage);
    releaseLease(storage, holder.value);

    if (!result.ok || !result.envelope) {
      // 版本落后：写入被拦截，本地改动回滚，等待用户看完差异重新领取。
      restore(before);
      if (pushedHistory) history.value = history.value.slice(0, -1);
      if (result.conflict) showConflict(result.conflict);
      checkpoints.value = loadCheckpoints(storage).checkpoints;
      notify('版本落后，写入已拦截，请查看冲突差异');
      return false;
    }

    baseVersion.value = result.envelope.version;
    state.revision = result.envelope.version;
    if (pushedHistory) future.value = [];
    remoteAhead.value = null;
    remotePending.value = '';
    checkpoints.value = loadCheckpoints(storage).checkpoints;
    return true;
  };

  const undo = $(() => {
    const raw = history.value.at(-1);
    if (!raw) return;
    const previousAction = state.audit[0]?.action ?? '上一步';
    const current = snapshot();
    const ok = runGuarded('撤销操作', `撤销：${previousAction}`, [], () => restore(raw), { manageHistory: true });
    if (ok) {
      history.value = history.value.slice(0, -1);
      future.value = [...future.value, current];
      notify(`已撤销：${previousAction}`);
    }
  });

  const redo = $(() => {
    const raw = future.value.at(-1);
    if (!raw) return;
    const nextAction = (JSON.parse(raw) as Partial<ArchiveState>).audit?.[0]?.action ?? '下一步';
    const current = snapshot();
    const ok = runGuarded('重做操作', `重做：${nextAction}`, [], () => restore(raw), { manageHistory: true });
    if (ok) {
      future.value = future.value.slice(0, -1);
      history.value = [...history.value, current];
      notify(`已重做：${nextAction}`);
    }
  });

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
  const activeMatch = useComputed$(() => state.matches.find((match) => match.id === state.activeMatchId) ?? filteredMatches.value[0]);
  const conflictCount = useComputed$(() => state.matches.filter((match) => match.status === 'suggested' && match.score < .68).length);

  const matchPairs = (ids: string[], reason: string): AffectedPair[] => ids.flatMap((id) => {
    const match = state.matches.find((item) => item.id === id);
    if (!match) return [];
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    return [{ leftId: match.leftId, rightId: match.rightId, leftTitle: left?.title, rightTitle: right?.title, reason }];
  });

  const updateMatch = $((id: string, status: MatchCandidate['status']) => {
    const match = state.matches.find((item) => item.id === id);
    if (!match) return;
    const confirming = status === 'confirmed';
    const action = confirming ? '确认匹配' : '忽略可疑匹配';
    const detail = matchLabel(state, match);
    const ok = runGuarded(action, detail, matchPairs([id], action), () => {
      match.status = status;
      match.reviewedAt = new Date().toISOString();
      state.records.forEach((record) => {
        if ((record.id === match.leftId || record.id === match.rightId) && confirming) record.status = 'confirmed';
      });
      commit(action, detail, [match.leftId, match.rightId]);
    });
    if (ok) notify(confirming ? '已确认此项匹配' : '已忽略此项匹配');
  });

  const bulkMatch = $((status: MatchCandidate['status']) => {
    const ids = selectedMatchIds.value;
    if (!ids.length) return;
    const action = '批量复核';
    const detail = `${ids.length} 条匹配被标记为${status === 'confirmed' ? '确认' : '忽略'}`;
    const recordIds = ids.flatMap((id) => {
      const match = state.matches.find((item) => item.id === id);
      return match ? [match.leftId, match.rightId] : [];
    });
    const ok = runGuarded(action, detail, matchPairs(ids, status === 'confirmed' ? '批量确认' : '批量忽略'), () => {
      ids.forEach((id) => {
        const match = state.matches.find((item) => item.id === id);
        if (!match) return;
        match.status = status;
        match.reviewedAt = new Date().toISOString();
      });
      commit(action, detail, recordIds);
    });
    if (ok) {
      selectedMatchIds.value = [];
      notify(`已批量处理 ${ids.length} 条匹配`);
    }
  });

  const openMerge = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    state.activeMatchId = match.id;
    fieldLabels.forEach(([field]) => {
      const left = recordById(state, match.leftId);
      const right = recordById(state, match.rightId);
      if (left && right && fieldValue(left, field) === fieldValue(right, field)) choices[field] = 'A';
      else choices[field] = 'A';
    });
    mergeOpen.value = true;
  });

  const choices = useStore<Record<FieldKey, RecordGroup | 'combine'>>({
    title: 'A', date: 'A', people: 'A', places: 'A', identifier: 'A', medium: 'A', extent: 'A', rights: 'A', notes: 'A'
  });

  const mergeCurrent = $(() => {
    const match = activeMatch.value;
    if (!match) return;
    const left = recordById(state, match.leftId);
    const right = recordById(state, match.rightId);
    if (!left || !right) return;
    const action = '合并两条记录';
    const detail = `保留 ${Object.values(choices).filter((choice) => choice === 'A').length} 个 A 来源字段、${Object.values(choices).filter((choice) => choice === 'B').length} 个 B 来源字段`;
    const pairs: AffectedPair[] = [{
      leftId: left.id, rightId: right.id, leftTitle: left.title, rightTitle: right.title, reason: '合并为一条新记录'
    }];
    const ok = runGuarded(action, detail, pairs, () => {
      const values: Partial<Record<FieldKey, string>> = {};
      fieldLabels.forEach(([field]) => {
        const source = choices[field];
        const pick = source === 'combine' ? `${fieldValue(left, field)}；${fieldValue(right, field)}` : fieldValue(source === 'A' ? left : right, field);
        values[field] = pick;
      });
      const merged: ArchiveRecord = {
        ...left,
        ...values,
        people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
        places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
        status: 'merged',
        updatedAt: new Date().toISOString()
      };
      state.records = [...state.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
      state.matches.forEach((item) => {
        if (item.id === match.id) item.status = 'merged';
        else if (item.leftId === left.id || item.rightId === right.id || item.leftId === right.id || item.rightId === left.id) item.status = 'rejected';
      });
      state.merges.unshift({
        id: crypto.randomUUID(),
        matchId: match.id,
        leftId: left.id,
        rightId: right.id,
        chosen: { ...choices },
        values,
        mergedAt: new Date().toISOString()
      });
      commit(action, detail, [left.id, right.id, merged.id]);
    });
    if (ok) {
      mergeOpen.value = false;
      notify('记录已合并，来源与字段选择已写入审计记录');
    }
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
    const group = importGroup.value;
    const action = '导入档案记录';
    const detail = `从 ${group} 组导入 ${rows.length} 条记录`;
    const prepared = rows.map((row) => ({
      id: crypto.randomUUID(),
      group,
      title: row.title || '未命名记录',
      date: row.date || '',
      people: Array.isArray(row.people) ? row.people : String(row.people || '').split(/[，,、]/).filter(Boolean),
      places: Array.isArray(row.places) ? row.places : String(row.places || '').split(/[，,、]/).filter(Boolean),
      identifier: row.identifier || '',
      medium: row.medium || '',
      extent: row.extent || '',
      rights: row.rights || '',
      notes: row.notes || '',
      updatedAt: new Date().toISOString(),
      status: 'unreviewed' as const
    }));
    const ok = runGuarded(action, detail, [], () => {
      state.records.push(...prepared);
      // 重新匹配时保留既有复核结论，后导入的批次不会盖掉先前的确认/忽略。
      state.matches = computeMatches(state.records, state.matches);
      commit(action, detail, []);
    });
    if (ok) {
      importRaw.value = '';
      importText.value = '';
      importOpen.value = false;
      notify(`已导入 ${rows.length} 条记录并重新匹配`);
    }
  });

  const importFile = $(async (_event: Event, element: HTMLInputElement) => {
    const file = element.files?.[0];
    if (!file) return;
    importRaw.value = await file.text();
    importText.value = file.name;
  });

  const exportAudit = $(() => {
    downloadJson(`档案元数据核对结果-${new Date().toISOString().slice(0, 10)}.json`, {
      exportedAt: new Date().toISOString(),
      version: baseVersion.value,
      records: state.records,
      matches: state.matches,
      merges: state.merges,
      audit: state.audit,
      checkpoints: checkpoints.value.map((cp) => ({ id: cp.id, at: cp.at, action: cp.action, detail: cp.detail, baseVersion: cp.baseVersion, pairs: cp.pairs }))
    });
  });

  const exportBundles = $(() => {
    downloadJson(`核对台错误包-${new Date().toISOString().slice(0, 10)}.json`, {
      exportedAt: new Date().toISOString(),
      note: '读取失败时保留的原始数据与错误信息',
      bundles: loadErrorBundles(localStorage)
    });
  });

  const dismissNotice = $((id: string) => {
    notices.value = notices.value.filter((notice) => notice.id !== id);
  });

  const restoreCheckpoint = $((cp: Checkpoint) => {
    const raw = JSON.stringify(cp.data);
    const detail = `回到检查点「${cp.action}」（${new Date(cp.at).toLocaleString('zh-CN')}）`;
    const ok = runGuarded('恢复检查点', detail, cp.pairs, () => restore(raw));
    if (ok) {
      checkpointOpen.value = false;
      selectedMatchIds.value = [];
      notify('已回到所选检查点，原版本仍保留在检查点列表中');
    }
  });

  /** 看完差异后重新领取：载入对方最新版本，放弃本地被拦截的改动，再在新版本上重做。 */
  const resync = $(() => {
    const storage: StorageLike = localStorage;
    const loaded = loadEnvelope(storage);
    if (!loaded.envelope) {
      notify('本地工作区暂时无法读取，请先导出错误包');
      return;
    }
    const env = loaded.envelope;
    const lease = acquireLease(storage, holder.value, '重新领取编辑权');
    if (!lease.ok) {
      notify(`对方仍在保存（${lease.conflict?.holder}），请稍后再试`);
      return;
    }
    if (conflict.value?.kind === 'lease') {
      releaseLease(storage, holder.value);
      conflict.value = null;
      notify('已重新领取编辑权，可以重试刚才的操作');
      return;
    }
    history.value = [...history.value.slice(-49), snapshot()];
    future.value = [];
    restore(JSON.stringify(env.data));
    commit('重新领取编辑权并同步', `载入对方 r${env.version}（${env.lastAction}）的差异内容，请在此版本上重做操作`, []);
    const result = saveEnvelope(storage, snapshotData(), env.version, holder.value, '重新领取编辑权并同步');
    releaseLease(storage, holder.value);
    if (!result.ok || !result.envelope) {
      if (result.conflict) conflict.value = result.conflict;
      notify('对方又提交了新版本，请再次查看差异');
      return;
    }
    baseVersion.value = result.envelope.version;
    state.revision = result.envelope.version;
    remoteAhead.value = null;
    conflict.value = null;
    checkpoints.value = loadCheckpoints(storage).checkpoints;
    notify(`已同步到 r${result.envelope.version}，请按差异重做被拦截的操作`);
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

  /* 启动：迁移旧版数据 / 崩溃恢复 / 载入版本信封。 */
  useVisibleTask$(() => {
    holder.value = createHolder();
    const result = boot(localStorage, () => {
      const seeded = seedState();
      return {
        revision: seeded.revision,
        records: seeded.records,
        matches: seeded.matches,
        merges: seeded.merges,
        audit: seeded.audit
      };
    });
    restore(JSON.stringify(result.envelope.data));
    baseVersion.value = result.envelope.version;
    state.revision = result.envelope.version;
    checkpoints.value = result.checkpoints;
    notices.value = result.notices;
    state.hydrated = true;

    const onStorage = (event: StorageEvent) => {
      if (event.key === 'sologsb-1020-archive-v2') {
        const loaded = loadEnvelope(localStorage);
        if (loaded.envelope && loaded.envelope.version > baseVersion.value) {
          remoteAhead.value = { version: loaded.envelope.version, action: loaded.envelope.lastAction, by: loaded.envelope.updatedBy };
        }
      }
      if (event.key === 'sologsb-1020-pending') {
        if (event.newValue) {
          try {
            const marker = JSON.parse(event.newValue) as PendingMarker;
            if (marker.holder !== holder.value) remotePending.value = marker.action;
          } catch { /* 忽略损坏的进行中标记 */ }
        } else {
          remotePending.value = '';
        }
      }
    };
    window.addEventListener('storage', onStorage);
    const release = () => { if (holder.value) releaseLease(localStorage, holder.value); };
    window.addEventListener('pagehide', release);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pagehide', release);
    };
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
      if (key === '?' || (event.shiftKey && event.key === '/')) { event.preventDefault(); panelTab.value = 2; }
    };
    window.addEventListener('keydown', handler);
    cleanup(() => window.removeEventListener('keydown', handler));
  });

  const noticeTone = (kind: RecoveryNotice['kind']) =>
    kind === 'quarantine' ? 'danger' : kind === 'interrupted' || kind === 'checkpoint' ? 'warn' : 'info';

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-seal">档</div>
          <div><h1>档案元数据核对台</h1><p>ARCHIVE RECONCILIATION DESK</p></div>
        </div>
        <div class="top-stat">
          <span class="online-dot" />
          {state.hydrated ? `离线保存 · 版本 r${baseVersion.value}` : '正在恢复本地工作区'}
          {remotePending.value && <span class="lease-tag">对方正在{remotePending.value}…</span>}
          {remoteAhead.value && (
            <button class="lease-tag clash" onClick$={() => {
              const ahead = remoteAhead.value;
              if (!ahead) return;
              const loaded = loadEnvelope(localStorage);
              if (loaded.envelope) {
                const built = buildVersionConflict('同步对方已保存的版本', snapshotData(), baseVersion.value, loaded.envelope);
                showConflict({ ...built, kind: 'remote', action: '检测到其他页面的新版本' });
              }
            }}>对方已保存 r{remoteAhead.value.version} · 查看</button>
          )}
        </div>
        <div class="top-actions">
          <button class="icon-button" disabled={!history.value.length} onClick$={undo}>撤销</button>
          <button class="icon-button" disabled={!future.value.length} onClick$={redo}>重做</button>
          <button class="icon-button" onClick$={() => checkpointOpen.value = true}>检查点</button>
          <button class="button ghost" onClick$={() => importOpen.value = true}>导入两组记录</button>
          <button class="button light" onClick$={exportAudit}>导出核对包</button>
        </div>
      </header>

      {notices.value.length > 0 && (
        <div class="notice-stack">
          {notices.value.map((notice) => (
            <div class={`notice-banner ${noticeTone(notice.kind)}`} key={notice.id}>
              <div class="notice-body">
                <strong>{notice.title}</strong>
                <p>{notice.detail}</p>
                {notice.pairs && notice.pairs.length > 0 && (
                  <ul class="notice-pairs">
                    {notice.pairs.slice(0, 6).map((pair, index) => (
                      <li key={`${pair.leftId}-${pair.rightId}-${index}`}>{pairText(state, pair)}<span>{pair.reason}</span></li>
                    ))}
                    {notice.pairs.length > 6 && <li>…另有 {notice.pairs.length - 6} 对记录</li>}
                  </ul>
                )}
              </div>
              <div class="notice-actions">
                {notice.bundles.map((bundle) => (
                  <button class="button small danger" key={bundle.id} onClick$={exportBundles}>导出错误包</button>
                ))}
                <button class="button small ghost" onClick$={() => dismissNotice(notice.id)}>知道了</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div class="overview">
        <div><span class="eyebrow">RECONCILIATION PROJECT</span><h2>口述史与手稿元数据比对</h2><p>逐条确认可疑匹配，保留每个字段的来源选择，并留下可追溯的处理记录。</p></div>
        <div class="metrics">
          <div><strong>{state.records.filter((record) => record.group === 'A').length}</strong><span>A 组记录</span></div>
          <div><strong>{state.records.filter((record) => record.group === 'B').length}</strong><span>B 组记录</span></div>
          <div><strong>{state.matches.filter((match) => match.status === 'suggested').length}</strong><span>待复核匹配</span></div>
          <div class="danger"><strong>{conflictCount.value}</strong><span>低分可疑项</span></div>
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
                    <span class={`status ${match.status}`}>{match.status === 'suggested' ? '待复核' : match.status === 'confirmed' ? '已确认' : match.status === 'rejected' ? '已忽略' : '已合并'}</span>
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
                <span class={`record-status ${record.status}`}>{record.status === 'unreviewed' ? '未核对' : record.status === 'confirmed' ? '已确认' : record.status === 'rejected' ? '已忽略' : '已合并'}</span>
              </div>
            ))}
          </div>
          {filteredRecords.value.length >= visibleCount.value && <button class="load-more" onClick$={() => visibleCount.value += 80}>加载下 80 条记录</button>}
        </section>

        <section class="panel review-panel">
          <Tabs.Root bind:selectedIndex={panelTab} class="review-tabs">
            <Tabs.List class="tab-list"><Tabs.Tab>复核详情</Tabs.Tab><Tabs.Tab>合并追溯</Tabs.Tab><Tabs.Tab>键盘帮助</Tabs.Tab></Tabs.List>
            <Tabs.Panel class="tab-panel">
              {activeMatch.value ? (() => {
                const left = recordById(state, activeMatch.value!.leftId)!;
                const right = recordById(state, activeMatch.value!.rightId)!;
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
                return <details class="merge-log" key={merge.id}><summary>{left?.title ?? merge.leftId} ↔ {right?.title ?? merge.rightId}</summary><p>{new Date(merge.mergedAt).toLocaleString('zh-CN')}</p><ul>{Object.entries(merge.chosen).map(([field, choice]) => <li key={field}><strong>{fieldLabels.find(([key]) => key === field)?.[1]}</strong><span>保留 {choice === 'A' ? 'A 来源' : choice === 'B' ? 'B 来源' : '双来源拼接'}：{merge.values[field as FieldKey]}</span></li>)}</ul></details>;
              }) : <div class="empty-state">还没有合并记录。完成一次字段合并后，来源选择会出现在这里。</div>}
            </Tabs.Panel>
            <Tabs.Panel class="tab-panel shortcut-panel">
              <div><kbd>J / K</kbd><span>下一条 / 上一条可疑匹配</span></div><div><kbd>Enter</kbd><span>打开逐字段合并窗口</span></div><div><kbd>C / R</kbd><span>确认 / 忽略当前匹配</span></div><div><kbd>Ctrl + Z / Y</kbd><span>撤销 / 重做</span></div><div><kbd>Ctrl + I</kbd><span>打开导入窗口</span></div><div><kbd>Ctrl/⌘ + Enter</kbd><span>在导入框中提交记录</span></div>
            </Tabs.Panel>
          </Tabs.Root>
        </section>
      </main>

      <section class="bottom-grid">
        <article class="panel audit-panel">
          <div class="panel-heading"><div><span class="eyebrow">03 / TRACE</span><h3>最新处理记录</h3></div><span>{state.audit.length} 条 · 最近检查点 {checkpoints.value[0] ? new Date(checkpoints.value[0].at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '无'}</span></div>
          <div class="audit-list">
            {state.audit.slice(0, 8).map((entry) => <div class="audit-entry" key={entry.id}><time>{new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time><div><strong>{entry.action}</strong><p>{entry.detail}</p></div><span>{entry.recordIds.length ? `${entry.recordIds.length} 条记录` : '系统'}</span></div>)}
          </div>
        </article>
        <article class="panel explanation-panel">
          <div class="panel-heading"><div><span class="eyebrow">METHOD</span><h3>匹配与保护规则</h3></div></div>
          <p>标题、日期、人物、地点和编号按权重综合评分。低于 68% 的候选会以红色标记，但系统不会替研究者自动决定。</p>
          <div class="rule-row"><span>1</span><p>每个字段保留 A / B 来源，可在合并窗口中单独选择或拼接。</p></div>
          <div class="rule-row"><span>2</span><p>提交前领取编辑权并携带当时版本；版本落后直接拦住写入，指出冲突动作与被取代记录对，看完差异再重新领取。</p></div>
          <div class="rule-row"><span>3</span><p>每批确认、忽略、合并、导入前都落盘检查点；刷新或崩溃后自动回到最近检查点。</p></div>
          <div class="rule-row"><span>4</span><p>旧版本地数据自动迁移；读取失败时原数据进隔离区并可导出错误包。</p></div>
        </article>
      </section>

      {toast.value && <div class="toast">{toast.value}</div>}

      {/* 版本冲突：列出冲突动作、版本与被取代的记录对 */}
      <Modal.Root bind:show={conflictOpen} closeOnBackdropClick={false}>
        <Modal.Panel class="modal-panel conflict-modal">
          <Modal.Header class="modal-header">
            <div><span class="eyebrow">VERSION CONFLICT</span><Modal.Title>
              {conflict.value?.kind === 'lease' ? '其他页面正在编辑' : conflict.value?.kind === 'unreadable' ? '本地工作区读取失败' : '版本落后，写入已拦截'}
            </Modal.Title></div>
            <Modal.Close class="modal-close">×</Modal.Close>
          </Modal.Header>
          {conflict.value && (
            <>
              <Modal.Description class="modal-description">
                被拦截的动作：<strong>{conflict.value.action}</strong>（基于 r{conflict.value.baseVersion}）。
                {conflict.value.kind === 'version' || conflict.value.kind === 'remote'
                  ? ` 当前最新版本 r${conflict.value.currentVersion}，对方页面 ${conflict.value.remoteBy} 于 ${conflict.value.remoteAt ? new Date(conflict.value.remoteAt).toLocaleString('zh-CN') : ''} 保存了「${conflict.value.remoteAction}」。以下记录对存在冲突，你的本地改动已回滚，看完差异后请重新领取编辑权并重做。`
                  : conflict.value.detail}
              </Modal.Description>
              {(conflict.value.kind === 'version' || conflict.value.kind === 'remote') && (
                <div class="conflict-list">
                  {conflict.value.pairs.length === 0 && <div class="empty-state">两边数据没有记录级差异，直接重新领取即可在最新版本上继续。</div>}
                  {conflict.value.pairs.slice(0, 40).map((pair) => (
                    <details class="conflict-item" key={`${pair.kind}-${pair.id}`}>
                      <summary>
                        <span class={`conflict-kind ${pair.kind}`}>{conflictKindLabel[pair.kind]}</span>
                        <strong>{pair.label}</strong>
                      </summary>
                      <div class="conflict-actions"><div><small>你的动作</small><p>{pair.localAction}</p></div><div><small>对方动作</small><p>{pair.remoteAction}</p></div></div>
                      {pair.fields && pair.fields.length > 0 && (
                        <div class="conflict-fields">
                          <div class="field-picker-head inner"><span>字段</span><span>你的取值（r{conflict.value!.baseVersion}）</span><span>对方取值（r{conflict.value!.currentVersion}）</span></div>
                          {pair.fields.map((f) => (
                            <div class="conflict-field-row" key={f.field}>
                              <span>{fieldLabels.find(([key]) => key === f.field)?.[1] ?? f.field}</span>
                              <b>{f.local || '—'}</b>
                              <i>{f.remote || '—'}</i>
                            </div>
                          ))}
                        </div>
                      )}
                    </details>
                  ))}
                  {conflict.value.pairs.length > 40 && <div class="empty-state">另有 {conflict.value.pairs.length - 40} 条差异未展开。</div>}
                </div>
              )}
              <Modal.Footer class="modal-footer">
                {conflict.value.kind === 'unreadable' && <button class="button danger" onClick$={exportBundles}>导出错误包</button>}
                <Modal.Close class="button ghost">关闭</Modal.Close>
                <button class="button primary" onClick$={resync}>
                  {conflict.value.kind === 'lease' ? '重新领取编辑权' : `看差异后重新领取（载入 r${conflict.value.currentVersion}）`}
                </button>
              </Modal.Footer>
            </>
          )}
        </Modal.Panel>
      </Modal.Root>

      {/* 恢复点列表 */}
      <Modal.Root bind:show={checkpointOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel checkpoint-modal">
          <Modal.Header class="modal-header">
            <div><span class="eyebrow">CHECKPOINTS</span><Modal.Title>检查点与恢复</Modal.Title></div>
            <Modal.Close class="modal-close">×</Modal.Close>
          </Modal.Header>
          <Modal.Description class="modal-description">
            每批确认、忽略、合并和导入前都会在此留下检查点（保留最近 20 条）。刷新或崩溃后自动回到最近检查点，也可以手动回到任意一条；恢复操作本身会再生成一个检查点。
          </Modal.Description>
          <div class="checkpoint-list">
            {checkpoints.value.length === 0 && <div class="empty-state">还没有检查点。完成一次确认、忽略、合并或导入后出现。</div>}
            {checkpoints.value.map((cp) => (
              <details class="checkpoint-item" key={cp.id}>
                <summary>
                  <div><strong>{cp.action}</strong><small>{new Date(cp.at).toLocaleString('zh-CN')} · 基于 r{cp.baseVersion}</small></div>
                  <span>{cp.pairs.length} 对记录</span>
                </summary>
                <p>{cp.detail}</p>
                {cp.pairs.length > 0 && (
                  <ul class="notice-pairs">
                    {cp.pairs.slice(0, 8).map((pair, index) => (
                      <li key={`${cp.id}-${index}`}>{pairText(state, pair)}<span>{pair.reason}</span></li>
                    ))}
                    {cp.pairs.length > 8 && <li>…另有 {cp.pairs.length - 8} 对记录</li>}
                  </ul>
                )}
                <button class="button small" onClick$={() => restoreCheckpoint(cp)}>回到此检查点</button>
              </details>
            ))}
          </div>
        </Modal.Panel>
      </Modal.Root>

      <Modal.Root bind:show={importOpen} closeOnBackdropClick>
        <Modal.Panel class="modal-panel import-modal">
          <Modal.Header class="modal-header"><div><span class="eyebrow">IMPORT</span><Modal.Title>导入一组档案记录</Modal.Title></div><Modal.Close class="modal-close">×</Modal.Close></Modal.Header>
          <Modal.Description class="modal-description">支持 JSON 数组或制表符 / 竖线分隔文本。字段顺序：标题、日期、人物、地点、编号、载体、数量、权利、备注。既有复核结论在重新匹配后仍然保留。</Modal.Description>
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
            const left = recordById(state, activeMatch.value!.leftId)!;
            const right = recordById(state, activeMatch.value!.rightId)!;
            return <>
              <Modal.Description class="modal-description">每个字段都显示两条记录的原始来源。选择后，生成一条新合并记录，原记录编号与选择依据仍保留在审计轨迹中。</Modal.Description>
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
          })()}
        </Modal.Panel>
      </Modal.Root>
    </div>
  );
});
