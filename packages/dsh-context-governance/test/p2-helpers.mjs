/**
 * P2 测试夹具：直接构造 `snapshotProtection` 形状（绕过真实 session，便于隐私开关断言）。
 */

export function buildProtectionSnapshotFixture() {
  return {
    capturedAt: '2026-10-25T11:00:00.000Z',
    nodes: [1, 2, 3],
    nodeCount: 3,
    latestUser: { seq: 3, title: '敏感首行：今天先做 P1 再处理 P2', kind: 'user' },
    rules: [],
    batch: null,
    rollback: null,
    unpairedCalls: [],
  };
}
