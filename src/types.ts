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
}

/** 可持久化的核对数据（不含界面临时状态）。版本号即乐观锁凭据。 */
export interface WorkspaceData {
  revision: number;
  records: ArchiveRecord[];
  matches: MatchCandidate[];
  merges: MergeResult[];
  audit: AuditEntry[];
}

export interface ArchiveState extends WorkspaceData {
  activeMatchId: string;
  selectedRecordIds: string[];
  hydrated: boolean;
}

/** 本地存储信封：每次成功提交 version + 1，updatedBy 记录领取编辑权的页面。 */
export interface WorkspaceEnvelope {
  schemaVersion: 2;
  version: number;
  updatedAt: string;
  updatedBy: string;
  lastAction: string;
  data: WorkspaceData;
}

/** 一次提交所影响、被取代或新增的记录对。 */
export interface AffectedPair {
  leftId: string;
  rightId: string;
  leftTitle?: string;
  rightTitle?: string;
  reason: string;
}

/** 提交前落盘的恢复点，独立于主数据保存，主数据损坏时仍可用。 */
export interface Checkpoint {
  id: string;
  at: string;
  action: string;
  detail: string;
  baseVersion: number;
  data: WorkspaceData;
  pairs: AffectedPair[];
}

/** 写操作进行中的标记，先于数据修改落盘，用于崩溃/刷新后判断。 */
export interface PendingMarker {
  startedAt: string;
  action: string;
  detail: string;
  baseVersion: number;
  checkpointId: string;
  holder: string;
}

/** 编辑权租约。 */
export interface LeaseRecord {
  holder: string;
  acquiredAt: string;
  expiresAt: string;
  action?: string;
}

/** 版本冲突时列出的被取代记录对（本地动作 vs 对方动作）。 */
export interface SupersededPair {
  kind: 'record' | 'match' | 'merge';
  id: string;
  label: string;
  localAction: string;
  remoteAction: string;
  fields?: Array<{ field: FieldKey; local: string; remote: string }>;
}

export type ConflictKind = 'lease' | 'version' | 'remote' | 'unreadable';

export interface ConflictInfo {
  kind: ConflictKind;
  action: string;
  detail: string;
  baseVersion: number;
  currentVersion: number;
  remote?: WorkspaceData;
  local?: WorkspaceData;
  remoteBy?: string;
  remoteAt?: string;
  remoteAction?: string;
  leaseHolder?: string;
  leaseExpiresAt?: string;
  pairs: SupersededPair[];
}

/** 读取失败时保留下来的原始数据错误包。 */
export interface ErrorBundle {
  id: string;
  at: string;
  kind: 'quarantine' | 'parse';
  storageKey: string;
  error: string;
  raw: string;
}

export interface RecoveryNotice {
  id: string;
  kind: 'migrated' | 'checkpoint' | 'quarantine' | 'interrupted' | 'completed';
  title: string;
  detail: string;
  at: string;
  pairs?: AffectedPair[];
  bundles: ErrorBundle[];
}

export interface BootResult {
  envelope: WorkspaceEnvelope;
  checkpoints: Checkpoint[];
  notices: RecoveryNotice[];
}
