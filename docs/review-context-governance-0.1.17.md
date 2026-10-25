# 复核基线 · dsh-context-governance 0.1.17（cost-v1.4 枚举补 none + 控制字符闸扩根 + AGENTS.md 修复）

> 复核人：审核打包会话（cs_DNciCVhuZD）· 2026-10-25 23:3x +08
> 口径：只给问题与证据，不下验收结论；验收归用户。

## 0. 钉住的基线

| 项 | 值 |
|---|---|
| **代码基线** | `3485043`（0.1.17 主提交）+ `d079201`（AGENTS.md 修复） |
| 需求文档 | `e83d557`（REQ-20261025-08 出单） |
| 快照 | `.tmp/snapshot-0117/`（`git archive HEAD` = `d079201`） |
| 全量测试 | **205/205 pass**（0.1.16 为 204，+1：实测 unknown 单测） |
| 拓扑 | `446efe2（origin）→ e83d557 → 3485043 → d079201`（直线） |
| 宿主/安装态 | 0.2.1-rc.3；桌面未安装/未重启 |

## 1. 结论摘要

- **阻断（P1）：0**；**应修（P2）：0**；**建议（P3）：3**。
- **A 0.1.17**：实测 `none` 不再折叠（`none/none/none/false`），与实测 `unknown` 可区分；mixed 语义不变；`cost-v1.4` 值域扩展、无 schema 变更；闸扩到仓库根且**我注入复现过**。
- **B AGENTS.md**：三处列举正确，但**实际修了 4 处字母**——第四处是 `0x0C(FF)` 吃掉 `feat/` 的 `f`（同 commit 已修，但提交信息只写 `\t/\r/\n`）。修后字节口径全绿。
- **新发现 P3**：`/cg status` 仍把实测 `none` 显示成 `backend-label=unknown`，与成本行（`none`）不一致。

## 2. A. 0.1.17 本体

### 2.1 实测 `none` 不折叠（核心）

我自己跑的四字段（脚本 `.tmp/check-0117.mjs`，内存 store + 完整周期）：

| 场景 | backend | backendKind | backendLabel | backendInferred |
|---|---|---|---|---|
| 实测 `none`，无观察 | `none` | `none` | `none` | `false` |
| 实测 `unknown`，无观察 | `unknown` | `unknown` | `unknown` | `false` |
| 实测 `none` + free-form | `host-basic` | `host-basic` | `host-basic (inferred)` | `true` |
| mixed（两轮） | `unknown` | `unknown` | `mixed (unverified)` | `true` |
| 实测 `host-basic` | `host-basic` | `host-basic` | `host-basic` | `false` |

- `none` 与 `unknown` 的 `backend` 值**不同**（`none` vs `unknown`），可区分 ✔
- `backendKind === backend` 全部成立；`backend` 不含括号/空格（枚举正则 `^(host-basic|context-zip|none|unknown)$`）✔
- 源码：`measuredEnum` 现在把 `none` 也保留（`runtime.js:807-810`），`useInference` 只在 `none/unknown` 时补位 ✔
- dev 的两条单测（`m1.3-inference`：无观察 → none；unknown provider → unknown）真实覆盖了这个区分 ✔

### 2.2 mixed / 版本

- mixed 不变：`backend=unknown`、`backendKind=unknown`、`backendLabel="mixed (unverified)"`、`backendInferred=true` ✔
- `auditVersion=cost-v1.4` 维持；本次是**值域扩展**（backend 枚举新增 `none`），白名单无新增字段 → 确属“值域扩展非 schema 变更” ✔

### 2.3 控制字符闸扩到仓库根

- 真实仓库跑：`scanned files=174 violations=0`、pass ✔；排除 `.tmp`/`node_modules`/`.git` ✔
- **自证（我复现了注入→失败→还原）**：把快照拷到 `.tmp/gate-repo3`，向 `AGENTS.md` 追加 `0x0C`（offset 4566）→
  `scanned files=156 violations=1`，失败信息 `AGENTS.md @4566 byte=0x0c`；还原/删除副本后恢复 pass。
- 注意：快照副本扫到 156 个文件，真实工作区 174 —— **闸会扫工作区的未跟踪/被忽略本地文件**。实测 12 个：`.cross-session/registry.json`、`.dsh-file-attachment/.index.json`、`logs/compliance-scan-*.md`×3、`memory/governance/*`×7（另 6 个差额来自快照副本里非 ASCII 文件名在 tar 解包时变形，属我复现方式的问题，不影响结论）。→ P3-1（测试环境相关）。

## 3. B. AGENTS.md 修复（含“第四处”判定）

### 3.1 字节级对照（`git cat-file blob`，不做换行转换）

| 版本 | 字节数 | forbidden | tab | cr | loneCR | 说明 |
|---|---:|---:|---:|---:|---:|---|
| `446efe2`（修复前） | 4566 | **1**（`FF@2867` 在 `…开 \x0Ceat/<插件>…`） | **1**（`…用 \type:…`） | **1**（`…改 \remote…`） | **1** | 另有 1 个 LF 插在 `dist\ 与 \node_modules\` 中间（把 `n` 吃掉并断行） |
| `d079201`（修复后） | 4566 | 0 | 0 | 0 | **0** | 三处修复 + 断行合并 |

- 修复后**没有**任何 C0 控制字符/DEL；`type:`、`remote`、`node_modules`、`feat/<插件>` 均恢复正确 ✔
- 工作区文件当前有 3 个**成对 CRLF**（`cr=3, loneCR=0`，被 `.gitattributes` 规范化为 LF，blob 内 cr=0）：不影响闸（CR 本就允许）。

### 3.2 “只有三处、没有第四处”可信吗？——**不完全可信**

- dev 口径是「`\t`/`\r`/`\n` 吃掉字母」三处（`ype:`、`emote`、`ode_modules`）。
- **实际还有第四处**：`0x0C`（Form Feed）吃掉了 `feat/` 的首字母（`…开 \x0Ceat/…`）。**该处已在同一 commit `d079201` 里修好**，但提交信息/说明没有提到 FF 这一类。
- 我另做了“缺首字母”可疑词扫描（小写开头后接 `:`/`/`/`_` 或常见词尾）：当前文件只剩 `ask/type/feat/filter/node/push/init/http` 这类正常词；用 `\t`/`\r`/单字节 `\x0C` 全量扫也未发现第五处。
- **结论**：数量口径应为 **4 处（t/r/n/f）**，其中 3 处是提交信息列的三类，第 4 处是 FF；**没有未修的残留**。建议把 DEC/提交说明改成“四种控制字符（TAB/CR/LF/FF）、四处字母”，避免下轮误以为 FF 类不在覆盖范围。

### 3.3 修后全绿

- 闸：真实仓库 `scanned files=174 violations=0`；`AGENTS.md` forbidden=0 / tab=0 / loneCR=0（blob 口径）✔
- 全量 205/205 ✔

## 4. 无功能逻辑变更（证据）

- 代码改动面：`runtime.js` 仅 `#writeCost` 的枚举/补位条件；`no-control-chars.test.mjs`（范围扩根）；`m1.3-inference` 断言更新；**未动**保护/回注/记忆/选择器。
- 我拿 **0.1.16 快照 vs 0.1.17** 跑同一周期对照：`stats`（剔除 `lastProtectionWriteMs` 这类计时）、`failures`、审计事件集合**完全一致**；差异只在成本行 `backend` 值（`unknown`→`none`）✔

## 5. P3 清单

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| P3-1 | 闸扫的是**工作区**（含未跟踪/被忽略的本地文件：`.cross-session`、`.dsh-file-attachment`、`logs/*.md`、`memory/governance/*`），本机实测 174 个、干净副本 156 个；本地状态若含控制字符会误报 | `test/no-control-chars.test.mjs` | 改用 `git ls-files` 作为文件源（或显式跳过这些本地状态目录），让测试可复现 |
| P3-2 | `/cg status` 仍把实测 `none` 显示为 `backend-label=unknown`（`cg-status.js` 的 measuredEnum 未含 none），与成本行 `none` 不一致 | `src/commands/cg-status.js` | 与 `runtime.#writeCost` 用同一枚举口径（把 `none` 纳入 measuredEnum） |
| P3-3 | AGENTS.md 修复的提交信息/说明只列 `\t/\r/\n` 三类，实际是 **4 处**（含 FF 吃 `f`）；易让下一轮误判覆盖范围 | `d079201` 提交信息 / DEC-20261025-53 | 补一句“第四处为 0x0C(FF) 吃 `feat` 的 f” |

## 6. 真机验收观察点（桌面重启后）

1. `apply version=0.1.17`；`compaction-cost.auditVersion=cost-v1.4`。
2. 本部署实测 `adapter=none` → 成本行 `backend/backendKind/backendLabel` 应写 `none`、`backendInferred=false`（**不再折叠成 unknown**）。
3. 若某次观察到 free-form → 该周期 `backend=host-basic`、`backendLabel=host-basic (inferred)`、`inferred=true`。
4. `/cg status` 的 `backend-label=` 当前仍会显示 `unknown`（P3-2 修复前，属已知不一致）。
5. 保护/回注/成本数值行为与 0.1.16 一致。

## 7. 边界与推送

- 未安装桌面/未重启、未改 profile、未动用户数据；只读 asar、会话日志与仓库。
- 拓扑直线（`446efe2 → e83d557 → 3485043 → d079201`）；本报告提交前先 `git log -1` 确认父提交，fast-forward push 只推分支、不打 tag。
- 基线口径：0.1.11=`01a7598`；0.1.12=`a75ce82`；0.1.13=`2cea1ca`；0.1.14=`b6729da`；0.1.15=`fd0b08d`；0.1.16=`8cb24b4`+`71cbe74`；0.1.17=`3485043`+`d079201`。
