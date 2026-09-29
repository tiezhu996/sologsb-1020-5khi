export type RecordGroup = 'A' | 'B';
export type MatchStatus = 'suggested' | 'confirmed' | 'rejected' | 'merged';
export type FieldKey = 'title' | 'date' | 'people' | 'places' | 'identifier' | 'medium' | 'extent' | 'rights' | 'notes';

export interface ArchiveRecord {
  id: string;
  group: RecordGroup;
  title: string;
  date: string;
  people: string[];
  places: string[];
  identifier: string;
  medium: string;
  extent: string;
  rights: string;
  notes: string;
  updatedAt: string;
  status: 'unreviewed' | 'confirmed' | 'rejected' | 'merged';
}

export interface MatchCandidate {
  id: string;
  leftId: string;
  rightId: string;
  score: number;
  fieldScores: Record<FieldKey, number>;
  status: MatchStatus;
  reasons: string[];
  reviewedAt?: string;
}

export interface MergeResult {
  id: string;
  matchId: string;
  leftId: string;
  rightId: string;
  chosen: Partial<Record<FieldKey, RecordGroup | 'combine'>>;
  values: Partial<Record<FieldKey, string>>;
  mergedAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  action: string;
  detail: string;
  recordIds: string[];
  before?: string;
  after?: string;
  /** 该审计条目落盘时的工作区版本号，用于跨核对页比对冲突动作 */
  rev?: number;
}

/** 落盘的可持久化切片（不含纯界面状态） */
export interface PersistedSlice {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
}

export interface ArchiveState extends PersistedSlice {
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
}

/** 一次批次涉及（或被取代）的记录对 */
export interface AffectedPair {
  kind: 'review' | 'merge' | 'import' | 'rollback' | 'undo' | 'system';
  leftId?: string;
  rightId?: string;
  leftTitle?: string;
  rightTitle?: string;
  detail: string;
}

/** 编辑权凭据：领取时携带当时版本，提交时校验 */
export interface EditLease {
  sessionId: string;
  sessionLabel: string;
  action: string;
  baseRevision: number;
  acquiredAt: string;
  expiresAt: string;
}

export interface LeaseHolder {
  sessionId: string;
  sessionLabel: string;
  action: string;
  acquiredAt: string;
  expiresAt: string;
}

/** 每批确认 / 忽略 / 合并 / 导入前留下的恢复点 */
export interface Checkpoint {
  id: string;
  at: string;
  label: string;
  kind: AffectedPair['kind'];
  baseRevision: number;
  affected: AffectedPair[];
  snapshot: PersistedSlice;
}

/** 提交进行中标记：刷新 / 崩溃后据此回到最近检查点 */
export interface CommitMarker {
  checkpointId: string;
  kind: string;
  label: string;
  baseRevision: number;
  at: string;
}

export interface ConflictFieldChange {
  field: FieldKey;
  label: string;
  before: string;
  after: string;
}

export interface ConflictRecordChange {
  id: string;
  title: string;
  change: 'added' | 'removed' | 'modified';
  statusBefore?: string;
  statusAfter?: string;
  fields: ConflictFieldChange[];
}

export interface ConflictMatchChange {
  id: string;
  leftTitle: string;
  rightTitle: string;
  change: 'added' | 'removed' | 'status';
  before?: string;
  after?: string;
}

/** 版本落后被拦截时，展示给用户的冲突说明 */
export interface ConflictInfo {
  label: string;
  checkpointId: string;
  baseRevision: number;
  triedRevision: number;
  latestRevision: number;
  holder?: LeaseHolder;
  incomingActions: AuditEntry[];
  recordChanges: ConflictRecordChange[];
  matchChanges: ConflictMatchChange[];
  mergeAdded: number;
  affected: AffectedPair[];
}

export interface ErrorPackage {
  kind: 'workspace-read-error' | 'workspace-migration-error';
  at: string;
  key: string;
  /** 损坏原件被隔离保留到的本地键（读取失败时） */
  quarantineKey?: string;
  message: string;
  userAgent: string;
  raw: string;
}
