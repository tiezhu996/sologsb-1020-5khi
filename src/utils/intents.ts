import type {
  AffectedPair, ArchiveRecord, FieldKey, MatchCandidate, MergeResult, PersistedSlice, RecordGroup
} from '../types';
import { computeMatches, fieldValue } from './matching';
import { deepClone, newId } from './labels';

/** 可序列化、可在新版本上重放的批次意图 */
export type WorkspaceIntent =
  | { type: 'review'; ids: string[]; status: Extract<MatchCandidate['status'], 'confirmed' | 'rejected'> }
  | { type: 'merge'; matchId: string; choices: Record<FieldKey, RecordGroup | 'combine'> }
  | { type: 'import'; group: RecordGroup; rows: Array<Partial<ArchiveRecord>> }
  | { type: 'rollback'; checkpointId: string };

export interface IntentResult {
  action: string;
  detail: string;
  affected: AffectedPair[];
  toast: string;
}

export const intentLabel = (intent: WorkspaceIntent) => {
  switch (intent.type) {
    case 'review': return intent.status === 'confirmed' ? `批量确认 ${intent.ids.length} 项` : `批量忽略 ${intent.ids.length} 项`;
    case 'merge': return '逐字段合并';
    case 'import': return `导入 ${intent.group} 组 ${intent.rows.length} 条`;
    case 'rollback': return '回退到检查点';
  }
};

const recordTitle = (slice: PersistedSlice, id: string) =>
  slice.records.find((record) => record.id === id)?.title ?? id;

/** 执行前预览本批将取代 / 影响的记录对（用于检查点与冲突提示） */
export const previewIntent = (slice: PersistedSlice, intent: WorkspaceIntent): AffectedPair[] => {
  if (intent.type === 'review') {
    return intent.ids.flatMap((id) => {
      const match = slice.matches.find((item) => item.id === id);
      if (!match) return [];
      return [{
        kind: 'review' as const,
        leftId: match.leftId, rightId: match.rightId,
        leftTitle: recordTitle(slice, match.leftId), rightTitle: recordTitle(slice, match.rightId),
        detail: `${match.status} → ${intent.status}`
      }];
    });
  }
  if (intent.type === 'merge') {
    const match = slice.matches.find((item) => item.id === intent.matchId);
    if (!match) return [];
    return [{
      kind: 'merge',
      leftId: match.leftId, rightId: match.rightId,
      leftTitle: recordTitle(slice, match.leftId), rightTitle: recordTitle(slice, match.rightId),
      detail: '两条原记录将被一条合并记录取代'
    }];
  }
  if (intent.type === 'import') {
    return [{ kind: 'import', detail: `新增 ${intent.rows.length} 条 ${intent.group} 组记录并重算候选匹配` }];
  }
  const checkpoint: AffectedPair = {
    kind: 'rollback',
    detail: `工作区恢复到检查点 ${intent.checkpointId.slice(0, 8)}`
  };
  return [checkpoint];
};

/** 在给定切片（草稿）上应用意图，返回审计所需信息。不得依赖任何界面状态。 */
export const applyIntent = (slice: PersistedSlice, intent: WorkspaceIntent): IntentResult => {
  if (intent.type === 'review') return applyReview(slice, intent);
  if (intent.type === 'merge') return applyMerge(slice, intent);
  if (intent.type === 'import') return applyImport(slice, intent);
  return applyRollback(slice, intent);
};

function applyReview(slice: PersistedSlice, intent: Extract<WorkspaceIntent, { type: 'review' }>): IntentResult {
  const affected: AffectedPair[] = [];
  const at = new Date().toISOString();
  let changed = 0;
  intent.ids.forEach((id) => {
    const match = slice.matches.find((item) => item.id === id);
    if (!match) return;
    const before = match.status;
    match.status = intent.status;
    match.reviewedAt = at;
    if (intent.status === 'confirmed') {
      slice.records.forEach((record) => {
        if (record.id === match.leftId || record.id === match.rightId) record.status = 'confirmed';
      });
    }
    changed += 1;
    affected.push({
      kind: 'review',
      leftId: match.leftId, rightId: match.rightId,
      leftTitle: recordTitle(slice, match.leftId), rightTitle: recordTitle(slice, match.rightId),
      detail: `${before} → ${intent.status}`
    });
  });
  const bulk = intent.ids.length > 1;
  return {
    action: bulk ? '批量复核' : intent.status === 'confirmed' ? '确认匹配' : '忽略可疑匹配',
    detail: bulk
      ? `${changed} 条匹配被标记为${intent.status === 'confirmed' ? '确认' : '忽略'}`
      : `${affected[0]?.leftTitle ?? ''} ↔ ${affected[0]?.rightTitle ?? ''}：${intent.status === 'confirmed' ? '确认' : '忽略'}`,
    affected,
    toast: bulk ? `已批量处理 ${changed} 条匹配` : intent.status === 'confirmed' ? '已确认此项匹配' : '已忽略此项匹配'
  };
}

function applyMerge(slice: PersistedSlice, intent: Extract<WorkspaceIntent, { type: 'merge' }>): IntentResult {
  const match = slice.matches.find((item) => item.id === intent.matchId);
  if (!match) throw new Error('待合并的匹配已不存在，可能已被另一个核对页处理');
  const left = slice.records.find((record) => record.id === match.leftId);
  const right = slice.records.find((record) => record.id === match.rightId);
  if (!left || !right) throw new Error('待合并的记录已不存在，可能已被另一个核对页合并或删除');
  const at = new Date().toISOString();
  const values: Partial<Record<FieldKey, string>> = {};
  (Object.keys(intent.choices) as FieldKey[]).forEach((field) => {
    const source = intent.choices[field];
    values[field] = source === 'combine'
      ? `${fieldValue(left, field)}；${fieldValue(right, field)}`
      : fieldValue(source === 'A' ? left : right, field);
  });
  const merged: ArchiveRecord = {
    ...deepClone(left),
    ...values,
    id: newId(),
    people: values.people?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.people,
    places: values.places?.split(/[；、,，]/).map((item) => item.trim()).filter(Boolean) ?? left.places,
    status: 'merged',
    updatedAt: at
  };
  slice.records = [...slice.records.filter((record) => record.id !== left.id && record.id !== right.id), merged];
  slice.matches.forEach((item) => {
    if (item.id === match.id) item.status = 'merged';
    else if (
      item.leftId === left.id || item.rightId === right.id
      || item.leftId === right.id || item.rightId === left.id
    ) item.status = 'rejected';
  });
  const mergeEntry: MergeResult = {
    id: newId(),
    matchId: match.id,
    leftId: left.id,
    rightId: right.id,
    chosen: { ...intent.choices },
    values,
    mergedAt: at
  };
  slice.merges = [mergeEntry, ...slice.merges];
  const choices = Object.values(intent.choices);
  return {
    action: '合并两条记录',
    detail: `保留 ${choices.filter((choice) => choice === 'A').length} 个 A 来源字段、${choices.filter((choice) => choice === 'B').length} 个 B 来源字段`,
    affected: [{
      kind: 'merge',
      leftId: left.id, rightId: right.id,
      leftTitle: left.title, rightTitle: right.title,
      detail: `原 ${left.title} ↔ ${right.title} 已被合并记录 ${merged.title} 取代`
    }],
    toast: '记录已合并，来源与字段选择已写入审计记录'
  };
}

function applyImport(slice: PersistedSlice, intent: Extract<WorkspaceIntent, { type: 'import' }>): IntentResult {
  const at = new Date().toISOString();
  intent.rows.forEach((row) => {
    slice.records.push({
      id: newId(),
      group: intent.group,
      title: row.title || '未命名记录',
      date: row.date || '',
      people: Array.isArray(row.people) ? row.people : String(row.people || '').split(/[，,、]/).filter(Boolean),
      places: Array.isArray(row.places) ? row.places : String(row.places || '').split(/[，,、]/).filter(Boolean),
      identifier: row.identifier || '',
      medium: row.medium || '',
      extent: row.extent || '',
      rights: row.rights || '',
      notes: row.notes || '',
      updatedAt: at,
      status: 'unreviewed'
    });
  });
  slice.matches = computeMatches(slice.records);
  return {
    action: '导入档案记录',
    detail: `从 ${intent.group} 组导入 ${intent.rows.length} 条记录`,
    affected: [{ kind: 'import', detail: `新增 ${intent.rows.length} 条 ${intent.group} 组记录并重算候选匹配` }],
    toast: `已导入 ${intent.rows.length} 条记录并重新匹配`
  };
}

function applyRollback(slice: PersistedSlice, intent: Extract<WorkspaceIntent, { type: 'rollback' }>): IntentResult {
  // 快照恢复由工作区层在提交前直接替换切片；这里只负责审计信息。
  return {
    action: '回退检查点',
    detail: `按检查点 ${intent.checkpointId.slice(0, 8)} 恢复工作区`,
    affected: [{ kind: 'rollback', detail: '当前及之后批次被检查点快照取代' }],
    toast: '已回到所选检查点'
  };
}
