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

- **阻断（P1）：0**；**应修（P2）：1**（新 P2-3：P3-11 修复引入的陈旧 invalid/审计跨 episode 丢失；P2-1/P2-2 仍闭环）；**建议（P3）：7**（原 11 条中 P3-5/9/10/11 已闭环）。
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

### P3-5 已闭环（顺带确认）
`2f7e528` 已把证据 pattern 补全为 `compactNow|compactIfNeeded|compactRegion|ctx\.compaction|serviceFor|agentPresets`，`zero-compaction-grep.txt` 10 行、含 `adapters.js:266`；交付报告 §1 行 6 已更新 → **P3-5 关闭**。

**当前计数**：P1=0 / **P2=1（新 P2-3）** / **P3=7 条**（原 11 条中 P3-5、P3-9、P3-10、P3-11 已闭环；P3-11 的回归转入 P2-3）。

### 对“剩余 P3 随 0.2.1 还是 0.2.2”的建议
- **随 0.2.1 收（6 条）**：P3-1（压力行 fallback 标注）、P3-2（`policy-session` 显示被拒覆盖）、P3-3（生效 at 超 conservative 的提示）、P3-6（非法 window 值不显示 removed）、P3-7（审计去重 Set 清理，**与 P2-3 一起做最省**）、P3-8（无观察 vs 配置退化的文档口径）——均为显示/审计/文档级，不碰引擎，回归面小。
- **拆到 0.2.2（1 条）**：P3-4（`conservative` 全历史 min 的过期语义）——需要先定口径（TTL / `session/end` 清理 / 仅按“活跃会话”），且 0.2.2 才有执行面；0.2.1 先在文档写明“当前为全历史 min”即可。
