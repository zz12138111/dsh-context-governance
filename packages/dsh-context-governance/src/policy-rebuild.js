/**
 * rc.8 真机缺陷修复：策略重算的**唯一入口**——主 state 与每个 root 的 state 必须带同一套依赖。
 *
 * 缺陷原样：设置页保存 → 写路由 → `rebuildPolicies()`，per-root 那行写成
 * `buildPolicyState(mergePluginPolicy(rootConfig))`（漏传 deps）→ 该 root 的 state 里没有
 * `a2Store`，会话层 A1/A2 整个消失；`/cg status` 走 `policyForEntry` 命中重建后的缓存，
 * 于是同一个会话从 `session:A2 0.45` 掉成 `project 0.45`（值同、来源错）。
 *
 * 因此把「重算主 state + 重算每个 root + 全部带 deps」收进一个函数：调用方没有机会漏传，
 * 单测也能按多根场景直接验（不再依赖整条 apply 才能复现）。
 */

/**
 * @param {{config: object, rootConfigs?: Iterable<[string, object]>,
 *   buildPolicyState: (config: object, deps: object) => object,
 *   mergePluginPolicy: (config: object) => object,
 *   deps: () => object}} input
 * @returns {{main: object, roots: Map<string, object>}}
 */
export function rebuildPolicyStates({ config, rootConfigs = [], buildPolicyState, mergePluginPolicy, deps }) {
  if (typeof buildPolicyState !== 'function') throw new TypeError('rebuildPolicyStates needs buildPolicyState');
  if (typeof mergePluginPolicy !== 'function') throw new TypeError('rebuildPolicyStates needs mergePluginPolicy');
  if (typeof deps !== 'function') throw new TypeError('rebuildPolicyStates needs a deps factory');
  const main = buildPolicyState(mergePluginPolicy(config), deps());
  const roots = new Map();
  for (const [rootId, rootConfig] of rootConfigs) {
    // 与主 state 同一套 deps：漏传就会丢该 root 的 A1/A2 层（rc.8 缺陷）。
    roots.set(rootId, buildPolicyState(mergePluginPolicy(rootConfig), deps()));
  }
  return { main, roots };
}
