# C35③ digest 退出 fail 判定 — 审核签发 v4（2026-11-15）

签发人：审核打包。依据：rc.1 第一轮真机读数（`cycle 76f00aed`，`session-5d1121ed`，manual）+ 测试两次对齐实验（`tests\TEST-2026-11-15-23.md` §6/§7）。

结论先行：**v3 的「baseline digest 必过、不一致 fail(baseline-stale)」作废**，改由本文 v4 替代。rc.1 **不签可发**；修正并入 rc.2 出包。

## 1. 真机读数（我独立核查，与测试核出一致）

审计 `memory\governance\audit.jsonl` 第 1540–1595 行（cycle `76f00aed-4b4f-49fa-ac3d-b043cab30cfd`）：

| 判据 | 结果 | 数字 |
|---|---|---|
| `protection-write` | pass | 1 条（count=3） |
| `self-heal-verified` | pass（skill-catalog 事件级） | 2 条 |
| `self-heal-missing` | **不过** | 15 条，均 `kind=agent-instructions`、`seq=33198`、`path=~/.dsh/AGENTS.md`、`reason=baseline-stale`、`disposition=unacceptable` |
| `compaction-loss` | **不过（含 rule-injection）** | 16 条：15 条 `failures=["rule-injection"]`（reason=baseline-stale）+ 1 条 `["rollback-point"]` |
| `surface-rebuild-skipped` / `-resolved` | pass | 0 / 0 |
| 会话内 `form=surface-rebuild` | pass | 1 条且 `kind=user`，无 agent-instructions/skill-catalog 副本 |

**判：FAIL**，唯一不过项 = baseline digest 档。

## 2. 根因（两层，缺一不可）

**直接层（公式错）**：`src/compress/runtime.js:1070` 实现是 `sha1(content.trim())`；宿主 `changes[].digest` 是 `sha1(raw content)`（`instructionContentSha1(file.content)`，不 trim）。本轮节点 `expected=298adbeb…`（raw 值），实现算 trim 得 `22b9edac…` → 判 stale。测试 v3 对齐实验：trim 口径 **0/6 匹配**（6 条全误判），raw 口径 3/6。即"文件没动过"也会 fail。

**方法层（事后判历史必然 stale）**：改成 raw 也只解决一半。`~/.dsh/AGENTS.md` 三次采样（seq 67466 / 7238 / 77564）节点 digest 为 `d2789382…`/`18354bec…`，盘上 raw 恒为 `298adbeb…`；其中一次事件时间（18:57Z）**晚于**文件 mtime（18:47:12Z），不能用"事后被改"解释。即：**拿当前盘面去核历史节点的 digest，必然大量 stale**，公式再怎么调都消不掉。这与需求当时删掉"无法核对⇒fail"想避免的情形同源——我 v3 又把它写回去了，是我的判据错误。

## 3. v4 判据（三处同字）

**baseline（agent-instructions）**
- 主判：事件级。`form=instructions`、`baseline=true`、`source.kind='agent-instructions'`、`seq>compaction`、`plugin!=='context-governance'`、非 `surface-rebuild` 副本，且旧修订三重排除 → 即判自愈成功。
- digest **仅观察、不参与判定**：读盘重算后记录 `hashMatch ∈ {match, mismatch, unreadable}` 与 `expected`/`actual`；**三者一律 pass**，`reason='baseline-event-level'`。
- **warn 分档（判定表新增行）**：`self-heal-suspect`（`hashMatch=mismatch`，`disposition=warn`，不 fail）/ `self-heal-unverified`（`hashMatch=unreadable`，`disposition=warn`，不 fail）。
- **禁止**：因 digest 不一致产出 `self-heal-missing` 或 `compaction-loss`；禁止以 `baseline-stale` 作 loss reason。
- 审计字段：`self-heal-verified` 带 `mode='event-level'`、`hashMatch`、`expected`、`actual`；`AUDIT_FIELD_WHITELIST` 增 `hashMatch`/`expected`/`actual`（替换 `baseline-stale` 相关语义，白名单仍须反向验证）。
- 读盘失败/字段缺失：与 match/mismatch **同为一律 pass**，只体现在 `hashMatch='unreadable'`；`self-heal-unverified` 可保留为 warn 记录，但**不得**升级 loss。

**skill-catalog**
- 不变：事件级，`reason='skill-catalog-event-level'`，不引入 `ctx.get('skills')`、不做 per-entry digest。

**settle 路径（`#settlePendingHeals`）**
- 保留：窗口到期/会话结束/重启仍未自愈 → `self-heal-missing(reason≠baseline-stale)` + `compaction-loss(failures=['rule-injection'])`。
- baseline 不再从同步判定进 queue 失败路径；pending 在下一 turn 结算为 verified。

## 4. 谁改 / 怎么验 / 阻不阻 RC

| 项 | 内容 |
|---|---|
| 谁改 | **开发**：`runtime.js:986-1030`（删 stale 分支）、`:1050-1077`（观察器化，改名 `#observeBaselineDigests` 或等价）、白名单与单测 |
| 提交纪律 | rc.2 追加 commit，**不改写** `61b32ef` 与已出包树；出包仍从我签的 commit 树取 |
| 测试复验 | 按本文 v4 字面：mismatch/unreadable 均 pass 且 0 loss；单测补 3 例（match/mismatch/unreadable→pass、无 loss）；真机 2 轮压缩须 0 条 `baseline-stale`/`rule-injection` |
| 阻 RC | **是**。rc.1 每轮压缩必产假 unacceptable loss（已污染 15 条账）；rc.2 未修前不签可发、不建 Release |
| 旧账 | 本轮 15 条 `rule-injection` 记为**判据缺陷导致的假失败**，不回改审计（审计只追加），在本记录与复验结论里标注 |

## 5. 附带观察（不阻塞本次）

- 审计重复写：56 行仅 36 条唯一行，同事件写 2–4 次（`self-heal-pending` 最高 4 次）。列 rc.2 观察项，修 digest 时一并查是否同源多路径结算。
- 1 条 `compaction-loss["rollback-point"]`（entries=3）属既有判定，不随本次变更。

## 6. 对需求 `dfaf053` 的核对与签发（2026-11-15 补记）

逐行核 `git show dfaf053`，**判定语义接受**（事件级主判 pass/fail；digest 不进判定；目录事件级），但**字面两处未闭合**，签发附生效条件：

| # | 位置 | 现状 | 必改 |
|---|---|---|---|
| 1 | REQUIREMENTS C35③、口径对比 §5、复验清单 §2 —— 三处 `sha1(trim(content))` | **公式错**：宿主 `changes[].digest = sha1(raw content)`（测试实证 raw 3/3、trim 0/6） | 一律改 **`sha1(raw content)`**；否则本轮 `expected=298adbeb…`（raw）vs 复算 `22b9edac…`（trim）每轮必 `self-heal-suspect`，观察档永远假、噪声常驻 |
| 2 | 口径对比 `:39`（“下个 pre-step”段） | 仍写 “baseline 的 `changes[].digest` 逐 path 比对盘上 `sha1(trim(content))`（**必过**）” | 删/改为“digest 仅观察，不判 fail”，与 §5 同字；否则文件内自相矛盾，第三方按该句实现又会回到 fail |

**签发口径**：`dfaf053` 的判定语义即 v4，**可开工**；上述两处为字面必改项（需求一个 commit 内改完即可，不阻塞开发开工）。开发实现必须按 **raw** 复算，不得按 trim。改字完成我确认后，`dfaf053` 及其后继即为我签发的唯一有效字面。

### 6.1 闭合确认（`37636e9`，2026-11-15）

需求 `37636e9`（未 amend）已改：三处 `sha1(trim(content))` → **`sha1(raw content)`**；口径对比“下个 pre-step”段删“必过”、改“**仅观察、不判 fail**”；判定段补“窗口结束仍无 ⇒ fail + `compaction-loss(rule-injection)`，digest 不一致只 warn”。

我 grep 全仓 `.md` 复核：三处均 raw，`self-heal-suspect`/`self-heal-unverified` 保持；残留 `trim` 只在历史/诊断文档（测试报告、C35③ 实现记录、本签发件），不影响执行口径。

**确认：`dfaf053` + `37636e9` 为 C35③ 唯一有效字面。** 代码侧 `runtime.js:1070` 仍是 trim，属开发待改项（已通知按 raw 实现）。
