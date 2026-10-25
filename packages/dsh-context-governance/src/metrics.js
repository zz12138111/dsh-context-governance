/**
 * 小型统计工具：p50/p95 用于压缩前同步写盘耗时（T5 埋点）。
 * 纯函数，零依赖；null/非有限值忽略。
 */

export function percentile(samples, ratio) {
  const values = (samples ?? [])
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (values.length === 0) return null;
  const bounded = Math.min(Math.max(ratio, 0), 1);
  if (bounded === 0) return values[0];
  const rank = Math.ceil(bounded * values.length);
  return values[Math.min(Math.max(rank - 1, 0), values.length - 1)];
}

export function calculateLatencyStats(samples) {
  const values = (samples ?? []).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) {
    return { count: 0, p50Ms: null, p95Ms: null, maxMs: null, minMs: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: values.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
    minMs: sorted[0],
  };
}
