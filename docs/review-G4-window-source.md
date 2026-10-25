# G4 复核 · 窗口 / `native` 来源（供 0.2.1 验收引用）

> 复核人：审核打包会话（cs_DNciCVhuZD）· 2026-10-26
> 口径：**只报证据、修正与边界，不判验收**；口径决策归需求/用户（`DEC-20261025-65`）。本复核对象是 G4 结论文档，不是 0.2.1 代码。

## 0. 钉住的基线

G4 材料随 **`e12d08a`** 提交（“docs: G4 结论落档”）；本记录按该提交内容复核，下表 SHA-256 已与 `e12d08a` 的 blob 字节逐一对齐（4/4 一致）：

| 文件 | SHA-256 |
|---|---|
| `analysis/req-20261025-09/G4-窗口来源结论.md` | `84819da03eb3e012` |
| `DECISIONS.md`（含 `DEC-PLUGIN-20261025-40`） | `b26e1ec2f13bed93` |
| `analysis/req-20261025-09/g4-probe-src/index.js` | `24e4eb5d122bcd5a` |
| `analysis/req-20261025-09/g4-probe-src/cordis.patch.yml` | `adfe67a35c6db2f0` |
| `analysis/req-20261025-09/g4-probe-src/package.json` | `05e4991f10bba308` |
| `analysis/req-20261025-09/g4-probe.log.txt`（原 `.log` 被 `*.log` 忽略，已改名） | `0e25ceb113628d6e` |

> 初版复核对象：G4 文档 `c4c9853e18e3fc3d`、`DECISIONS.md` `1d4189c508b1fedc`（含 §2 的三处问题、日志名仍是 `.log`）。开发已按 §2 修正并复检，现行为上表哈希。

宿主：DeepSeek Harness **0.2.1-rc.3**（asar）。

> **提交归属注意**：`e12d08a` 同时带入了本记录的**初版**（我写完放暂存区、尚未 commit 时，开发按自己的 4 条路径 `git add` 后直接 commit，未核 `git diff --cached` 全量）。初版内容完整、未被改动；按 00 的处理不再重写历史，本记录的修订版（补 `e12d08a` 引用与复检结论）作为后续提交。后续协同时我会避免在可能被他人 `git add -A` 的窗口里留暂存文件。

## 1. 我独立验证成立的事实

| # | 事实 | 复核方式 | 结论 |
|---|---|---|---|
| 1 | `contextPressure` 投影存在，`stateVersion: 5`，schema 含 `contextWindow/pressureTokens/projectedTokens/surfaceTokens/sampledSurfaceTokens` | 解 asar：`@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js` | ✔ |
| 2 | `contextWindow` 来自 `request/context` 的 `event.data.contextWindow` | 同上，`apply` 内 `if (event.type === 'request/context')` 分支 | ✔ |
| 3 | **后一条 `request/context` 不带该字段时会删除旧窗口值** | 同上，`else { delete contextWindow }`（源码显式删除） | ✔（原文未写） |
| 4 | `stateOf(session,key)` 返回 **host state**，不产出 wire view | 解 asar：`dsh-session-projection/lib/index.js` 注释 “Unrelated wire views are not produced” | ✔ |
| 5 | wire view（含 `projectedTokens`）通过 `snapshot(session, keys)` 取得 | 同上，`snapshot()` 内 `registration.def.wire.view(...)` 且过 `viewSchema` | ✔ |
| 6 | 真实会话日志 `session-b2cd6d19…` 有两条 `request/context`，`contextWindow=1048576`，provider `deepseek-official` → `deepseek-account`（model 均 `deepseek-flash`），换 provider 窗口不变 | 我解 63 帧 zstd 独立复核 | ✔ |
| 7 | 探针日志数值：`request/context seq=14 → 1048576`，`assistant/message` 后 `pressureTokens=12284`、`contextWindow=1048576`、`surfaceTokens=3109`、`sampledSurfaceTokens=3048`；第二轮 `pressureTokens=12355` | 读 `g4-probe.log` 原文 | ✔ |
| 8 | `native(1,048,576) = 727040/1048576 ≈ 0.6934`；`native(1e6) = 0.6785`，差 **1.49pt** | 按 `nativeRatio` 公式复算 | ✔ |

## 2. 三处事实修正（初版需改；**已修并复检**）

1. **“`get.sessionProjections` 在 apply 时 absent、约 2s 后 object”不是普遍事实。**
   真机 0.2.0 的 `capability@apply`（`2026-10-25T16:11:21.204Z`）里是 **`get.sessionProjections=obj`**；探针的 isolated 实例 absent 只是加载顺序差异。
   → 结论“按需 `ctx.get`、每次判断”成立；事实句不要写成固定规律。
   **复检**：现文档 §1 已写“可见性受加载顺序影响，不是固定晚挂载”，§2.1 并列“探针 absent / 真机 obj”，`DEC-40` 事实句同步更正 ✔
2. **`projectedTokens` 不在 `stateOf` 返回值里。** 它是 wire view 字段；`stateOf` 只给 host state（探针日志里确实没有 `projectedTokens`）。
   → 要取：`sessionProjections.snapshot(session, ['contextPressure'])`，或自算 `pressureTokens + surfaceTokens − sampledSurfaceTokens`。
   **复检**：现文档 §1 行 22、§2.3、§3 表与 `DEC-40` 均已写明取法 ✔
3. **`g4-probe.log` 被仓库 `.gitignore` 的 `*.log` 忽略（未跟踪）。** 文档引用它会断链。
   → 改后缀或把关键行嵌入文档。
   **复检**：已改名 `g4-probe.log.txt`（内容哈希不变 `0e25ceb1…`），文档 §2/§5 同步 ✔

## 3. 五个边界（0.2.1 实现前要定；①②③ 归需求，④⑤ 归开发）

| # | 边界 | 我的建议（决策归需求） |
|---|---|---|
| ① | **多会话/多模型**：投影是 per-session，`native`/策略是进程级；`/cg status` 用哪条会话的 W？ | 用“最近观察到的本项目会话”（`runtime` 已有 `#lastSession`），并在 `window=…` 后标 session 短 id；两个会话窗口不同则各自读数，不假装单一 native |
| ② | **W 中途变化/消失**：`request/context` 带不同 window 会更新，不带会删除；换模型/路由会变 | 每次读取重算，不缓存 apply 时的值；W 变化/删除时 `native`、四段同快照更新并标注来源变化；`compact.at` 是比例、本身不变 |
| ③ | **校验与显示同源**：`at ≤ native` 在 apply 时按配置算，0.2.1 的投影可能到命令时才可见 | 命令/决策时用“当前会话 W”做同一快照校验；apply 时只做配置层的保守校验并标注；或统一取 `min(config-native, projection-native)` 保守 |
| ④ | **性能**：`stateOf` 会 `materializeCells(session)` | 每次 status/判定取一次并缓存，不按事件调用；返回的是 live 引用，不要修改或长期持有 |
| ⑤ | **W 取值防御**：host state 由 apply 写入原始值 | 取用前校验 `Number.isInteger(W) && W > 0`，否则回退配置并标 reason |

**补充建议（不单列为边界）**：`/cg status` 的 `window=` 标注除 `(projection)` / `(config-fallback)` 外，把回退原因（服务 absent / key 未注册 / 无 `contextWindow` / 值非法）写进审计或日志，便于复盘。

**落地状态（复核后跟进）**：④性能与⑤W 防御已写入 `DEC-PLUGIN-20261025-40` 的“选择”句（取一次缓存、live 引用只读不改、`Number.isInteger(W) && W > 0` 校验）；①②③（多会话 W / 中途变化 / 校验同源）00 已明确交需求定（`ART-20261025-70`），开发不自行拍。①②③ 的文档落地是本复核在 0.2.1 开工前的**待验项**。

## 4. Q2：0.2.0 行为影响（进 0.2.1 变更说明）

0.2.0 的 `native` 只用于：`/cg policy show`/`/cg status` 显示、`at ≤ native` 校验、`compact.at` 上界；**没有任何压缩触发**。因此：

| 项 | 0.2.0（配置 1e6） | 真实值（投影 1,048,576） | 影响 |
|---|---|---|---|
| `native` | 0.6785 | 0.6934 | 显示/校验上限偏低 **1.49pt**（相对 −2.15%） |
| `native` tokens | 678,464 | 727,040 | 少算 48,576 tokens |
| 压力四段分母 | 1,000,000 | 1,048,576 | 比例**高估 4.86%**；真机 `measured=0.197` → 真值 **0.188**（`estimated 0.135→0.129`、`adjusted 0.182→0.174`、`effective 0.197→0.188`）；`ratio` 与 W 无关（1.46 不变） |
| `at=0.52` 绝对门槛 | 520,000 | 545,260 | +25,260 tokens（+4.86%，比例语义不变） |
| `over-native` 误判窗口 | `at ∈ (0.6785, 0.6934]` 被 0.2.0 误拒 | 实际安全 | 默认 0.60、项目下限 0.45，实际几乎不触发 |

**结论**：已发布 0.2.0 的压缩行为**不受影响**（该版本无触发）；变化集中在显示值与校验上界。0.2.1 切换后同一 `at` 的绝对 token 门槛 +4.86%，这是“真实占窗口比例”的正确化。

**0.2.1 硬要求（00 单列）**：`native` 与压力分母**必须同源同时改**。现状 `cg-status.js:84` 传的是 `policy.windowTokens`，与 `buildPolicyState` 的 `native` 分开计算，只改一处会出现 `native=0.6934` 而比例仍按 1e6 的混搭。

**文档/样本连带**：0.6785、0.197 等数字会过期，0.2.1 需同步更新 `samples-0.2.0.txt`、T5/README 与变更说明。

## 5. 0.2.1 验收清单（我复核时逐条验）

- [ ] W 优先投影、缺失回退；`/cg status` 标 `window=<值> (projection|config-fallback)`
- [ ] `native` 与压力分母取自**同一快照**；有“只改一处”的混搭回归用例
- [ ] 多会话/多模型：标注所用 session；两条不同 W 的会话各自读数正确
- [ ] W 中途变化/删除后，`native` 与四段同步变化并可辨识（不沿用 apply 时的值）
- [ ] `at ≤ native` 校验与显示同源，无“显示允许 / apply 拒绝”矛盾
- [ ] `stateOf` 每次 status 至多一次、不按事件；不修改返回对象
- [ ] W 非整数/≤0 → 回退且可辨识
- [ ] 文档/样本数字更新；变更说明写清 native 0.6785→0.6934 与比例分母变化

## 6. 复现方式

1. **asar 取证**：读 `.../resources/app.asar`（header 8/12 字节处取 JSON 尺寸，见 `.tmp/asar-*.mjs`），关注 `@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js` 与 `dsh-session-projection/lib/index.js`。
2. **真实日志**：多帧 zstd（`28 b5 2f fd` 分段解码）解 `~/.dsh/sessions/**/session.v4.jsonl.zstd`，grep `request/context` → `data.contextWindow`。
3. **探针复跑**：`analysis/req-20261025-09/g4-probe-src/` 链到隔离 profile，`--patch` 叠加 `cordis.patch.yml` 启动，发一条消息后读日志（只记类型/数值，不记正文）。

## 7. 复核对象（已落档）

> 复核对象 = **`e12d08a`**：`analysis/req-20261025-09/G4-窗口来源结论.md`（`84819da03eb3e012`）、`DECISIONS.md` `DEC-PLUGIN-20261025-40`（`b26e1ec2f13bed93`）、`g4-probe-src/`（`index.js` `24e4eb5d122bcd5a`）、`g4-probe.log.txt`（`0e25ceb113628d6e`）。字节级已核，§2 三处修正均已在该提交内落地（§2“复检”逐条对应）。
> 后续若 0.2.1 再改 G4 相关文档，按新 commit 重新钉基线，本记录不追改。
