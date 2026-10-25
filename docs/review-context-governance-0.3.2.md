# 复核报告 · context-governance 0.3.2（README/T5 默认开 + 打包脚本 + 两个维护脚本）

> 复核人：审核打包会话（`cs_DNciCVhuZD`）· 2026-10-26
> 口径：只报证据、修正与边界，**不判验收**；口径决策归需求/用户（`DEC-20261025-65`）。
> 范围：`bda3659`（README/T5 默认开）、`6ce6e8b`（export-package）、`28f749e`（扫描窄白名单 + memory-cleanup）。0.2.2 骨架 `2367d57` 另见 `docs/review-context-governance-0.2.2.md`。

## 0. 钉住的基线

| 项 | 值 |
|---|---|
| 复核提交 | `bda3659`、`6ce6e8b`、`28f749e` |
| 实测时 HEAD | `2367d57`（`git ls-files` 212，无二进制，212 个都按文本扫） |
| 未提交改动 | 仅 `REQUIREMENTS.md`（需求会话编辑，非本次对象；我未触碰、未提交） |
| 测试 | `packages/dsh-context-governance`：290/290 pass（与 0.2.2 骨架同次实跑） |

## 1. README / T5「默认开」修正

### 1.1 键名与默认值逐键一致

`packages/dsh-context-governance/README.md:117-122` 样例对 `src/index.js:54-60` 默认：

| 键 | README 样例 | `src/index.js` 默认 | 判定 |
|---|---|---|---|
| `enabled` | `true` | `true` | ✔ |
| `maxLines` | `8` | `8` | ✔ |
| `maxChars` | `800` | `800` | ✔ |
| `oldAgeDays` | `14` | `14` | ✔ |
| `oldLimit` | `30` | `30` | ✔ |

- README:7 与 `src/index.js:54` 注释口径一致：“0.3.1 起默认开；`/cg header off` 或此键可关”。
- 旧字段名 `maxEntries` 全仓 0 残留（`git grep` 实测）。

### 1.2 「默认关 / opt-in」残留：按历史 vs 当前分类，不整刷

| 位置 | 语境 | 处理 |
|---|---|---|
| `docs/M1-回顾与M2候选.md:27,46,62,96,106,115` | M1 回顾 / M2 候选（当时默认关） | 历史，保留 |
| `docs/M3-需求草案-v0.1…v0.4.md:27` | 需求草案（“代码已存在、默认关；用户定默认开”） | 历史，保留 |
| `docs/T7-验收场景-S1-S6.md:42,56`、`docs/T7-复核修复-0.1.6.md:100` | 0.1.x 验收/修复记录 | 历史，保留 |
| `docs/review-0.1.6.md:22,25,186,199`、`review-0.1.7.md:139`、`review-0.1.11.md:141` | 各版本复核记录 | 历史，保留 |
| `docs/上下文治理插件-架构说明-v0.2…v1.1`（多处“默认关”） | **另一功能**（全局偏好），不是 memoryHeader | 不需改 |
| `packages/dsh-context-governance/test/t7-scenarios.test.mjs:198` | 测试标题仍写 “opt-in”，但用例 `:231` 显式传 `{enabled:true}`，另有 `S3b` 断言默认 true | 仅措辞；可改标题，无行为影响 |

当前事实文档（README / `docs/T5-状态命令与审计.md` / `STATUS.md`）实测 **0 处**“默认关”。结论：不需要再刷历史文档。

## 2. `scripts/export-package.mjs`

- **来源正确**：`git archive <rev>`（`:34`）→ 只含 tracked 内容；未跟踪文件不可能进包。控制字符闸与 archive 同源（`git ls-files`），不会一个扫全部、一个打子集。
- **实跑（HEAD `2367d57`）**：`rev=HEAD files=212 strictFailed=false`。
- **条目数核对**：`.tmp/release-*.zip` 245 条 = 212 文件 + 33 目录条目；解压目录 `git ls-files` = 212 → **一一对应，无缺漏**。
- **数字口径**：00 报的 207 是 `6ce6e8b` 时的 tracked 数；之后 `28f749e` +1（memory-cleanup）、`fdbe7d7`/`42e405f` +2（任务单）、`2367d57` +2（源码/测试）= 212。脚本每次按 `rev` 实算，不写死。
- **`--strict` 语义**：`compliance-scan.mjs:231` 仅当 `blockers.length > 0` 退出 1；review/info 不阻断是刻意的（review 需人工、info 知悉），两者都在报告明细分列，不是“忽略”。
- 小尾：zip 本身不随 `--keep` 清理（只有解压目录被删），`.tmp/` 已 gitignore，不污染仓库。

## 3. `scripts/compliance-scan.mjs` 窄白名单（三点）

### 3.1 白名单窄不窄：窄，但有一个“同线共现”洞

- **作用域窄**：`HISTORICAL_REVIEW_FILE`（`:71`）只匹配 `docs/review-*.md` 与 `docs/T5-状态命令与审计.md`；其他 docs、代码、任务单一律不适用。
- **只作用于凭据分级**（`:116-117`），不改路径 / 会话 id / 许可分级；**没有白名单整个 `docs/`**。
- **不含真实密钥格式**：`\bghp_\/sk-` 匹配字面串 `ghp_/sk-`，不是 `ghp_[A-Za-z0-9]{20,}`；`hunter2` 是文档里的测试口令；`pass***` 是脱敏样例。
- **实测同线共现**（用脚本副本逐条构造）：

| 构造行（`docs/review-x.md`） | 命中凭据 | 白名单命中 | 分级 |
|---|---|---|---|
| `真实泄漏 ghp_ABC…`（无样例句） | github-token | 否 | **blocker** ✔ |
| `格式示例 ghp_/sk-，实际 token ghp_ABC…` | github-token | 是 | **info（洞）** |
| `hunter2 演示，真实 key sk-proj…` | openai-key | 是 | **info（洞）** |
| `pass*** 样例，真实 password = …` | credential-assignment | 是 | info（review→info，同类） |

结论：白名单**没有把真实格式本身写白**；但它是**整行**判定——同一行只要出现白名单串，该行**所有**凭据都降 info。当前仓库 0 行同时含“白名单串 + 真值”（扫描明细可证），所以现在不藏东西；建议改为**按匹配串**判定（值本身是 `***` / `hunter2` / 占位符才降），并补一条单测：同线“样例句 + 真 token”必须仍判 blocker。

### 3.2 `isSelf` 只降自己

- `SELF_DESCRIBED`（`:67`）只有两个路径：`src/memory/contract.js`、`scripts/compliance-scan.mjs`。
- 许可降级 `DOC_FILE.test(file) || isSelf`（`:130`）：只对这两文件 + 所有文档；**其他代码文件里的版权头仍是 review**。
- 残留：`isSelf` 同时用于凭据分级（`:117`，0.3.0 起就有）。这两文件内容固定、自己维护；但若将来有人把真 token 贴进 `contract.js`，会被降 info。建议把凭据的 `isSelf` 收窄为“本文件正则自描述”，或去掉（凭据白名单只该认 test/文档样例）。

### 3.3 `review 6→0`：3 条白名单 + 3 条自描述，**不是“修好了”，也不是“看不见了”**

用 `6ce6e8b` 旧脚本在同一 HEAD 重跑：`review=6 / info=74`；新脚本：`review=0 / info=80`（74+6=80，降级关系闭合）。逐条：

| # | 位置 | 类别 | 依据 | 现在 |
|---|---|---|---|---|
| 1 | `docs/T5-状态命令与审计.md:174` | credential-assignment | 测试描述“password = hunter2… + ghp_…” | info |
| 2 | `docs/review-0.1.7.md:44` | credential-assignment | 复核表行“ghp_/sk-/Bearer/PRIVATE KEY/password=/api_key=… 0” | info |
| 3 | `docs/review-0.1.7.md:128` | credential-assignment | 同上（fixture 凭据 0） | info |
| 4 | `scripts/compliance-scan.mjs:13` | license:copyright | 脚本自述“扫 Copyright (c) …” | info |
| 5 | `scripts/compliance-scan.mjs:88` | license:spdx | 脚本自己的 SPDX 正则 | info |
| 6 | `scripts/compliance-scan.mjs:90` | license:mit-license-text | 脚本自己的 MIT 全文正则 | info |

**关键：6 条没有消失**——最新扫描报告 `### info` 下仍原样列出同一 `file:line`（我逐条 grep 到全部 6 条）。所以不会变成“看不见的问题”；报告仍可复核。建议报告备注注明“这 6 条是降级而非修复”，避免下一轮误判为已清理。

## 4. `scripts/memory-cleanup.mjs`

### 4.1 7 条目标逐条核对：**7/7 都是 rule 噪音，没有真实进度**

| id | title | writer | source / evidence | 判定 |
|---|---|---|---|---|
| MEM-20261025-1002 | 批次进度：171/171 | rule | session-58a2e845#8529 / compaction:bae15aec | 噪音（测试数） |
| MEM-20261025-1006 | 批次进度：8000/1500 | rule | session-f72e86a8#1745 / compaction:affd672f | 噪音（用例文本） |
| MEM-20261025-1010 | 批次进度：2026/10×12 | rule | session-5d1121ed#3027 / compaction:87f836f6 | 噪音（日期被比例正则抓成 2026/10） |
| MEM-20261025-1015 | 批次进度：有批次标记 | rule | session-58a2e845#11479 / compaction:e78053e0 | 噪音（用例文本） |
| MEM-20261025-1019 | 批次进度：216/216 | rule | session-58a2e845#16305 / compaction:13fb4560 | 噪音（测试数） |
| MEM-20261025-1023 | 批次进度：205/205 | rule | session-5d1121ed#6585 / compaction:da587612 | 噪音（测试数） |
| MEM-20261026-1002 | 批次进度：8000/1500、3/5 | rule | session-5d1121ed#11527 / compaction:ca9c9bb8（`manual:false`） | 噪音（DEC-73 用例文本被压缩抓到） |

全部 `writer: rule`、`type: progress`、`evidence: compaction:*`，均为保护层自动写入。**第 7 条**正是我 2026-10-25T17:52:27 那次压缩（`ca9c9bb8`，非手动）从对话里抓到的测试数字（`8000/1500`、`3/5` 是 DEC-73 的用例），不是真实进度。

### 4.2 `--apply` 备份确实先于写（实测）

- 代码顺序：`fs.cpSync(root, backup)`（`:56`）→ `store.expire` 循环（`:59-60`）→ 审计 append（`:61`）。
- 我在副本上跑（`copy memory/governance → .tmp/cleanup-test`，删掉继承的 `.writer.json` 模拟 DSH 已停）：
  - `applied=7`、`active: 15 -> 8`；
  - 备份目录 `topics/progress.md` 仍是 **7 条 active**（写前状态）；
  - 写入后 `topics/progress.md`：**0 active / 7 expired**；
  - `audit.jsonl` 追加 7 条 `memory-cleanup`（含 id / reason / source）。
- 结论：备份内容 = 写前状态，回滚 = 用备份目录覆盖回去。
- **失败模式（真机 DSH 运行中）**：锁被活进程持有 → `expire` 抛 `MemoryReadOnlyError: writer-lock:<pid>`，脚本堆栈退出（exit 1），**未写任何条目**、备份已生成（无害）。建议 apply 前先判 `store.status.writable` 并友好退出；否则用户只看到 Node 堆栈。陈旧锁（进程已死）会被自动接管，无需手删。
- 备份默认落 `D:/DS-PROJECT/_backup`（仓库外），目录名 `governance-bak-<stamp>`；`.writer.json` 也会被复制（无害）。

### 4.3 规则过宽（P3）

`isRuleNoise`（`:31-35`）：**任何** `status === 'active'` 的 `progress` 条目都算噪音，不看 writer。当前 7 条全是 rule，这次 apply 安全；但契约允许 model 写 progress，将来真实进度会被过期。建议条件改为 `type === 'progress' && writer === 'rule'`（第二个分支本来只在 `writer === 'rule'` 时生效，两分支口径应统一）。

### 4.4 其他核对

- `--dry-run` 为只读 open（`readOnly: !apply`），不取锁、不写文件（实测 targets=7，无备份目录）✔
- `--project` 默认 `DSH插件开发`；store 读取时按 `entry.project === this.#project` 过滤（`store.js:413`），**不会误改其他项目条目** ✔

## 5. 问题清单（本轮新增）

| 编号 | 级别 | 问题 | 建议 |
|---|---|---|---|
| **P2-1** | P2 | 白名单是整行判定：同一行“样例句 + 真令牌”会把真令牌降成 info（实测见 §3.1） | 改成按匹配串判定 + 单测覆盖同线真值 |
| P3-1 | P3 | `isSelf` 对凭据也降级（`contract.js` / `compliance-scan.mjs`） | 凭据白名单只留 test/文档样例，或按自描述正则收窄 |
| P3-2 | P3 | memory-cleanup 把所有 active progress 当噪音（不限 writer） | 加 `writer === 'rule'` |
| P3-3 | P3 | 锁冲突时 `--apply` 以 Node 堆栈退出 | 先判 `status.writable`，友好报错 |
| P3-4 | P3 | 扫描报告未注明“6 条是降级不是修复” | 报告备注加一句 |
| P3-9 | P3 | `package.json` 仍 `0.2.1`，功能已 0.3.1/0.3.2 | 发布前定版号（在册，未修） |

## 6. 复验命令

```powershell
node scripts/export-package.mjs                 # rev=HEAD files=212 strictFailed=false
node scripts/compliance-scan.mjs                # blocker=0 review=0 info=80 (212 text files)
git show 6ce6e8b:scripts/compliance-scan.mjs > .tmp/old-scan.mjs; node .tmp/old-scan.mjs   # review=6 复现
node scripts/memory-cleanup.mjs                 # DRY-RUN targets=7（不写）
# apply 演练（副本，勿在真机直接跑）：
# copy memory/governance → .tmp/cleanup-test，删 .writer.json
# node scripts/memory-cleanup.mjs --root .tmp/cleanup-test --apply --backup-dir .tmp/cleanup-bak
```
