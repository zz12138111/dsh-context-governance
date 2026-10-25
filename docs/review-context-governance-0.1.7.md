# 复核报告（第三轮）· `dsh-context-governance` v0.1.7

> 复核方：审核打包。**技术结论以本报告为准**；用户验收只看交付物与体验。
> 对象：分支 `feat/context-governance-m1`，**HEAD `942e6b7`（v0.1.7，提交 19:28:56 +08）**，固定快照 `.tmp/snapshot-017/rev017/`。
> ⚠️ 复核期间开发又开始了 **T8 未提交改动**（`runtime.js`/`audit.js`/`REQUIREMENTS.md`，mtime 19:31+，本报告写作时 `git status` 已脏）。**本报告只对 `942e6b7` 有效**；T8 改动未复核、未纳入任何结论。
> 运行态：当前仍是 **0.1.6**（pid 32544，`logs/governance.log` 最后一行 version=0.1.6；audit 最后一行 `version:"0.1.6"`）→ 0.1.7 **尚未加载**，本报告对 0.1.7 只有源码/离线证据，没有新的真机证据。
> 测试：在 HEAD 快照上 `node --test "test/*.test.mjs"` → **161/161 pass**。
> 纪律：未改代码、未 push、未装、未重启；独立验证脚本见 `.tmp/`（不入库）。

---

## 0. 结论摘要

| 项 | 结论 | 一句话 |
|---|---|---|
| **阻断项** | **0** | 按二轮列出的 fixture 判据全过；运行期 P1（0.1.6 已验）不在本轮回归范围内 |
| 1. fixture 脱敏 | **已修（按判据）＋残留 P2** | 递归扫描：单串/数组 join/raw 全 0 违规；但**英文正文/工具参数仍在**（见 §1.3） |
| 2. SPEC-05 commands 可选 | **已修** | `inject=['tools']`；缺 commands 时 apply 成功、mem_* 注册、仅 warn |
| 3. REQ-02 回注被吞 | **部分修** | `reinjection-shadowed` 真实可写（独立双周期验证）；**成本归属仍未实现**（已如实标“待需求定字段”） |
| 4. Runbook §6 三缺口 | **已修** | .bak、写后断言、redirect Test-Path 都在；仍为静态核对（未实跑） |
| 5. STATUS 已知风险 | **已记账** | `STATUS.md:28-30` 明确“ROB-01/06 未修，T8 第一项” |
| 附带 | ROB-10 已修；版本 0.1.7 一致 | README/契约已补“手改会被覆盖” |

---

## 1. fixture 脱敏（发布阻断项）

### 1.1 按二轮列出的判据：全部通过（**我自己的扫描器**，未使用 `analysis/t7/scan-fixture.mjs`）

方法（`.tmp/scan-fixture-independent-v2.mjs`）：
- 递归收集**所有字符串**；对每个字符串查：CJK（含全角/假名）、Windows/UNC 绝对路径、POSIX 常见根路径、URL、`session-<uuid>`、裸 uuid、≥64 长 token；
- 对每个**纯字符串数组**做 `join('')`、`join(' ')`、`join('\n')` 三种还原后再查同一组规则；
- 对**全文档字符串**做 `join('')`/`join(' ')`/`join('\n')`；
- 对 raw 文本与 join 结果查点名的串：`session-53ece2c2`、`session-58a2e845`、`19091`、`DS-PROJECT`、`DS-HARNESS`、`AGENTS.md`。

结果：

| 判据 | replay-compaction.json | replay-compaction-manual.json |
|---|---|---|
| 字符串总数 / `[redacted:N]` 占位 | 4111 / 722 | 1851 / 186 |
| 单串违规（CJK/路径/URL/session-uuid/裸 uuid/长 token） | **0** | **0** |
| 数组级 join 违规（三种分隔符） | **0** | **0** |
| raw / join 点名串（含 `session-53ece2c2…`） | **无** | **无** |
| raw 凭据形态（ghp_/sk-/Bearer/PRIVATE KEY/password=/api_key=） | **0** | **0** |
| raw 邮箱 / 手机号 | **0** | **0** |

- 全局 `join('')` 会出现一次 `long-token`：这是**把所有字符串首尾相接**产生的拼接伪影（单串与数组 join 都为 0，raw 里也没有 40+ 连续 token），不是真实泄漏；开发的扫描器同样在 join 层跳过 long-token，结论一致。
- **`session-53ece2c2…` 已不存在**（raw/join 双侧确认）；两份真实 session id 都已消除。
- 提取器修法核对：`analysis/t7/extract-replay-fixture.mjs:20-80` 已改为递归、不再依赖 key；字符串数组先 join 判敏感、短片段流整组替换（`:36-50`、`:61-80`）。

### 1.2 T7-R2 是否真成了硬断言
- `test/t7-replay.test.mjs:116-141`：递归所有字符串 → `strings.join('\n')`（`:129`）与 `strings.join('')`（`:130`）**都查**，raw 再查 `session-53ece2c2/19091/DS-PROJECT/AGENTS.md`（`:138`）—— 是硬断言。
- 两点保留：① 它 `import` 了开发自己的 `analysis/t7/scan-fixture.mjs`（`:118`），所以“独立”程度有限（我这份扫描器是另写的）；② `FORBIDDEN` 是**模式列表**，join 层还跳过 long-token（`:131-135`），因此它**不会**发现 §1.3 的英文正文残留。

### 1.3 残留（**P2，不阻断，但发布口径要改**）
脱敏是“**模式命中式**”，不是“内容白名单式”：英文正文、代码片段、工具参数不含 CJK/路径/URL/长 token，因此原样留下。我的独立扫描统计与样例：

- 自动 fixture：**835** 个“含空格 + ≥30 字符英文”的字符串；手动 fixture：**32** 个。
- 样例（行号为 fixture 文件内行号）：
  - `replay-compaction.json:148`、`:227` `"text": "Update runtime test no service expectation."`；
  - `replay-compaction.json:679` `"  const guard = new CompressionGuard({ ctx, hostVersion: '0.2.1-rc.2' });"`（测试代码片段）；
  - `replay-compaction-manual.json:2190`、`:4108` `"arguments": "{\"command\": \"foreach($t in (Get-ScheduledTask …' )…"`（完整 PowerShell 命令）；
  - `replay-compaction-manual.json:4172` `"text": "DSH-AppUpdate-Weekly … DSH-AutoStart …"`（计划任务清单）。
- 这些是**真实会话里的 assistant 文本 / 工具调用参数 / 运行期上下文**（英文），不带用户中文、绝对路径、会话 id、凭据，因此**不构成本轮阻断**；但 `DECISIONS.md` 的“无正文/路径/会话 id”与 T7 文档的“深度脱敏”表述仍不严谨。
- 建议（发布前二选一，成本很低）：
  1. **结构白名单**：fixture 只保留 `type/seq/time`、数值、枚举（`source.kind`、`form`、`compactionId` 替换值、`shadowedRange/Seqs`、`usage` 数字），`preMessages[].data` 里的 `message.content`、`stream`、`meta.lines` 整段替换为 `[redacted]`；
  2. 或在 fixture `meta.note` 与文档里明确写“**只保证无 CJK/路径/会话 id/URL/长 token；仍含脱敏后的英文工程文本**”，不再声称“无正文”。
- 发布影响：`package.json.files` 含 `test`，fixture 会进打包产物；若做公开 Release，建议先做上述收口。

---

## 2. SPEC-05：`commands` 降为可选 —— **已修**

- `src/index.js:28-31`：`export const inject = ['tools']`；注释明确 `commands` 仅用于 `/cg status`，走 `ctx.get('commands')` 可选探测。
- `src/commands/cg-status.js:128-144`（未变）：`ctx.get('commands')` 拿不到时返回 `{registered:false, reason}`；`apply` 只 warn（`index.js:303-310`）。
- **独立验证**（`.tmp/verify-0.1.7-pinned.mjs`，跑在 HEAD 快照上，不是测试用例）：
  - `inject=["tools"]`；
  - 构造**没有 commands 服务**的 ctx（`get: () => undefined`）调 `apply(...)` → `registered=["mem_write","mem_query"]`，且 warn 含 `/cg status was not registered`。
  → 缺命令服务时插件照常装载、mem_* 照常注册，符合要求。
- 用例：`test/t7-p2.test.mjs:145-165`（断言 inject、两工具注册、warn），已随 161 全绿。
- **新 P3（顺序依赖）**：commands 移出 inject 后，`/cg status` 的注册取决于 apply 时 commands 服务是否已挂好；若某部署里 commands 晚于治理插件加载，命令会静默缺失（只有 warn，不会重试）。建议改用 `ctx.inject(['commands'], ...)` 做可选延迟注册，或保留一次“下个 tick 重试”。本机 profile 里 commands 属基础 bundle、先于治理行，实际风险低。

---

## 3. REQ-02：`reinjection-shadowed` 与成本归属

### 3.1 回注被吞审计 —— **已修**
- 实现：`src/compress/runtime.js:135`（`#lastInjection`）、`:713`（回注成功后记 {seq,cycle}）、`:867-877`（下一次 `compaction/summary` 的 `shadowedSeqs` 含该 seq → 写 `reinjection-shadowed`，带 `sessionId/compactionId/seq/cycle/reason`）；事件名加入 `AUDIT_EVENTS`（`src/audit.js:65`），字段均在白名单（`sessionId/compactionId/seq/cycle/reason`）。
- **独立验证**（HEAD 快照）：第一周期注入 → 第二周期 `shadowedSeqs` 包含该 seq → 实际写出
  `{"event":"reinjection-shadowed","sessionId":"session-req02","compactionId":"cmp-2","seq":10000,"cycle":"cmp-1","reason":"shadowed-by-next-compaction"}`，`stats.reinjectionShadowed=1`。
- 用例：`test/t7-scenarios.test.mjs:431-464`。
- 残留 P3：判定只用 `shadowedSeqs`，没用 `shadowedRange` 兜底（`protection.js` 两种都支持）。若某后端摘要只带 range/seqs 二者之一，可能漏报；建议照 `protection.js` 的 `shadowedNodesFrom` 加 range 回退。

### 3.2 成本归属 —— **仍未实现，但已如实标注**
- 源码中无 cost/tokens 归属字段（`src/` 内无相关实现；`adapters.js` 的 `usage` 只是能力标记）。
- `docs/T7-复核修复-0.1.7.md:38` 明确写“**成本归属未实现**：需需求/用户定义归属粒度与字段，不自行标‘未列’”。
- 判定：**部分修**（被吞已修；成本归属待需求定字段）。这比二轮“理由不成立”有改进——现在是把决策点交给需求/用户，而不是拿“M1 未列”掩盖。

---

## 4. Runbook §6 三缺口 —— **已修（静态核对）**

`docs/插件安装升级-Runbook.md:230-280`：
1. **先留 .bak**：`:237-239` `Copy-Item package.json → package.json.cg-bak-<时间戳>`；
2. **写后断言**：`:255-261` Node 脚本重新解析 saved manifest，`stillDependency/stillBundle` 任一为真即 throw；`$LASTEXITCODE -ne 0` 时 PowerShell 再 throw；
3. **redirect 先 Test-Path**：`:266` 缺 `package.json` 直接停；还原后再断言存在与版本（`:271-274`）。

- 其余二轮已修项保持：只删本插件 manifest 条目、patch/lock 默认不还原（`:283-290`）、junction 退出码（`:232-233`）、`.ignored` 判据（`:291`）、备份保留 3 份（`:292-296`）、回滚点记 ARTIFACTS（`:297-298`）。
- **仍未实跑**：需退出 DSH，本轮只做静态可执行性核对（与二轮一致）。

---

## 5. 已知风险记账（ROB-01/06）—— **已记**

- `STATUS.md:28-30` 新增“已知风险（未修，T8 首项）”：一次 `session.append` 失败触发 `#disableReinjection`，随后 `protection-write-skipped`，**S4=B 预写被永久关掉**，需重启/重载恢复；明确列为 **T8 第一项**。
- 与 HEAD 代码一致：`src/compress/runtime.js:459-465`（HEAD 快照）仍是“reinjectionDisabled → 跳过保护写”的耦合，符合“未修”的描述。
- 说明：复核期间工作区已出现 T8 未提交实现（`#reinjectionFailureStreak`/`reinjection-recovered`、token 估算等，mtime 19:31+），**不属于 0.1.7，本报告不评**；等提交后再复核。

---

## 6. 附带核对

| 项 | 结果 | 证据 |
|---|---|---|
| ROB-10（文档补“手改会被覆盖”） | **已修** | `README.md:99`、`docs/记忆契约-v1.md:21` 已写“手改会在下次写入时被覆盖” |
| 版本一致性 | **一致（0.1.7）** | `package.json:3`=0.1.7；`PLUGIN_VERSION` 由 `readPackageVersion()` 读取；STATUS 用 `version=<package.json>`；`engines.dsh`（`:34`）与矩阵一致 |
| 测试 | **161/161 pass**（HEAD 快照） | 含 fixture 硬断言、SPEC-05、REQ-02 用例 |
| fixture 凭据 | **0** | ghp_/sk-/Bearer/PRIVATE KEY/password=/api_key=、邮箱、手机号均 0 |

---

## 7. 剩余验证（0.1.7 尚未加载，需用户重启后）

| # | 项 | 说明 |
|---|---|---|
| V1 | 重启到 0.1.7 | 看 `version=` 变为 0.1.7（由 package.json 读出）、`perception=event`、`events=N`、`audit: … rotations=…`。**需用户批准重启** |
| V2 | 真实压缩（**本项目会话**） | 必须在 cwd=`D:\DS-PROJECT\DSH插件开发` 的会话触发；00 自己的会话 cwd=`G:\DS-HARNESS` 会被 `onlyProject` 忽略。预期 audit：`protection-write`/`protection-materialized`/`reinjection`，第二次压缩后出现 `reinjection-shadowed` |
| V3 | `/cg status` | 看 `scope:`/`events=`/`audit: max/size/rotations`/`protection:` 行 |
| V4 | 只读演练 / S3 opt-in | 按 `docs/T7-只读降级人工验证.md`；S3 默认关、需用户拍板 |
| V5 | fixture 收口（可选 P2） | 决定是否按 §1.3 做“结构白名单”，再重生成并重跑 T7 |
| V6 | 发布打包 | locale/icon、patch 占位、`files` 收紧、zip 结构（我的阶段） |

---

## 8. 证据索引

- 快照：`.tmp/snapshot-017/rev017/`（git archive HEAD `942e6b7`）。
- 独立脚本（`.tmp/`，可重建）：
  - `scan-fixture-independent-v2.mjs`（本轮新写，递归 + 数组 join + 全局 join + raw + 点名串）；
  - `verify-0.1.7-pinned.mjs`（HEAD 快照上的 SPEC-05 apply 与 REQ-02 双周期，非测试用例）。
- 代码证据（HEAD）：`src/index.js:28-31,303-310`；`src/commands/cg-status.js:128-144`；`src/compress/runtime.js:135,713,867-877`；`src/audit.js:65`；`test/t7-p2.test.mjs:145-165`；`test/t7-scenarios.test.mjs:431-464`；`test/t7-replay.test.mjs:116-141`；`analysis/t7/extract-replay-fixture.mjs:20-80`；`analysis/t7/scan-fixture.mjs:22-30,51-59`。
- 文档：`docs/T7-复核修复-0.1.7.md:1-60`（修法/成本归属口径）、`docs/插件安装升级-Runbook.md:230-280`、`STATUS.md:28-30`、`README.md:99`、`docs/记忆契约-v1.md:21`。
- fixture 残留样例：`replay-compaction.json:148,227,679`；`replay-compaction-manual.json:2190,4108,4172`。

---

**复核结论一句话**：0.1.7 对二轮指出的 5 项全部有实质动作——fixture 按既定判据已清零（session id/路径/CJK/URL/长 token 全无，T7-R2 已成 join 双侧硬断言）、SPEC-05 已修、REQ-02 的回注被吞已能真实写审计（成本归属如实留待需求）、Runbook 三缺口已补、ROB-01/06 已记账为 T8 首项；**阻断项 0**。唯一挑刺：fixture 仍保留英文正文/工具参数（P2，不阻断，发布前建议做结构白名单）；另两条 P3 风险（`/cg status` 的顺序依赖、`reinjection-shadowed` 未用 shadowedRange 兜底）。

**复核方**：审核打包 · cs_DNciCVhuZD · 2026-10-25 19:3x（+08:00）
