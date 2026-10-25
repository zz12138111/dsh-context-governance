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

## 3. 五个边界（①②③ 已由需求定；④⑤ 已进 DEC-40）

①②③ 的权威口径见 `REQUIREMENTS.md`（`8a8de91`）“### 窗口 W 的选取与校验口径（G4 结论，`DEC-20261025-65`）”与 `DEC-20261025-66`（记于 `STATUS.md` / `analysis/req-20261025-09/P3-闭环记录.md`）。复核时我按该口径对了一遍，结论如下：

| # | 边界 | 决策（已定，2026-10-26） | 复核意见 |
|---|---|---|---|
| ① | **多会话/多模型**：投影 per-session、`native`/策略进程级 | `#lastSession`（最近观察到的本项目会话）+ `window=` 带 session 短 id；**展示用当前会话，不取最小窗口** | 与我的建议一致；`#lastSession` 只在 `#belongsToProject` 通过后赋值，不会取到别项目会话（已核 `runtime` 事件入口） |
| ② | **W 中途变化/消失** | 每收到新窗口观察**立刻重算** `native`/四段/`at≤native`，不锁到下次 apply；`request/context` 不带 `contextWindow` → **删除并置 `unknown`**（显示 `window=unknown (removed by request/context)`），不沿用旧值；再观察自动恢复并记 `windowSource+observedAt` | 与我的建议一致。实现注意：`buildPolicyState` 现在只算一次，重算必须能改运行时 `native` 或按次计算——这是 0.2.1 结构性改动，不要做成“再算一次但缓存旧值” |
| ③ | **校验与显示同源** | `conservativeWindow=min(已观察窗口)`；无观察 → `unknown`，允许设 `at` 但标“未经校验”；运行时 `at>native` → **拒层 + 审计**（不静默降级）；`/cg status` **双显 current/conservative** 并明示“校验按 conservative” | 比我的“同一快照”建议更严，接受。但 ④ 的验收用例受 §3.1 公式退化影响，见下 |
| ④ | **性能**：`stateOf` 会 `materializeCells(session)` | 每次 status/判定取一次并缓存，不按事件调用；live 引用只读不改（已写入 `DEC-PLUGIN-20261025-40`） | 接受 |
| ⑤ | **W 取值防御**：host state 由 apply 写入原始值 | `Number.isInteger(W) && W > 0`，否则回退并标 reason（已写入 `DEC-PLUGIN-20261025-40`） | 接受；建议回退时把 reason 进状态行/审计（补充建议） |

### 3.1 追加边界（⑥）：`W ≤ O + 65536` 时公式退化（**已定 A：拒绝，不造数**）

- 现行 `nativeRatio`（`src/policy.js` 的配置回退函数）：`tokens = floor(min(W×0.8, W−O−65536))`；**`tokens <= 0` 时返回 `NATIVE_DEFAULT_RATIO = 0.6785`**——一个**常数假设值**。若把这个分支用到“观测窗口”上，就等于**造数冒充 native**。
- 例：另一会话 `W=131072`（128k）、`O=policy.reservedTokens=256000` → `W−O−65536 < 0` → 会得到 `native=0.6785`。
- 后果：保守值 `min(0.6934, 0.6785) = 0.6785` 被抬高；`compact.at=0.6` 会被判**合法**，与需求 ④ 验收“1M+128k、`at=0.6` 应被拒/降级”的期望**相反**，且状态会显示与真实窗口无关的 native。
- **决策（`DEC-20261025-68`，需求 `ac08001`，选 A）**：
  1. `W ≤ O+65536` → **`native = unknown (degenerate)`**，禁止常数 0.6785 冒充；
  2. 该值无法校验 `at ≤ native`：**设置 `compact.at` 的层一律拒绝（含会话层）**，审计 `policy-invalid(reason=native-uncomputable)`；
  3. 已生效的继承值标 **`unverified-degenerate`**；**0.2.2 提前压不得触发**（`effective < native` 无法成立）；
  4. `/cg status` 显示 `native=unknown (degenerate: W=128k O=256k)`；W 恢复 → 自动恢复可校验状态；
  5. 用例改写：**128k + `at=0.6` → 被拒（不是降级）**，优先于“1M+128k 双会话”的退化分支。
- **两个状态必须分开（验收重点）**：**无观察**（还没收到任何窗口）→ 允许设 `at`、标“未经校验”；**退化**（收到窗口但 `W ≤ O+65536`）→ **拒绝设置** + `native-uncomputable`。若实现把两者合并成一个“不可校验”，验收时必须用两组用例分别抓。

**补充建议（不单列为边界）**：`/cg status` 的 `window=` 标注除 `(projection)` / `(config-fallback)` 外，把回退原因（服务 absent / key 未注册 / 无 `contextWindow` / 值非法）写进审计或日志，便于复盘。

**落地状态（复核后跟进）**：④性能与⑤W 防御已写入 `DEC-PLUGIN-20261025-40`；①②③ 已由需求在 `8a8de91` 定稿并记 `DEC-20261025-66`（原 `ART-20261025-70` 待定项已关闭）；**⑥ 已定 A（`DEC-20261025-68` / `ac08001`）**，验收用例按本节 5 条执行。

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
- [ ] **双显** `window current=<值> (session 短 id) | conservative=<min>`；两者不一致时明示“校验按 conservative”
- [ ] 多会话/多模型：展示用 `#lastSession`，取到别项目会话 = fail；两条不同 W 的会话各自读数正确
- [ ] W 中途变化/删除后，`native` 与四段同步变化并可辨识（不沿用 apply 时的值）；删除后显示 `window=unknown (removed by request/context)`；再观察自动恢复并记 `observedAt`
- [ ] 无观察时允许设 `at` 且标“未经校验”；运行时 `at>native` → 拒层 + 审计（不静默降级）
- [ ] **⑥ 退化（A）**：`W ≤ O+65536` → `native=unknown (degenerate)`，**不得返回 0.6785**；设 `at` 的层（含会话层）**拒绝**并写 `policy-invalid(reason=native-uncomputable)`；继承值标 `unverified-degenerate`；`/cg status` 显示 `native=unknown (degenerate: W=128k O=256k)`；W 恢复后自动恢复可校验；**128k+`at=0.6` 用例=被拒**
- [ ] **⑥ 两状态不合并**：无观察 → 允许设 `at` + “未经校验”；退化 → 拒绝设置 + `native-uncomputable`。两组用例分别造，合并成一个“不可校验”即 fail
- [ ] `stateOf` 每次 status 至多一次、不按事件；不修改返回对象
- [ ] W 非整数/≤0 → 回退且可辨识
- [ ] 文档/样本数字更新；变更说明写清 native 0.6785→0.6934 与比例分母变化
- [ ] **样本一致性**：`samples-0.2.0.txt` 若更新为投影值，必须与“示意/裁剪”标注一致——不得“标示意却给精确新数字”；建议把“0.2.0 实跑样例”与“0.2.1 目标/推算值”分成两组、各自标版本与来源，不混在同一 fixture 里

## 6. 复现方式

1. **asar 取证**：读 `.../resources/app.asar`（header 8/12 字节处取 JSON 尺寸，见 `.tmp/asar-*.mjs`），关注 `@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js` 与 `dsh-session-projection/lib/index.js`。
2. **真实日志**：多帧 zstd（`28 b5 2f fd` 分段解码）解 `~/.dsh/sessions/**/session.v4.jsonl.zstd`，grep `request/context` → `data.contextWindow`。
3. **探针复跑**：`analysis/req-20261025-09/g4-probe-src/` 链到隔离 profile，`--patch` 叠加 `cordis.patch.yml` 启动，发一条消息后读日志（只记类型/数值，不记正文）。

## 7. 复核对象（已落档）

> 复核对象 = **`e12d08a`**：`analysis/req-20261025-09/G4-窗口来源结论.md`（`84819da03eb3e012`）、`DECISIONS.md` `DEC-PLUGIN-20261025-40`（`b26e1ec2f13bed93`）、`g4-probe-src/`（`index.js` `24e4eb5d122bcd5a`）、`g4-probe.log.txt`（`0e25ceb113628d6e`）。字节级已核，§2 三处修正均已在该提交内落地（§2“复检”逐条对应）。
> 后续若 0.2.1 再改 G4 相关文档，按新 commit 重新钉基线，本记录不追改。
