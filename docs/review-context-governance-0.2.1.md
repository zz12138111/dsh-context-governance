# 复核基线 · dsh-context-governance 0.2.1（窗口 / 校验层）

> 复核人：审核打包会话（cs_DNciCVhuZD）· 2026-10-26
> 口径：只给问题与证据，**不下验收结论**；验收归用户。范围：`DEC-20261025-67`（0.2.1 = 窗口/校验层，**本版不触发任何压缩**）。

## 0. 钉住的基线

| 项 | 值 |
|---|---|
| **代码基线** | `b0d6a3e`（`3861dff` 主体 + `b0d6a3e` 对齐退化 A）；父链 `725b04b`（P3-1）→`ac08001`（⑥ 口径） |
| **快照** | `.tmp/snapshot-021/` = `git archive b0d6a3e`；工作树 clean |
| **全量测试（快照内）** | **250/250 pass**（0.2.0 收口 234 + P3 新增 6 + 0.2.1 新增 10 = 250 ✔） |
| **拓扑** | `origin` = `e1472f9`；复核时本地 ahead **4** = `b0d6a3e`（代码）+ 3 条 M3 需求草案（`b115a22`/`689144d`/`3e91dfa`，与 0.2.1 无关）；报告按 **代码 `b0d6a3e`** 钉基线；tag 为空 |
| **版本** | `package.json` = **0.2.1** ✔ |
| **独立探针** | `.tmp/probe-021.mjs` **8/8**（窗口观察/删除、1M+128k 同源、退化 A、无观察、运行时审计、零压缩 spy）+ 额外状态/审计探针 |
| **安装态** | 真机 = **0.2.0**（`apply version=0.2.0`，pid 23444，`2026-10-25T16:11:21.205Z`）；**0.2.1 未装/未重启**；宿主 0.2.1-rc.3 |

## 1. 结论摘要

- **阻断（P1）：0**；**应修（P2）：0**（P2-5 于 `7e5786a` 闭环，见 §16）；**建议（P3）：0**。
- 六条验收 **4 条完全成立、1 条部分（⑥ 的审计子项）、1 条报告证据不完整**；十项清单里 **⑩ 数字更新未做**（详见 §4）。
- 代码检索与 spy 双证：**本版没有任何压缩调用路径**（我用自己的全量 pattern + 3 个真实 API 名 spy 复核，0 次）。

## 2. 六条验收逐条

| # | 验收要求 | 我的独立复核 | 结论 |
|---|---|---|---|
| 1 | `windowState={current(#lastSession), conservative(min), observed[]}`；删除置 unknown 不沿用 | 事件驱动实测：两个会话 1M→128k，`current` 跟最后会话、`conservative=128k`、`observed=2`；删除事件后 `current=null`、`removed=true`、`conservative` 从剩余观察取 1M | ✔ |
| 2 | 动态 `native` 与压力分母共用同一 W | `resolved.window.native=0.8000`（1M/O=16k）、`nativeConservative=0.3750`、`currentTokens=1,048,576`；status 的 `policy:` 与 `pressure:` 均用 current（`window=1M (session …)`） | ✔ |
| 3 | conservative 校验；无观察 `unvalidated`；运行时 `at>native` 拒层+审计；**3b 退化 A** | 1M/128k 下 `at=0.6` 被拒回落 plugin 0.30 ✔；无观察允许设 `at=0.5` 且 `validated=false` ✔；运行时窗口 1M→128k 后 plugin `at=0.5` 被拒 + `policy-invalid(over-native-runtime)` **实测写入 1 条** ✔；退化 A：`native=null`、plugin/session 层均 `native-uncomputable`、`validationNative()=null`、`/cg set` 报 `native-uncomputable`、W 恢复后 0.6 自动生效 ✔ **但退化拒层不写审计 → P2-1** | ⚠ 部分 |
| 4 | status 双显 + session 短 id + 来源/时间 + “校验按 conservative” | 实测输出：`window: current=1M (session 58a2e845) observed … source=projection conservative=128k (session bbbbbbbb) native-current=0.8000(projection) native-conservative=0.3750 validated 校验按 conservative` ✔；退化时 `unknown (degenerate: W=128k O=256k) unverified-degenerate` ✔ | ✔ |
| 5 | 用例：1M+128k（at=0.6 被拒）、退化、删除窗口 | 三条用例均在 `test/window-021.test.mjs`，我用探针独立复跑同语义 | ✔ |
| 6 | 代码检索 + 单测证明无压缩触发 | 见 §3：结论成立，**但开发的 pattern 与证据文件不完整**（P3-5） | ⚠ 证据面 |

## 3. ⑧ “无压缩触发”复核（回答 00 的三个疑点）

1. **`compactRegion` 不是笔误**：它是宿主真实 API——`dsh-compaction-basic` 实现了 `compactRegion()`，`dsh-tool-cordis` 的 `api-catalog` 里有 `abstract compactRegion(...)`；`compactNow()`/`compactIfNeeded()` 同为真实 API。开发把它列进 pattern 是对的。
2. **`ctx.compaction` 那 7 处探测仍在基线内、无新增调用**：`git diff e6d859b..b0d6a3e -- src` 的**新增行**对 `compactNow|compactIfNeeded|forceCompact|triggerCompaction|compactRegion|agentPresets|serviceFor|ctx.compaction` **0 命中**；现存引用仍是 `adapters.js:266/287/293`（`typeof` 探测/注释）+ `runtime.js:234`、`index.js:407` 的只读探测。
3. **覆盖度不够**：开发的 pattern `compactNow|compactRegion|serviceFor|agentPresets` **漏了 `compactIfNeeded`**（`adapters.js:266` 就命中它）和 `ctx.compaction` 全量；所以 `zero-compaction-grep.txt` 只有 2 行、报告“只有 :287/:293 两处”漏了 `:266`。**结论仍然成立**（我补了全量 pattern + diff + spy），但报告证据需补全。
   - 我的 spy：假 `ctx.compaction` 上 `compactNow/compactIfNeeded/compactRegion` 计数，跑 `apply` + `request/context`/`assistant`/`turn/end` + `/cg status`/`policy show`/`set`/`set reset` → **三个计数全 0**。
   - 建议补：pattern 加 `compactIfNeeded|ctx\.compaction`，并把 266 行纳入说明（P3-5，报告面）。

## 4. ⑩ 数字更新审计（**未做，P2-2**）

- 交付物内（`src/`、`docs/`、`analysis/`、`README`）`git grep '0\.6934'` = **0 命中**——0.2.1 的真实取值从未写进任何代码注释/文档/样本（只有本复核报告在引用它）。
- 仍把 0.6785 / 67.85% 当“当前 native”的位置：
  - `docs/T5-状态命令与审计.md:39`（示例 `native=0.6785`，缺 `(config-fallback)` 后缀）、`:62`（“1M/256k ≈ 0.6785”）
  - `packages/dsh-context-governance/README.md:85`（同口径）
  - `docs/M2-使用说明-草案-v0.3.md:22/45/96/123`（“系统约 67.85%”“约 0.6785 上限”）
  - `analysis/req-20261025-09/samples-0.2.0.txt` 全部样例仍是 0.2.0 形态（无 `window:` 行、`native=0.6785`、`window=1.00M`），只标了“示意/裁剪”
- 交付报告未写 Q2 影响（`native 0.6785→0.6934`、比例分母 1e6→1,048,576、`measured 0.197→0.188`）——而 `REQUIREMENTS` 明确要求变更说明含这组数字。
- 数学核对：`W=1,048,576, O=256,000 → 727,040/1,048,576 = 0.6934`；同一 `at` 的绝对门槛 +4.86%。
- 建议：T5/README 的当前事实示例改成 `native=0.6934 (projection)` 并保留一句“配置回退 1e6/256k = 0.6785”；使用说明改“按实际窗口计算（本机 1.048576M 时约 69.3%）”；`samples` 增 0.2.1 组（含 `window:` 行）或标“0.2.0 形态”；交付报告补 Q2 数字。

## 5. 问题清单

### P2（应修）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| **P2-1** | `src/index.js:520` | 退化 A 改了 reason（`native-uncomputable`），但运行时审计过滤仍只认 `over-native-runtime`/`window-too-small` → **退化拒层既无 audit 也无 warn**。实测：W=128k/O=256k + plugin `at=0.5`，audit 只有 `apply/capability@apply/@ready`，没有 `policy-invalid`。DEC-68 明确要求 `policy-invalid(reason=native-uncomputable)` | filter 加 `native-uncomputable`（并删已无来源的 `window-too-small`）；补“退化拒层写 1 条审计”的单测；若“设置即审计”也覆盖 `/cg set` 拒绝路径，一并补 |
| **P2-2** | §4 所列文档/样本/交付报告 | 0.2.1 的数值变更（0.6785→0.6934、分母 1,048,576、0.197→0.188）没进任何当前文档；用户文档仍宣称 67.85%/0.6785 | 按 §4 建议更新并补变更说明 |

### P3（建议）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| **P3-1** | `cg-status.js` 压力行 | 无观察时 `window:` 行标 `(config-fallback)`，但压力行仍显示 `window=1M` **无 fallback 标记**（实测） | 压力行复用 `resolved.window.currentSource` 标 `(config-fallback)` |
| **P3-2** | `cg-status.js:61` / `:340` | `policy-session:` 与 `policy show` 的 `session:` 读原始 `sessionLayer.values`：被运行时拒掉的覆盖仍显示（实测 `session: compact.at=0.6`，生效表 `source=builtin`） | 显示 `(rejected: over-native-runtime)` 或过滤掉被拒键 |
| **P3-3** | 状态显示 | 拒层后回落到 builtin 0.6，仍 **> conservative native 0.375**，但状态只显示 `policy: compact.at=0.60 … native=0.8`（current），没有“生效 at 已超保守上限”的提示 | `window:`/`policy:` 行明示 `at=0.60 > native-conservative=0.3750`；0.2.2 执行前必须防 |
| **P3-4** | `runtime.js` `#windows` | 无 `session/end` 清理；`conservative = 全历史 min`，一个已结束的 128k 会话会永久压低校验上限；`#removedWindows` 只增不减 | 定义过期/结束时清理（0.2.2 前），或在文档写明“当前为全历史 min” |
| **P3-5** | 交付报告 §1 第 6 行 + `zero-compaction-grep.txt` | pattern 漏 `compactIfNeeded`/`ctx.compaction`，证据文件只有 2 行、漏 `adapters.js:266`（结论未受影响，见 §3） | 补全 pattern 与输出，说明 266 是 `typeof` 探测 |
| **P3-6** | `runtime.js:603-606` | `request/context` 的 `contextWindow` 非法（字符串/0/负数）在“已有旧值”时走删除分支，状态显示 `removed by request/context`，与“字段缺失=显式移除”混同 | 非法值单独 reason（如 `invalid-window`），不显示 removed |
| **P3-7** | `index.js` 审计去重 Set | 拒层审计用 `Set` 去重后不清空：W 恢复→再次退化时不会产生第二次审计 | W 恢复时清对应 key，或审计带 `observedAt` 区分周期 |
| **P3-8** | `index.js` `resolveWithWindow` | **无观察 + 配置窗口自身退化**（如 `windowTokens=200000`、`O=256000`）时按退化处理：`at` 层被拒、状态 `degenerate`（实测）。这与“无观察允许设 `at`（未校验）”的两状态定义在交界处不一致 | 文档写清“配置窗口自身退化也按退化拒绝”，或改为“无观察一律 unvalidated、仅观测退化才拒”（二选一） |

## 6. 未验证 / 边界（不在本轮结论内）

1. **真机未装 0.2.1**：真机当前加载 **0.2.0**（audit `apply version=0.2.0`，pid 23444，16:11:21.205Z）；0.2.1 未安装/未重启，`window:` 行与投影 W=1,048,576 的真机读数未验。（初稿误写“真机 0.1.14”，已按 00 更正。）
2. **0.2.2 执行**：无压缩触发路径已证；`effective < native` 防抢、冷却/增量门槛未做（0.2.2）。
3. **conservative 语义**：全历史 min（P3-4）是当前实现，规格未定义过期；0.2.2 前需定。
4. **跨项目**：窗口观察仍受 `onlyProject` 过滤（本项目会话才进 conservative），文档应写“本项目已观察窗口”。
5. 0.1.15+ 真机观察点（batch-list/protection-skip/manual-compaction-loss）仍未验，与 0.2.1 无关。

## 7. 发布口径（建议，不代决）

- 分支：本报告随 `feat/context-governance-m1` fast-forward 推送；**不打 tag、不发 Release**（归用户）。
- 0.2.1 当前有 2 条 P2，建议修完再谈上机；若用户决定先上机，P2-2（数字）至少先改掉，避免用户看到 67.85% 而实际 69.34%。
- tag 建议：`v0.2.1` → 修完 P2 后的 HEAD（届时另钉）；zip 用 `git archive`。

## 8. 复现

```powershell
git archive --format=tar --output=.tmp/h21.tar b0d6a3e
tar -xf .tmp/h21.tar -C .tmp/snapshot-021
cd .tmp/snapshot-021/packages/dsh-context-governance
node --test "test/*.test.mjs"     # 250/250
node .tmp/probe-021.mjs           # 审核侧探针 8/8（.tmp 已 gitignore）
```

## 9. P2 复验（2026-10-26 01:0x，`2f7e528` + 文档更正 `fe917fe`/`ba3d55a`/`90ca44b`）

**基线**：`90ca44b` 快照（代码 = `2f7e528`，之后 3 条均为文档）；全量 **251/251** ✔；我另跑独立探针 **6/6**。

### P2-1 退化拒层审计：**通过**
- 代码：`WINDOW_REJECT_REASONS = {over-native-runtime, native-uncomputable}`，`window-too-small` 已删（`index.js`）
- 独立实测（W=128k/O=256k + plugin `at=0.5`）：
  - audit **恰 1 条**：`policy-invalid`，`source=plugin`、`code=compact.at`、`reason=native-uncomputable` ✔
  - warn **恰 1 条**：`policy layer rejected at runtime: plugin/compact.at:native-uncomputable` ✔
  - `/cg status` **同一结论**：`policy-invalid: 1 (plugin/compact.at:native-uncomputable)` + `policy: … native=unknown (degenerate)` ✔
  - **三处一致**（audit / warn / status），不是只有审计有 ✔
- 回归：O=16k 的 128k 保守窗口 → 仍落 1 条 `over-native-runtime` ✔；无观察（config 1M/256k）→ 0 条 ✔
- 残留观察（记 **P3-11**）：退化时 `/cg set compact.at` 被拒但**不写审计**（实测 audit 条数不变）；DEC-68 的“设置 at 的层一律拒绝 + 审计”若也覆盖 set 路径需补，否则请文档明确“只对运行时已生效层审计”。
- 残留观察（原 **P3-7** 未修，符合“P3 等 P2 一起处理”）：审计去重 Set 不清空，恢复→再退化不产生第二条审计（实测仍 1 条）。

### P2-2 数字：**主体通过，samples 处理有残留**
- **`0.6934` 不再 0 命中**：`T5`（4 处，含示例行 `native=0.6934 (projection)`）、`README`（1）、`使用说明 v0.3`（3，含 69.34% 与旧版 67.85% 对照）、`samples`（8）、交付报告 §5（3）、STATUS/DECISIONS/G4 均有其位 ✔
- **`0.6785`/`67.85` 只剩“旧版/配置回退”语境**：`T5:63`（“配置窗口只在无观察时回退，得 0.6785”）、`T5:99`（“禁止用常数 0.6785 冒充”）、`README:85/92`、`v0.3:99`（“0.2.0 及更早约 0.6785”）✔
- **历史文件未被改**：`git diff 23dffaf..90ca44b` 中 `docs/review-*`、`docs/M2-需求草案-*`、`DECISIONS.md`、`REQUIREMENTS.md` **无改动**；仅 `STATUS.md` 更新了 0.2.1 当前状态行（0.2.0 历史行保持原样），属活文档追加 ✔
- **交付报告 §5「数字变化」**：0.6785→0.6934（低估 +0.0149）、压力比例高估约 4.86%、0.197→0.188 等齐全 ✔

**新增 P3（samples 处理）**

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| **P3-9** | `analysis/req-20261025-09/samples-0.2.0.txt` | 文件**内容已重生成 0.2.1 形态**，但文件名仍是 0.2.0；`T5:35` 仍写“0.2.0 样例见 samples-0.2.0.txt”；`docs/review-context-governance-0.2.0.md` §2.2/§9 引用它的“第 55–71 行”等行号已失效——**历史证据被覆盖**。**判定：不只是命名问题，建议恢复历史 + 另建新文件** | `git checkout 23dffaf -- analysis/req-20261025-09/samples-0.2.0.txt` 恢复 0.2.0 存档；把新内容另存为 `samples-0.2.1.txt`；更新 `T5:35`、交付报告 §5 的引用；**不要用 0.2.1 内容覆盖 0.2.0 档** |
| **P3-10** | `samples-0.2.0.txt` 第 9–11 行 / `T5` 示例 | 样例自相矛盾：`events=0(no session/event observed yet)` 同时有 `window: current=1M …` 和 `pressure: measured=0.556…`；且同一 mock 在 `T5` 示例是 `adjusted=0.530 ratio=1.42`、samples 是 `0.531/1.41`（小数对不上） | 样例要么把 `events=` 改成与该 fixture 一致的值、要么明确“示意值不与 events 自洽”；`T5` 与 samples 用同一组 mock 数字 |
| **P3-11** | `index.js` `/cg set` 退化拒绝路径 | 退化时 `/cg set compact.at` 报错但不写 `policy-invalid`（实测） | 若 DEC-68 的“设置即审计”覆盖命令路径则补审计；否则在 T5 写明“审计只记录运行时已生效层的拒绝” |

**复验结论**：**P2 清零**（P2-1 三处一致、P2-2 数字与历史边界成立）；samples 的两条新 P3 与原有 P3 一起进入下一批。

## 10. 第二批复验（2026-10-26 01:2x，`2ffa711`/`ed11699`/`4f1409c`）

**基线**：HEAD `4f1409c` 快照；全量 **252/252** ✔；独立探针 `.tmp/probe-021-p311.mjs`（另含样本字节级核对）。

### ① samples 恢复 + 拆分：**通过**
- `samples-0.2.0.txt` 与 `23dffaf` 版**逐字节一致**：我独立算 SHA-256 = `956B988C439C26AA0DAB0B49261519A92371F5A04DB19AFE747F856B061DCF4B`（两侧一致）；`git hash-object` = `0b77ffde…` = `git rev-parse 23dffaf:<path>` ✔
- 第 55–71 行抽查：确实是 `lowThresholdAck` 拒绝 fixture，`review-0.2.0` 的行号引用重新有效 ✔
- 新 `samples-0.2.1.txt`：0.2.1 形态（`window:` 行、`native=0.6934`），`events=42` 与 window/pressure 自洽，首行标注 mock/fixture 且“数字与 T5 同一组” ✔
- 引用：`T5`、`README`、交付报告已改指新文件（`ed11699`）✔

### ② 数字统一：**通过**
- `T5:43` 与 `samples-0.2.1.txt:11` **逐字相同**：`measured=0.556 estimated=0.393 adjusted=0.531(×1.35) effective=0.556 ratio=1.41 window=1M (session 58a2e845)`
- 旧 `0.530`/`ratio=1.42` 在当前事实文档中已无残留 ✔
- 历史文件仍未改（`review-*`、`需求草案-*`、`DECISIONS`、`REQUIREMENTS`）✔

### ③ P3-11（设置即审计）：主行为通过，**但引入 P2-3**
- 退化（W=128k/O=256k）下 `set compact.at=0.5`：error + audit **恰 1 条**（`source=session`/`code=compact.at`/`reason=native-uncomputable`）+ warn + status 可见 ✔
- 成功路径对照：同状态 `set compact.early=off` → success、只写 `policy-set`、`policy-invalid` 不增加 ✔（未误审）
- **P2-3（新）**：拒绝条目被 `push` 进 `policyState.invalid` 且**永不清除**：
  1. 窗口恢复（1M）后 `/cg status` 仍显示 `policy-invalid: 1 (session/compact.at:native-uncomputable)`，`resolve()` 也仍带该条——**违反“W 恢复自动恢复可校验”**
  2. 恢复后再次退化，`set` 拒绝**不再写审计**（`alreadyReported` 读到旧条目；实测新增 0 条），审计跨 episode 永久丢事件
- 修法建议：**不要 push 进 `policyState.invalid`**；用独立的 transient 记录“本 episode 已审计”，窗口恢复时清空；status 若要展示拒绝，用独立字段或随之清除。去重按“episode/用户动作”，不要按“进程内永久的 source|key|reason”。
- **联动（00 2026-10-26 提醒）**：**P3-2 与 P2-3 同类**——`policy show` 的 `session:`/`policy-session:` 读的是原始 `sessionLayer.values`，被拒覆盖仍会显示。复验必须“status + show”一起看，避免“status 干净了但 show 还脏”。
- **两条去重路径都要清**：① `apply` 里的 `windowViolations` Set（P3-7，over-native 运行时审计跨 episode 抑制）；② P3-11 的 `alreadyReported`（读 `policyState.invalid`，P2-3）。只修一处会留下另一半。

### P3-5 已闭环（顺带确认）
`2f7e528` 已把证据 pattern 补全为 `compactNow|compactIfNeeded|compactRegion|ctx\.compaction|serviceFor|agentPresets`，`zero-compaction-grep.txt` 10 行、含 `adapters.js:266`；交付报告 §1 行 6 已更新 → **P3-5 关闭**。

**当前计数**：P1=0 / **P2=1（新 P2-3）** / **P3=7 条**（原 11 条中 P3-5、P3-9、P3-10、P3-11 已闭环；P3-11 的回归转入 P2-3）。

### 对“剩余 P3 随 0.2.1 还是 0.2.2”的建议
- **随 0.2.1 收（6 条）**：P3-1（压力行 fallback 标注）、P3-2（`policy-session` 显示被拒覆盖）、P3-3（生效 at 超 conservative 的提示）、P3-6（非法 window 值不显示 removed）、P3-7（审计去重 Set 清理，**与 P2-3 一起做最省**）、P3-8（无观察 vs 配置退化的文档口径）——均为显示/审计/文档级，不碰引擎，回归面小。
- **拆到 0.2.2（1 条）**：P3-4（`conservative` 全历史 min 的过期语义）——需要先定口径（TTL / `session/end` 清理 / 仅按“活跃会话”），且 0.2.2 才有执行面；0.2.1 先在文档写明“当前为全历史 min”即可。

## 11. 终验（2026-10-26 01:4x，`1b6d054`，9 files 单提交）

**基线**：HEAD `1b6d054` 快照；**258/258** ✔；独立探针 `.tmp/probe-021-final.mjs` **7/7**；工作树干净、ahead 1。

### 四条联动（P2-3 + P3-2 + P3-7）
| 项 | 实测 | 结论 |
|---|---|---|
| ① 退化 `set compact.at` 被拒 | error + audit **恰 1 条**（`source=session`/`code=compact.at`/`reason=native-uncomputable`）+ warn；随后 `set compact.early=off` success 只写 `policy-set`、`policy-invalid` 仍 1 | ✔ |
| ② 恢复 1M 四路干净 | `/cg status` 无 `policy-invalid:`；`resolve().invalid.length===0`；`policy show` 为 `invalid: none`；`session:` 行从 `compact.at=0.6(rejected)` 变回裸 `compact.at=0.6`（`policy-session:` 同） | ✔ |
| ③ 跨 episode 再审计 | 退化拒绝（1 条）→ 恢复 → 再退化 `set` → **再写 1 条（总 2）**；`transientRejections` 在 `!degenerate` 时清空 | ✔ |
| ④ P3-7 第二条去重路径 | **真实 apply + 真实 audit.jsonl**：`1M→128k→1M→128k`（O=16k）→ `over-native-runtime` **恰 2 条** | ✔ |

### 同批 P3（我的独立实测/抽查）
- **P3-1**：无观察时压力行 `window=1M (config-fallback)` ✔
- **P3-2**：退化时 `policy show session:` 与 `policy-session:` 均标 `(rejected)`，恢复后标记消失且值回裸值 ✔
- **P3-3**：plugin 层被拒回落到 builtin `at=0.6 > conservative 0.375` → 新增 `fallback-over-native` 条目（实测）✔
- **P3-6**：非法 `contextWindow`（字符串）→ 保留旧值、不标 removed、`stats.windowInvalidObservations=1` ✔
- **P3-8**：`T5` 双显示例已注 `O=16k 仅为演示，默认 reservedTokens=256000` ✔
- **P3-4**：`T5` 明写“`conservative` 是全历史 min，TTL/session-end/活跃会话口径留 0.2.2”✔（文档约定，非 0.2.1 缺陷）
- **P3-5**：先前 `2f7e528` 已闭环（10 行证据 + 报告行 6）✔

### 计数
**P1=0 / P2=0 / P3=0**（11 条全闭环；P3-4 的 TTL 明确留 0.2.2，属已记录约定）。

### 未验证/边界
1. 真机仍 **0.2.0**，0.2.1 未安装/未重启；真机投影 W=1,048,576、`window:` 双显与退化路径均未上机。
2. 0.2.2 执行面（提前压/`/cg compact now`/G2/G3）未做。
3. `conservative` 全历史 min 的生产影响（多会话/已结束会话）按 P3-4 约定留 0.2.2 处理。

### 发布口径（建议，不代决）
- 分支：本报告随 `feat/context-governance-m1` fast-forward 推送；**不打 tag、不发 Release**（归用户）。
- 0.2.1 复核结论：**P1/P2/P3 全清**；是否上机由用户决定（上机即首次引入窗口层，建议先备份/留回滚点 `b0d6a3e^`）。
- 若发 tag：建议 `v0.2.1` → 本报告提交后的 HEAD；zip 用 `git archive`。

## 12. 真机验证发现（2026-10-26 17:0x，P2-4）：重启后窗口层 dormant

**背景**：0.2.1 于 `16:58:54.389Z` 重启加载（`apply version=0.2.1`，pid 23760；`capability@ready` 探针含 `get.sessionProjections=obj`）。真机 `/cg status` 实际输出：

```
policy: compact.at=0.60 (source=builtin) native=0.6785 (config-fallback) early=on
window: current=unknown source=config-fallback conservative=unknown native-current=0.6785 (config-fallback) native-conservative=- unvalidated (at 允许但未经窗口校验)
pressure: measured=0.563 estimated=0.393 adjusted=0.531(×1.35) effective=0.563 ratio=1.43 window=1M (config-fallback) at=0.60 effective<at
```

`/cg policy show`：`native=0.6785 (config-fallback)`、`layers: plugin (empty) -> project (empty) -> session (empty)`、`invalid: none`。

### 12.1 事实：宿主只按需追加 `request/context`
- 宿主源码（asar `@deepseek-ai/dsh-agent-loop/lib/index.js`）：仅当 `provider` / `model` / `contextWindow` / `systemPromptUpdate` 任一变化时才 `session.append("request/context", requestContext)`；**同路由的普通消息不追加**。
- 我解了 6 个本项目会话的 `request/context` 时间戳：**最新 `16:25:19.165Z`，全部早于 `16:58:54.389Z` 重启**；重启后 `events=220` 只有其它事件，没有新的 `request/context`。
- 结论：`current=unknown` 不是“还没等到消息”，而是**既有会话在路由不变时不会再产生 `request/context`**，未知可能长期持续。

### 12.2 影响
- `window=projection` 可能**永不出现**（主会话不改路由/不新建会话的前提下）；
- `native` 长期 `0.6785 (config-fallback)`，压力分母长期 `1,000,000`（真机实际窗口 `1,048,576`，比例高估约 4.86%）；
- **0.2.1 的窗口层在重启后的既有会话里实际 dormant**；0.2.2 的提前压执行面依赖窗口，同样会“看不见窗口”。
- 这是**覆盖缺口（P2-4），不是与已实现规格冲突的 bug**：规格只要求“观察事件”，未要求回填。

### 12.3 修法建议（待 00 派单）
- 首次收到某会话的任一事件时，用 `ctx.get('sessionProjections').stateOf(session, 'contextPressure')` 读历史 `contextWindow` 回填（G4 已证明 `stateOf` 可读到该字段；`materialize` 成本按会话一次可接受）；
- 取用前 `Number.isInteger(W) && W > 0`；来源标 `projection`，`observedAt` 记回填时刻（或注明 backfilled）；
- 备选：`session.requestContext()`（若在插件侧可达）；不硬 inject。
- 回填成功前维持现有 config-fallback 行为（安全，但不展示真实窗口）。

### 12.4 验证方式（已与 00 对齐）
- **新建一个 `DSH插件开发` 工作区会话**（首次请求必发 `request/context`），发一条消息后在该会话执行 `/cg status`：应见 `window: current=1M (session …) source=projection`、`native=0.6934`、`pressure … window=1M`；
- 或切换模型/路由触发 `request/context`；
- 真机现有输出中 `pressure window=1M (config-fallback)` 与 `native (config-fallback)` 同源一致，P3-1 标注在真机生效。

**当前计数更新**：P1=0 / **P2=1（P2-4 覆盖缺口）** / P3=0。0.2.1 未打 tag，回填小修后需按 12.4 重新验收窗口层。

## 13. 回填终验（2026-10-26 17:2x，`9e9a593`，263/263）

**基线**：`9e9a593` 快照 **263/263** ✔；独立探针 `.tmp/probe-021-backfill.mjs` **9/9**；工作树干净。

### 五条验收（独立实测）
| # | 验收点 | 实测 | 结论 |
|---|---|---|---|
| 1 | 既有会话回填：`projection(backfilled)`、`observedAt=历史时间`、native 0.6934、validated | 首事件后 `window: current=1M (session aaaaaaaa) observed 2026-10-25T03:30:05.241Z source=projection(backfilled) … native-current=0.6934(projection) native-conservative=0.6934 validated`；`policy:` 行 `native=0.6934 (projection(backfilled))`；`resolve().window.native===0.6934` | ✔ |
| 2 | 实时优先 | 回填后喂真 `request/context` → `windowState.source='projection'`、`observedAt` 更新为非历史时间、`stateOf` 未再调用 | ✔ |
| 3 | 反伪造（4 组） | `stateOf={}` → 仍 `unknown`；`'1M'/0/-5` → 不回填且 `windowInvalidObservations` 计数；有 W 无历史事件 → `observedAt=null`（不造时间） | ✔ |
| 4 | 每会话一次 / 晚到重试 | 2 次事件 `stateOf` 只调 1 次；服务首次不可用 → 下一事件重试并回填（仍只 1 次） | ✔ |
| 5 | 标注可辨 | `window:` 行 `source=projection(backfilled)` + `observed <历史 ISO>`；`policy:` 行 `(projection(backfilled))` | ✔（有两处小瑕疵，见 P3-12/13） |

### 回归
- 263/263 含删除语义、退化 A、跨 episode 审计、零压缩 spy；`#backfillWindow` 在 `#belongsToProject` 过滤之后调用（我造了别项目会话用例：`stateOf` 0 次、不回填）✔
- `observedAt` 取 `session.ownEvents()` 里最后一条带合法 `contextWindow` 的 `request/context` 的 `time`；日志不可读时记 `null`，**不造时间**（与开发选择一致）✔

### 新增 P3（标注，建议级）
| 编号 | 位置 | 现象 | 建议 |
|---|---|---|---|
| **P3-12** | `summarizeWindow` 的 `native-current` | 回填时显示 `native-current=0.6934(projection)`，回填标记在 `native-current` 上丢失（`window:` 的 `source=` 和 `policy:` 行仍带 `projection(backfilled)`） | `native-current` 的括注也用 `currentSource`（可显示 `projection(backfilled)`） |
| **P3-13** | `summarizePressure` 的 `window=` | 压力行只显示 `window=1M (session …)`，无 source 标注（live/backfilled/config-fallback 都不带） | 有 `windowSource` 时在压力行也带上（如 `window=1M (session …, backfilled)`），与 `window:` 行一致 |

> 两条均为可读性，不影响来源判读（`window:` 行的 `source=` 已是权威依据）；是否在 0.2.1 修由 00 定。

### 真机验证（待重启）
当前真机仍加载 `1b6d054`（无回填）；重启加载 `9e9a593` 后预期：
- 既有会话首个事件即回填：`window: current=1M (session …) observed <历史 request/context 时间> source=projection(backfilled)`、`native=0.6934`、`pressure … window=1M`；
- 新建会话：真实 `request/context` → `source=projection`（实时），`observedAt` 为观察时间。

**计数更新**：P1=0 / **P2=0**（P2-4 回填闭环）/ **P3=2**（P3-12/13，标注建议级）。

## 14. P3-12/13 复验（2026-10-26 01:1x，`4af1dc2`，264/264）

**基线**：`4af1dc2` 快照 **264/264** ✔；独立探针：三来源标注 **15/15**、回归三组 **8/8 + 6/6 + 7/7**；工作树干净。

### 三来源标注（逐字实测）
| 来源 | `window:` 行 | `policy:` 行 | `pressure:` 行 |
|---|---|---|---|
| **回填** | `source=projection(backfilled)` + `native-current=0.6934(projection(backfilled))` | `native=0.6934 (projection(backfilled))` | `window=1M (session 58a2e845, backfilled)` |
| **实时** | `source=projection` + `native-current=0.6934(projection)`（无 backfilled） | `native=0.6934 (projection)` | `window=1M (session aaaaaaaa)`（无 backfilled） |
| **回退** | `source=config-fallback` + `native-current=0.6785(config-fallback)` | `native=0.6785 (config-fallback)` | `window=1M (config-fallback)` |

- **P3-12 闭环**：`native-current` 用完整 `currentSource`（不再折叠成 `projection`）——回填场景同行两字段都带 `backfilled`，无同行矛盾；实时/回退各自只有一种写法。
- **P3-13 闭环**：`pressure` 行有 session 时按来源写 `(session …, backfilled)` / `(session …)`；无 session 且回退写 `(config-fallback)`；**每行恰好一套括注**（实测 `backfilled`/`config-fallback` 各只出现 1 次）；实时行 `doesNotMatch /backfilled/`。
- 代码：`summarizeWindow` 的 `nativeSource` 改为完整 `currentSource`；`summarizePressure` 按来源拼单套后缀。

### 回归（独立探针，非只跑仓库测试）
- 窗口观察/删除/1M+128k 同源/退化 A/无观察/运行时审计/零压缩 spy：**8/8**
- P2-1 退化审计三路径（audit/warn/status、over-native 回归、无观察 0 条）：**6/6**
- 四条联动（退化 set 审计、恢复四路干净、跨 episode、P3-7 真实 apply 2 条）：**7/7**
- `stateOf` 每会话一次：仓库 `window-021` 用例覆盖（264/264 通过）；我的回填探针也断言“2 事件只调 1 次”。

### 真机重启后验收（待执行）
- 既有会话 → `window: current=1M (session …) observed <该会话历史 request/context 时间> source=projection(backfilled)`、`native=0.6934`、`pressure … window=1M (session …, backfilled)`；`observed` 我会与日志时间戳逐条比对。
- 新建会话 → `source=projection`（实时，不带 backfilled）。

**计数更新**：**P1=0 / P2=0 / P3=0**（P3-12/13 闭环）。0.2.1 代码层复核全部收口；剩余为真机重启验证。

## 15. 真机回填未触发：根因与修复建议（2026-10-26 17:1x，P2-5）

**真机事实**（0.2.1 + 回填，`apply` pid 18040 @ `17:10:49.606Z`；`capability@ready` @ `17:11:05.959Z`）：
- `capability` 探针：**`sessionProjections=throws`**、`get.sessionProjections=obj`
- `/cg status`（`time=17:11:57.698Z`）：`window: current=unknown source=config-fallback`、`native=0.6785 (config-fallback)`、`events=30`
- 重启后**没有任何新的 `request/context`**（我逐会话解日志比对），所以这里本应走 backfill，实际没有。

**三处排查（00 提的）**
1. **回填触发条件**：`#backfillWindow(session)` 在事件处理器里、`#belongsToProject` 过滤之后、**每个事件**（含 `user/message`）都会调用；不按事件类型限制。**触发条件没问题。**
2. **`#lastSession`**：`this.#lastSession = session` 在**每个事件**更新（`runtime.js:1408`），不等 `request/context`。`current=unknown` 不是 lastSession 没更新，而是 `#windows` 里没有该会话条目（回填失败）。**00 的假设（lastSession 只在 request/context 更新）不成立。**
3. **`stateOf`/`ownEvents()` 是否被调用**：**没有**。根因在服务获取：

```js
// 现行 #getSessionProjections（runtime.js:611-620）
const service = this.#ctx?.sessionProjections        // ← 真机这里抛错
  ?? (typeof this.#ctx?.get === 'function' ? this.#ctx.get('sessionProjections') : null)
  ?? null;
```

`??` 整条链在**同一个 try** 里：`this.#ctx?.sessionProjections` 的 getter 抛错 → 直接进 catch → 返回 null。**`ctx.get('sessionProjections')` 永远不会被执行**；又因 `projections === null` 时 `#backfillWindow` 提前 return（不加 `#windowBackfillAttempted`），每个事件都重试、每次都同样失败。

**我按真机形态复现（同一快照代码）**
- `ctx` 上 `sessionProjections` 是**抛错的 getter**、`ctx.get('sessionProjections')` 正常返回服务 → 喂 `user/message` 后：`windowState.current=null`、`source=unknown`、**`stateOf` 调用 0 次**（与真机完全一致）
- 对照：属性为 `undefined`（单测 mock 的形态）→ 回填成功：`current=1048576`、`source=projection(backfilled)`、`stateOf` 1 次

**结论（P2-5，应修）**：回填在真机**功能性未生效**；单测 264/264 通过是因为 mock 的 `ctx` 没有“属性抛错”形态。00 记的 `ART-20261025-108`（代码层通过 ≠ 真机生效）成立。

**修复建议**
1. `#getSessionProjections` 改为 **`ctx.get('sessionProjections')` 优先**，或两条取法**各自 try**（属性抛错后仍尝试 `ctx.get`）；成功才缓存。
2. 同模式的 `#getTokenMeter` 一并审（`tokenMeter` 真机也是 `property=throws`，只是它另有 `#tryInjectTokenMeter` 路径兜底；`sessionProjections` 没有 inject 路径）。
3. **补真机形态单测**：`ctx` 上目标服务是**抛错 getter** + `ctx.get` 返回服务，断言回填成功、`stateOf` 1 次；现有 mock（属性 undefined）不能覆盖真机。
4. （可选）`#backfillWindow` 失败时区分“服务取不到”与“state 无窗口”，前者不消耗 attempted（现状），后者消耗——现逻辑对，但建议加日志便于真机诊断。

**计数更新**：P1=0 / **P2=1（P2-5）** / P3=0。§13/§14 的回填验收结论**仅在 mock 形态下成立**；真机需在修复后重验（既有会话 `observed=历史时间`、`projection(backfilled)`、`native=0.6934`）。

## 16. P2-5 复验（2026-10-26 17:3x，`7e5786a`，267/267）

**基线**：`7e5786a` 快照 **267/267** ✔；独立探针 `.tmp/probe-021-p25.mjs` **6/6**；提交范围仅 `runtime.js` + `window-021.test.mjs`。

### 两处重点
**1. 新单测是否真跑在“抛错 getter”形态（不是 undefined）**：✔
- `window-021.test.mjs:714` 用 `Object.defineProperty(ctx,'sessionProjections',{get(){throw}})` + `ctx.get` 返回服务 → 断言回填成功、`stateOf` 1 次；
- `:739` 同形态覆盖 `tokenMeter`（属性抛错 + `ctx.get` 可读 → `estimatedTokens=400_000`）；
- 我的独立探针用同一形态复核（未复用开发 mock）：**A/D 通过**；此前旧代码在该形态下 `stateOf` 0 次（§15 复现），现为 1 次。

**2. “成功才缓存”是否只在两条路都失败后才不缓存**：✔
- **B**：首次属性抛错 + `ctx.get` 不可用 → 不回填；服务就绪后**下一事件重试成功**、`stateOf` 1 次（没有“永久不可用”标记）。
- **C**：属性抛错 + `ctx.get` 也抛错 → 不崩溃；恢复后重试成功。
- **F**：属性正常时直取服务（不额外走 `ctx.get`），回填成功。
- 代码：`#getSessionProjections`/`#getTokenMeter` 均为“direct try → get try → 成功才赋值 `#...` → 失败 `return null`”，不再共用 `??` 链。

**3. 诊断四类（开发只测了 2 类，我补测全部）**：
`sessionProjections-unavailable`、`stateOf-threw`、`contextWindow-absent`、`contextWindow-invalid` 各打 1 条（每会话每原因去重），实测四类齐全且不重复。

### 回归
267/267（264 + 3 条 P2-5 新测）；窗口观察/删除/退化 A/跨 episode 审计/零压缩 spy/回填五条/标注三来源均未回归（前述探针在 `4af1dc2` 版本全过，本批只改服务取法，未触及行为分支）。

### 真机重启后验收（预期）
- 既有会话（`5d1121ed`）：`window: current=1M (session 5d1121ed) observed 2026-10-25T03:30:05.263Z source=projection(backfilled) … native-current=0.6934(projection(backfilled))`；`pressure … window=1M (session 5d1121ed, backfilled)`；`policy: … native=0.6934 (projection(backfilled))`
- 你的会话（`58a2e845`）：同上，`observed=2026-10-25T03:30:05.241Z`
- 新建会话：`source=projection`（实时）

**计数**：**P1=0 / P2=0 / P3=0**。0.2.1 代码层与真机根因均已收口；剩余为重启后的真机读数确认。

## 17. 真机生效确认（2026-10-26 17:2x，`ART-20261025-114`）

**真机**：`apply version=0.2.1` pid 32368 @ `17:17:08.762Z`；`capability@ready` @ `17:17:23.890Z`。读数（`17:20` 前后）：

```
policy:   compact.at=0.60 (source=builtin) native=0.6934 (projection(backfilled)) early=on
window:   current=1M (session 58a2e845) observed 2026-10-25T03:30:05.241Z source=projection(backfilled)
          conservative=1M (session 5d1121ed) native-current=0.6934(projection(backfilled))
          native-conservative=0.6934 validated
pressure: … window=1M (session 58a2e845, backfilled) at=0.60 effective<at
compression: … events=49 …
```

### 逐字核对（我解会话日志，独立于读数）
- `session-58a2e845`：13,543 帧全部解压成功，**唯一一条** `request/context`：`seq=15`、`time=1792899005241` → **`2026-10-25T03:30:05.241Z`**、`contextWindow=1048576`。与真机 `observed` **逐字一致** ✔
- `session-5d1121ed`：`request/context seq=15` → `2026-10-25T03:30:05.263Z`、`contextWindow=1048576`，与 conservative 条目一致 ✔
- 回填值与历史事件同源，**`observedAt` 不是回填时刻**（本次读数时间约 `17:20Z`，差 14 小时）✔

### 真机同时验证
- **P2-5 修复生效**：属性 getter 抛错的真机形态下 `ctx.get` 被正确使用 → `current` 出现、`source=projection(backfilled)` ✔
- **P3-12/13 真机验证**：`native-current=0.6934(projection(backfilled))`（不漏 backfilled）、`pressure … window=1M (session 58a2e845, backfilled)` ✔
- `native=0.6934`（不是 0.6785）、`validated`、双显 current/conservative 均符合契约 ✔
- `events=49`、`ignored-foreign=53/1`：过滤与计数正常（1 个 G 盘会话的 53 条事件被忽略）✔

### 结论
**0.2.1 复核全部收口：P1=0 / P2=0 / P3=0**；真机窗口层（回填/动态 native/双显/退化/审计/零压缩）已验证生效。

### 发布建议（不代决）
- tag 建议 **`v0.2.1` → 本报告提交后的 HEAD**；zip 用 `git archive` 生成（控制字符闸只扫 tracked）。
- 回滚点：0.2.0 状态（`e6d859b` 代码线 / `b0d6a3e^`）；真机当前已是 0.2.1（未打 tag）。
- 已知留待 0.2.2：`conservative` 全历史 min 的 TTL/`session/end` 口径（P3-4 已记）；执行面（提前压/`/cg compact now`/G2/G3）未做。
