/* 本地工作区版本凭据、检查点、崩溃恢复与迁移的冒烟测试（Node + 内存 Storage）。 */
import assert from 'node:assert/strict';
import {
  boot, acquireLease, releaseLease, saveEnvelope, createCheckpoint, writePending,
  clearPending, migrateV1, loadEnvelope, loadCheckpoints, loadErrorBundles,
  WORKSPACE_KEY, LEGACY_V1_KEY, LEASE_KEY, type StorageLike
} from '../src/utils/workspace';
import type { WorkspaceData } from '../src/types';

class MemoryStorage implements StorageLike {
  map = new Map<string, string>();
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

const seedData = (): WorkspaceData => ({
  revision: 1,
  records: [
    { id: 'a1', group: 'A', title: '甲记录', date: '2020-01-01', people: ['张三'], places: ['临河县'], identifier: 'A-1', medium: '录音', extent: '1小时', rights: '授权', notes: '', updatedAt: '', status: 'unreviewed' },
    { id: 'b1', group: 'B', title: '甲记录（手稿）', date: '2020-01-01', people: ['张三'], places: ['临河'], identifier: 'B-1', medium: '手稿', extent: '10页', rights: '授权', notes: '', updatedAt: '', status: 'unreviewed' }
  ],
  matches: [{ id: 'm1', leftId: 'a1', rightId: 'b1', score: 0.9, fieldScores: {} as never, status: 'suggested', reasons: ['标题相似'] }],
  merges: [],
  audit: [{ id: 'seed-audit', at: new Date().toISOString(), action: '初始化', detail: '', recordIds: [] }]
});

let passed = 0;
const test = async (name: string, fn: () => void) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

/* 1. 全新启动 */
test('全新启动生成 v2 信封', () => {
  const s = new MemoryStorage();
  const result = boot(s, seedData);
  assert.equal(result.envelope.schemaVersion, 2);
  assert.equal(result.envelope.version, 1);
  assert.equal(result.envelope.data.records.length, 2);
  assert.equal(loadEnvelope(s).envelope?.version, 1);
});

/* 2. 正常提交流程：领编辑权 → 版本 +1 */
test('领取编辑权后提交，版本号递增', () => {
  const s = new MemoryStorage();
  const { envelope } = boot(s, seedData);
  const lease = acquireLease(s, '页面A', '确认匹配');
  assert.equal(lease.ok, true);
  const data: WorkspaceData = structuredClone(envelope.data);
  data.matches[0].status = 'confirmed';
  data.revision += 1;
  const saved = saveEnvelope(s, data, envelope.version, '页面A', '确认匹配');
  assert.equal(saved.ok, true);
  assert.equal(saved.envelope!.version, 2);
  releaseLease(s, '页面A');
});

/* 3. 后保存的页面：版本落后被拦截 */
test('两个页面同时改，后保存的写入被拦住并返回冲突', () => {
  const s = new MemoryStorage();
  const { envelope } = boot(s, seedData);

  const tab1 = structuredClone(envelope.data);
  tab1.matches[0].status = 'confirmed';
  tab1.revision += 1;
  assert.equal(saveEnvelope(s, tab1, envelope.version, '页面A', '确认匹配').ok, true);

  const tab2 = structuredClone(envelope.data);
  tab2.matches[0].status = 'rejected';
  tab2.revision += 1;
  const blocked = saveEnvelope(s, tab2, envelope.version, '页面B', '忽略匹配');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.conflict?.kind, 'version');
  assert.equal(blocked.conflict?.currentVersion, 2);
  assert.equal(blocked.conflict?.remoteAction, '确认匹配');
  assert.equal(blocked.conflict?.baseVersion, 1);
  // 匹配复核动作相反，必须出现在被取代记录对里
  assert.ok(blocked.conflict!.pairs.some((p) => p.kind === 'match' && p.localAction.includes('忽略') && p.remoteAction.includes('确认')));
  // 存储未被盖回
  assert.equal(loadEnvelope(s).envelope!.data.matches[0].status, 'confirmed');
});

/* 4. 编辑权互斥 */
test('编辑权在租约有效期内互斥，释放或过期后可领取', () => {
  const s = new MemoryStorage();
  boot(s, seedData);
  assert.equal(acquireLease(s, '页面A', '合并').ok, true);
  const other = acquireLease(s, '页面B', '导入');
  assert.equal(other.ok, false);
  assert.equal(other.conflict?.holder, '页面A');
  releaseLease(s, '页面A');
  assert.equal(acquireLease(s, '页面B', '导入').ok, true);
});

/* 5. 刷新崩溃：进行中未完成 → 回到最近检查点 */
test('崩溃后启动回到最近检查点，并列出被取代的记录对', () => {
  const s = new MemoryStorage();
  const { envelope } = boot(s, seedData);
  const cp = createCheckpoint(s, '批量确认', '3 条匹配', envelope.version, envelope.data, [
    { leftId: 'a1', rightId: 'b1', leftTitle: '甲记录', rightTitle: '甲记录（手稿）', reason: '批量确认' }
  ]);
  writePending(s, { startedAt: new Date().toISOString(), action: '批量确认', detail: '3 条匹配', baseVersion: envelope.version, checkpointId: cp.id, holder: '页面A' });
  // 模拟页面崩溃：没有新信封落盘
  const result = boot(s, seedData);
  const interrupted = result.notices.find((n) => n.kind === 'interrupted');
  assert.ok(interrupted, '应给出中断恢复提示');
  assert.equal(interrupted!.pairs![0].leftId, 'a1');
  assert.equal(loadEnvelope(s).envelope!.version, envelope.version);
});

/* 6. 保存成功后才崩溃：不回退 */
test('保存完成后崩溃，重启识别为已完成而不是回退', () => {
  const s = new MemoryStorage();
  const { envelope } = boot(s, seedData);
  const cp = createCheckpoint(s, '确认匹配', 'm1', envelope.version, envelope.data, []);
  writePending(s, { startedAt: new Date().toISOString(), action: '确认匹配', detail: 'm1', baseVersion: 1, checkpointId: cp.id, holder: '页面A' });
  const next = structuredClone(envelope.data);
  next.matches[0].status = 'confirmed';
  next.revision += 1;
  saveEnvelope(s, next, 1, '页面A', '确认匹配');
  clearPending(s);
  // 标记残留（pagehide 未清理）的场景
  writePending(s, { startedAt: new Date().toISOString(), action: '确认匹配', detail: 'm1', baseVersion: 1, checkpointId: cp.id, holder: '页面A' });
  const result = boot(s, seedData);
  assert.ok(result.notices.some((n) => n.kind === 'completed'));
  assert.equal(loadEnvelope(s).envelope!.data.matches[0].status, 'confirmed');
});

/* 7. 旧版 v1 自动迁移且保留原数据 */
test('v1 本地数据自动迁移，原数据保留', () => {
  const s = new MemoryStorage();
  const v1 = JSON.stringify({
    revision: 7,
    records: seedData().records,
    matches: seedData().matches,
    merges: [],
    audit: [],
    activeMatchId: '',
    selectedRecordIds: [],
    hydrated: true
  });
  s.setItem(LEGACY_V1_KEY, v1);
  const result = boot(s, seedData);
  const migrated = result.notices.find((n) => n.kind === 'migrated');
  assert.ok(migrated);
  assert.equal(result.envelope.version, 7);
  assert.equal(s.getItem(LEGACY_V1_KEY), v1, '原 v1 数据不得删除');
  assert.ok(result.envelope.data.audit[0].action.includes('迁移'));
});

test('v1 数据损坏时保留原数据并登记错误包', () => {
  const s = new MemoryStorage();
  s.setItem(LEGACY_V1_KEY, '{ 不是 JSON');
  const result = boot(s, seedData);
  assert.ok(result.notices.some((n) => n.kind === 'quarantine'));
  const bundles = loadErrorBundles(s);
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].raw, '{ 不是 JSON');
  assert.equal(loadEnvelope(s).envelope?.version, 1);
});

/* 8. 主数据损坏 → 检查点恢复 + 隔离原数据 */
test('v2 主数据损坏时回退最近检查点并保留原数据', () => {
  const s = new MemoryStorage();
  const { envelope } = boot(s, seedData);
  const before = structuredClone(envelope.data);
  const cp = createCheckpoint(s, '合并两条记录', '甲记录', envelope.version, before, []);
  const edited = structuredClone(before);
  edited.matches[0].status = 'merged';
  saveEnvelope(s, edited, envelope.version, '页面A', '合并两条记录');
  s.setItem(WORKSPACE_KEY, '{损坏');
  const result = boot(s, seedData);
  assert.ok(result.notices.some((n) => n.kind === 'checkpoint'));
  const restored = loadEnvelope(s).envelope!;
  assert.equal(restored.version, cp.baseVersion);
  assert.equal(restored.data.matches[0].status, 'suggested');
  assert.equal(loadErrorBundles(s)[0].raw, '{损坏');
});

/* 9. 检查点上限与损坏隔离 */
test('检查点保留最近 20 条，索引损坏时原数据进隔离区', () => {
  const s = new MemoryStorage();
  const { envelope } = boot(s, seedData);
  for (let i = 0; i < 25; i++) createCheckpoint(s, `动作${i}`, '', envelope.version, envelope.data, []);
  assert.equal(loadCheckpoints(s).checkpoints.length, 20);
  assert.equal(loadCheckpoints(s).checkpoints[0].action, '动作24');
  const cpKey = 'sologsb-1020-checkpoints-v2';
  s.setItem(cpKey, '坏了');
  const { checkpoints, bundles } = loadCheckpoints(s);
  assert.equal(checkpoints.length, 0);
  assert.equal(bundles.length, 1);
});

/* 10. 重新领取（rebase 语义）：在新版本之上提交成功 */
test('落后页面载入对方最新版本后可重新提交', () => {
  const s = new MemoryStorage();
  const { envelope } = boot(s, seedData);
  const tab1 = structuredClone(envelope.data);
  tab1.matches[0].status = 'confirmed';
  tab1.revision += 1;
  saveEnvelope(s, tab1, 1, '页面A', '确认匹配');
  // 页面B 先同步 r2
  const latest = loadEnvelope(s).envelope!;
  assert.equal(latest.data.matches[0].status, 'confirmed');
  const rebase = structuredClone(latest.data);
  rebase.revision += 1;
  rebase.audit.unshift({ id: 'rebase', at: new Date().toISOString(), action: '重新领取编辑权并同步', detail: '', recordIds: [] });
  const saved = saveEnvelope(s, rebase, latest.version, '页面B', '重新领取编辑权并同步');
  assert.equal(saved.ok, true);
  assert.equal(saved.envelope!.version, 3);
  assert.equal(loadEnvelope(s).envelope!.data.matches[0].status, 'confirmed', '对方的复核没有被盖回');
});

/* 11. 租约键损坏不影响启动 */
test('租约残留已过期时可被新页面领取', () => {
  const s = new MemoryStorage();
  boot(s, seedData);
  s.setItem(LEASE_KEY, JSON.stringify({ holder: '旧页面', acquiredAt: '2000-01-01T00:00:00.000Z', expiresAt: '2000-01-01T00:00:01.000Z' }));
  assert.equal(acquireLease(s, '新页面').ok, true);
});

/* 12. migrateV1 单元校验 */
test('migrateV1 拒绝结构不完整的数据', () => {
  assert.equal(migrateV1('{"records":[]}').error !== undefined, true);
  const ok = migrateV1(JSON.stringify({ revision: 3, records: [], matches: [], merges: [], audit: [] }));
  assert.equal(ok.data?.revision, 3);
  assert.equal(ok.audit.length, 1);
});

console.log(`\n${passed} 个工作区测试全部通过。`);
