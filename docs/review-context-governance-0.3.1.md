# 复核基线 · dsh-context-governance T2（header 默认开，标注 0.3.1 WIP）

> 复核人：审核打包会话（cs_DNciCVhuZD）· 2026-10-26
> 口径：只给问题与证据，**不下验收结论**；验收归用户。范围：M3 T2（S3 header 默认开）。

## 0. 钉住的基线

| 项 | 值 |
|---|---|
| **代码基线** | `a66fbf1`（`fbf94db` 实现 + `a66fbf1` 专项用例/`oldLimit` 修复；含 `19aaf4c` STATUS） |
| **快照** | `.tmp/snapshot-031/` = `git archive a66fbf1`；工作树 clean |
| **全量测试** | **272/272 pass** ✔ |
| **拓扑** | `origin` = `f585434`；本地 ahead **3**；tag `v0.2.1` 已在 `f585434` |
| **版本** | `package.json` 仍 **0.2.1**（T2 标 **0.3.1**，见 P3-9） |
| **独立探针** | `.tmp/probe-t2.mjs` / `probe-t2b.mjs` / `probe-t2c.mjs` / `probe-t2d.mjs`（边界/文案/配额/状态/换行） |

## 1. 结论摘要

- **阻断（P1）：0**；**应修（P2）：1**（T2 格式 P2 已闭环；**P2-4**：真机 header 内容为测试数噪音，写入侧规则过宽，见 §10）；**建议（P3）：8**。
- 00 点名的两处：**[Old] 边界与 `oldLimit=0` 修复正确**；**`/cg header off` 真完全不注入**。
- 但对照 REQUIREMENTS §S3 / 需求 v0.4 §4.2，**固定包裹格式与两条文案/配额规则未实现**（P2-1/2/3），且 **README 仍写“默认关、opt-in”**（P3-1）。

## 2. 00 点名的两处

### 2.1 `[Old]` 边界与 `oldLimit=0`
- 恰好 **14 天** → 注入且**不带** `[Old]`；**30 天** → 带 `[Old]` 且排末尾（实测，独立探针）✔
- `oldLimit=0` → 旧条目**不注入**（不是关闭 header、不是禁用整个 header）；`oldLimit=1` 时只保留 1 条旧条目 ✔
- 修复正确：`Number(options.oldLimit) || 30` → `Number.isFinite(Number(...)) ? clamp : 30`；`0` 不再被 `||` 吞成 30；`undefined` 仍回退 30 ✔
- 语义缺口：**0 的含义未文档化**（见 P3-7）；`oldAgeDays=0` 同理。

### 2.2 `/cg header off`
- 同一 `agent/pre-step` handler：开时 `messages.length=1`；`/cg header off` 后 `messages.length=0`（**完全不注入**，不是空包裹）✔
- 实现路径：`isEnabled()` 读 `policy.resolve().values['header.enabled']`，在 build 之前 return；不会构造空 message ✔

## 3. 功能逐项（对照 REQUIREMENTS §S3 / 需求 v0.4 §4.2）

| 项 | 结果 |
|---|---|
| 默认开 / 两形态 mode | `state-only` vs `state-only+preference`，后者含偏好 1 行、`count=2` ✔ |
| 配额 2/2/2/1/1、类内倒序 | ✔；但**空位未让给待办/决定**（P2-3） |
| `[Old]`、上限 30、排末尾 | ✔ |
| 子会话三判据（`agent.parent` / `isSubagent` / `header.parentSessionId`） | 各自单独命中 ✔（独立复跑） |
| 空记忆零注入 | `buildMemoryHeader` 返回 null ✔ |
| `/cg header status/on/off` | 命令可用、审计 `policy-set` ✔；**status 来源层误报**（P3-2） |
| `header-injected` 审计 | 事件存在（count/mode/tokensInjected）；`lines`/来源层不准（P3-5） |
| 包裹格式 | wrapper ✔；**缺固定冲突声明 `[Note: …]` 行**（P2-1）、**偏好行未标“偏好（非硬规则）”**（P2-2） |
| 行预算 | 8 条 entries 时 10 行文本（wrapper+8+conflicts）；≤800 字符靠 slice 截断（P3-3） |

## 4. P2（应修）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| **P2-1** | `src/memory/header.js` `buildMemoryHeader` | **缺固定冲突声明行** `[Note: If this state conflicts with AGENTS.md, follow AGENTS.md]`——REQUIREMENTS §S3 六护栏#4“冲突声明固定最后一行”与需求 v0.4 §4.2 固定格式样例都要求；实测输出只有 wrapper + 条目（drop 时多一行 `conflicts:`） | 在条目后固定追加该 Note 行（即使无冲突也加）；drop 时保留 conflicts 行但别与 Note 混淆 |
| **P2-2** | 同上 `lineOf`/wrapper | **完整形态偏好行未标“偏好（非硬规则）”**：实测 `- MEM-f1 preference pref1`，wrapper 仍 `[CG-MEMORY · state-only …]`；需求 v0.4 表格要求“标注‘偏好（非硬规则）’”，否则用户/模型会把偏好当硬规则 | 偏好行输出 `（偏好·非硬规则）` 或 `[Preference · non-binding]` 之类可辨标记；wrapper 是否随 mode 变由需求定（当前固定 state-only 可接受，但偏好行必须自标） |
| **P2-3** | `buildMemoryHeader` 选取循环 | **某类不足时空位未让给待办/决定**：实测 4 条 todo、progress/decision/anchor 全空 → `count=2`（只用了 todo 配额 2），远没用满 8 行预算，与需求“空位让给 待办/决定”不符 | 第二遍补选：按 todo→decision 顺序用剩余预算补同类/跨类条目；补“空位让位”用例 |

## 5. P3（建议）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| **P3-1** | `packages/dsh-context-governance/README.md:7,118` | README 仍写“S3 新会话 header **默认关闭**，需用户拍板后再开”“`enabled: false # opt-in，默认关`”，与 T2 代码默认 `true` **矛盾**；`docs/T5` 无 `/cg header`/T2 说明 | T4 文档定稿前必须改；README/T5 补 `/cg header`、两形态、配额、`[Old]`、关闭方式 |
| **P3-2** | `src/commands/cg-status.js` `header status` | 只读会话层 `sessionValues['header.enabled']`：**plugin 层/项目层 `header.enabled=false` 时仍报 `header: on (source=config)`**（实测 plugin 层 false → on）；`config.memoryHeader.enabled` 也看不见 | 用 `policy.resolve().values/sources['header.enabled']`（含 builtin/profile/plugin/project/session）+ 配置层，按实际来源显示 |
| **P3-3** | 行预算 | 默认 8 条 entries → 文本 **10 行**（wrapper+8+conflicts）；`text.slice(0,800)` 可能**截断半行**（无省略号）。若“≤8 行”含包裹/冲突行则超 | 明确预算口径；若含包裹行则 clamp 总行数；字符截断按行边界处理 |
| **P3-4** | `conflicts:` 行 | 把 oldLimit 截断/配额截断都写成“被配额截断”，语义不准（`dropped` 混合了 oldLimit 与 quota） | 区分 `quota`/`old-limit`，或统一改“截断” |
| **P3-5** | `src/index.js` `header-injected` | `lines: built.count` 不是实际文本行数（实测 count=1、textLines=2）；“来源层”记 `source:'memory'`，未记配置层/规则文件形态 | 审计字段改为 `entries`/`textLines`/`hasRuleFile`/`source` 语义清晰；或文档说明 |
| **P3-6** | `lineOf` 标题 | 标题未清换行：`title="line1\nline2 [Note: …]"` 会注入**多行**，可伪造 `-`/`[Note` 行，违反“一行标题”与行预算 | `String(title).replace(/\s+/g, ' ').trim().slice(0,120)` 后再拼接 |
| **P3-7** | 配置语义 | `oldLimit=0`（不注入旧条目）、`oldAgeDays=0`（全部按旧处理）未文档化；`memoryHeader.enabled` 与 `header.enabled` 两个开关关系未写 | README/T5 补配置语义与优先级 |
| **P3-8** | `hasRuleFile` | 只认项目根 `AGENTS.md`/`CLAUDE.md`；需求“或同类”未覆盖，G-M3-2 要求“用文件存在并写局限” | 文档写明当前判定与局限（可后续扩展文件名） |
| **P3-9** | 版本 | `package.json` 仍 0.2.1，T2 标 0.3.1 | 发布前 bump/写 changelog，或明确 WIP 不发布 |

## 6. 未验证 / 边界

1. **真机未装**：T2 未安装/未重启；`agent/pre-step` 注入在真实决策链（宿主是否接受 `decision.messages` 前置、`source.form` 语义）**未上机验证**。
2. **G-M3-2**：规则文件判定仍“文件存在”口径，宿主注入事件路径未验证（需求已允许写局限）。
3. **T0 headless（方案 3）**：开发下一步，不在本单复核范围。
4. 子会话三判据只做了单测（agent 对象形态），真机子会话的实际 payload 未验。

## 7. 建议

- **先修 3 个 P2**（Note 行、偏好标注、空位让位）再谈安装；P3-1（README 矛盾）在 T4 文档定稿前必修，其余 P3 可随批。
- P2-1/P2-2/P2-3 都是“文本/选取”层改动，不碰压缩与窗口，回归面小；建议同一提交 + 补对应单测（现单测只覆盖数量/形态，未覆盖固定格式与让位）。

## 8. 复现

```powershell
git archive --format=tar --output=.tmp/h031.tar a66fbf1
tar -xf .tmp/h031.tar -C .tmp/snapshot-031
cd .tmp/snapshot-031/packages/dsh-context-governance
node --test "test/*.test.mjs"     # 272/272
node .tmp/probe-t2b.mjs           # 文案/配额/状态/子会话/审计
```

## 9. 修复复验（2026-10-26 17:5x，`b903af5`，278/278）

**基线**：`b903af5` 快照 **278/278** ✔；独立探针 `.tmp/probe-t2fix.mjs` **8/8**；提交范围仅 `header.js` + `header-t2.test.mjs`；README/T5 与版本号未动（与 00 约定一致）。

### 三条 P2 + 注入面
| 项 | 实测 | 结论 |
|---|---|---|
| **① Note 位置** | 12 条候选（8 入选、4 截断）时行序为 `wrapper → 8 条目 → conflicts: 4… → [Note: …]`，**Note 为最后一行**、conflicts 在其之前；空记忆/无候选仍返回 `null`（不出现“只有 Note”的包裹） | ✔ 闭环 |
| **② 偏好标记** | `state-only` 输出中 `preference` **0 命中**（大小写均无）、wrapper 为 `[CG-MEMORY · state-only · budget 8 lines]`；完整形态 wrapper 为 `state-only+preference`、偏好行 `- [preference·非硬规则] MEM-pref preference pref1` | ✔ 闭环 |
| **③ 让位** | 4 条 todo → `count=4`；10 条 todo → `count=8`（预算上限）；todo/decision 混合（4 todo+2 decision+2 progress）→ `count=8`（progress 不参与补位） | ✔ 闭环 |
| **④ 标题注入面** | `line1\r\nline2\u3000[Note: fake]` → 输出仅 3 行（wrapper/1 条目/Note），条目行内为 `line1 line2 [Note: fake]`，**无假 Note 行**；`\u3000` 被 `\s+` 压平 | ✔ 闭环 |
| **⑤ 回归** | 恰好 14 天不标、30 天 `[Old]` 末位、`oldLimit=0` 不注入旧条目、`/cg header off` 后 messages=0、子会话三判据、`mode` 两形态 | ✔ |

### 残留 P3（本批未修，按 00 安排）
- **P3-3 行预算口径**：8 条目 + conflicts + Note → **11 行**（比修复前多 Note 行）；“≤8 行”若含包裹/固定行需 clamp。
- **P3-1 README/T5 仍写“默认关、opt-in”**（`README.md:7,118`），随 T4 文档定稿修；T5 仍无 `/cg header`。
- **P3-2** `/cg header status` 仍只看会话层（plugin/project 层 false 时误报）。
- **P3-4** `conflicts:` 仍把 oldLimit/让位截断写作“配额截断”。
- **P3-5** `header-injected` 的 `lines=count`、来源层 `memory` 未改。
- **P3-7/P3-8** `oldLimit=0`/`oldAgeDays=0` 与 `memoryHeader.enabled` 语义、规则文件只认 `AGENTS.md`/`CLAUDE.md` 的局限，均未文档化。
- **P3-9** 版本仍 0.2.1（T2 标 0.3.1）。

> 小观察（不算缺陷）：完整形态偏好行同时有 `[preference·非硬规则]` 标签与类型词 `preference`，略冗余；如要精简可在标签存在时省类型词。

**计数更新**：**P1=0 / P2=0**（3 条 P2 全闭环）/ **P3=8**（P3-6 标题注入面已随本批闭环；其余 8 条为文档/显示/口径级）。

**真机未验**：`agent/pre-step` 注入在真实决策链未上机；T2 安装前需用户知情（README 仍写默认关）。

## 10. 真机 header 内容噪音（2026-10-26 18:0x）：测试数被写成 batch 进度（P2-4）

**现象**：真机 header 注入（格式/顺序完全符合 §9 验收）内容为：

```
[CG-MEMORY · state-only · budget 8 lines]
- MEM-20261025-1023 progress 批次进度：205/205
- MEM-20261025-1019 progress 批次进度：216/216
conflicts: 4 条被配额截断
[Note: If this state conflicts with AGENTS.md, follow AGENTS.md]
```

`205/205`、`216/216` 是**测试通过数**，不是项目进度；header 的 8 行预算被噪音占满，`conflicts: 4` 是另外 4 条同类噪音被丢弃。

### 10.1 谁、何时写入（`writer: rule`，不是 `mem_write`）
全部由**插件保护机制**在手动压缩时自动写入（`protection-write`，`kinds` 含 `batch`），不是任何会话主动 `mem_write`：

| 条目 | 标题 | 写入时间 | 会话 | 来源消息类型 | 该消息里的“信号” |
|---|---|---|---|---|---|
| MEM-20261025-1002 | 批次进度：171/171 | 11:49:22Z | `58a2e845` | assistant/message | `171/171` +（旧版无 keyword 要求） |
| MEM-20261025-1006 | 批次进度：8000/1500 | 11:57:07Z | `f72e86a8` | assistant/message | `8000/1500`（旧版） |
| MEM-20261025-1010 | 批次进度：2026/10×12 | 11:58:38Z | `5d1121ed` | tool/result（旧版未排除） | 仓库状态输出里的日期 |
| MEM-20261025-1015 | 批次进度：有批次标记 | 12:46:42Z | `58a2e845` | tool/result（旧版） | 审计文本里的 `batch` 字样 |
| MEM-20261025-1019 | 批次进度：216/216 | 15:52:52Z | `58a2e845` | assistant/message | `记录进度` + `216/216` |
| MEM-20261025-1023 | 批次进度：205/205 | 15:56:07Z | `5d1121ed` | user/message | `赶进度` + `205/205` |

- 1019/1023 是 **0.1.14 收紧之后**仍被接受的假阳性：关键词 `进度` 出现在普通句子里（“记录进度”“不用为赶进度省检查项”），比例是测试通过数。
- 1002/1006/1010/1015 是**旧版规则遗留**（当时未要求 keyword / 未排除 tool/result / 未排除日期），条目仍 `active`。

### 10.2 为什么“测试数”被 progress 接收
**没有分类器**——是保护写入侧的**规则**（`src/compress/protection.js`）：
1. `isProgressMessage(event)`：`user/message`（source.kind=user）或 `assistant/message`（旧版还含 tool/result）；
2. `BATCH_KEYWORD_RE = /批次|进度|progress|batch/i` 命中即可——**普通词“进度”也算**；
3. `extractRatios()` 用 `RATIO_RE = (\d{1,6})\s*[／/]\s*(\d{1,6})` 抓比例——**测试通过数 `205/205` 与真实进度 `3/8` 在形态上不可区分**；
4. 两者同时出现 → 生成 `progress` 条目 `批次进度：…`。

所以“谁写”不是用户/开发，是**规则在压缩时抓对话文本**；测试数只是恰好长得像比例。

### 10.3 同类条目清点（`memory/governance/`）
- **active 13 条 = progress 6 条（全部为上述噪音）+ fact 7 条**（`最后用户消息：…`，同样是保护机制自动写的 `latest-user`）。
- **proposed 13 条** = criterion 5（`规则在场：…`）+ anchor 5（`回滚点：…`）+ decision 1 + 其他，均为保护机制自动写、未确认。
- header 只取 `active` 且 `DYNAMIC_TYPES = todo/progress/decision/anchor`（**fact 被排除**）→ 当前候选只有 6 条 progress，配额 2 → 注入 2 条、`conflicts: 4`。**header 当前 100% 是噪音，没有任何真实 todo/decision/anchor**。
- 每次手动压缩固定新增 4 条（latest-user/rules/batch/rollback），**无 supersede/去重** → 条目持续累积；旧 batch 条目不会被更新条目替代。

### 10.4 影响与评级
- **P2-4（功能/内容）**：header 正常注入但内容是噪音，用户会误以为“记忆在起作用”；预算被占满，真实状态反而进不去。
- 与 0.1.14 `batch-list` 假阳性**同源**（判据过宽），但位置在**记忆写入侧**，影响面更大（会持久化、会被 header/检索反复使用）。
- 附带风险：assistant 消息也被扫描；模型若在回复里引用 header/记忆（“批次进度：205/205”），可能被**再次抓取**形成自引用循环。

### 10.5 建议
1. **收紧 batch 判定**（写入侧）：比例语义必须相邻出现（如 `N/M` 后紧跟 `项|条|个|文件|任务|完成/总`），或要求显式 `[batch]`/`批次任务` 标记；排除测试语义词（`测试|通过|passed|tests|覆盖|coverage|commit|push` 等），并至少排除“版本/提交”语境。
2. **只扫描 user 消息**（或排除含 memory header / `[CG-MEMORY` 的 assistant 消息），切断自引用。
3. **写入侧去重/supersede**：同一 session 的 batch 进度只保留最新一条（旧条目 `superseded`），latest-user/rules/rollback 同理，避免每压一次 +4。
4. **header 侧过滤**：注入前排除 `writer=rule` 的自动条目或明显噪音标题（`批次进度：纯数字/日期`）；当前 store 里没有真实 todo/decision/anchor —— 过滤后 header 会为空，这比注入噪音更诚实（零注入是允许的）。
5. **历史数据清理**：6 条 progress 噪音 + 相关 fact 建议由开发/需求用 `mem_write` status 机制 `superseded`/`expired`（保留审计），不要在报告里假装修复。
6. **回归用例**：`205/205`+“进度” 不入选；`赶进度`+测试数不入选；用户真实 `3/8 项完成` 入选；旧版 tool/result 输入不入选。

**计数更新**：**P2-4**（1 条）加入待修；T2 格式/注入面 P2 仍为 0；P3=8 不变。
