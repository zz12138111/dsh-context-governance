# 复核基线 · dsh-context-governance 0.1.18（backend 字段单一来源 + 控制字符闸改 tracked）

> 复核人：审核打包会话（cs_DNciCVhuZD）· 2026-10-25 23:5x +08
> 口径：只给问题与证据，不下验收结论；验收归用户。这是发布前最后一道复核。

## 0. 钉住的基线

| 项 | 值 |
|---|---|
| **代码基线** | `0d5655e`（0.1.18；父 `b3ff739` = 我的 0.1.17 复核报告） |
| 快照 | `.tmp/snapshot-0118/`（`git archive 0d5655e`） |
| 全量测试 | **206/206 pass**（0.1.17 为 205，净 +1：`m1.3-inference` 8→9 条） |
| 拓扑 | `b3ff739（origin）→ 0d5655e`（直线） |
| 宿主/安装态 | 0.2.1-rc.3；桌面未安装/未重启 |

## 1. 结论摘要

- **阻断（P1）：0**；**应修（P2）：0**；**建议（P3）：4**。
- 六条复核要点全部成立：单一来源、status 三态（none/推断/无推断）、闸改 tracked 且语义符合预期、P3-3 文档四处齐全、`cost-v1.4` 维持、无功能变更。

## 2. 逐项核对（00 的六点）

### 2.1 P3-2：`resolveBackendFields(adapter)` 是否真的单一来源

- 新增于 `src/compress/adapters.js:363-375`，返回 `{backend, backendKind, backendLabel, backendInferred}`。
- 全仓 grep（`measuredEnum|backendLabel|backendKind|resolveBackendFields`）：
  - **计算只有一处**：`adapters.js` 内；`audit.js` 只是白名单（`backendKind/backendLabel: 'text'`）。
  - `runtime.#writeCost` 改为 `const backendFields = resolveBackendFields(this.#adapter); ... ...backendFields`；
  - `cg-status.js` 改为 `const backendFields = resolveBackendFields(adapter);` 再据此渲染。
- **没有第二处各自计算的残留** ✔（旧的两段 `measuredEnum/useInference/backendKind/backendLabel` 已删除）。

### 2.2 status 在实测 none 时的实际输出，与末尾 `backend=unknown` 的归属

我的实跑（构造 status，无推断）：

```
compression: mode=event-level adapter=none backend-kind=none perception=event event-api=on events=0(…) summary=unknown/unknown host=0.2.1-rc.3 backend=unknown
```

- 末尾 `backend=unknown` 来自 `cg-status.js:45`：`host=${adapter.versions.host} backend=${adapter.versions.backend}` —— 这是**宿主 backend 版本**（`versions.backend`），**不是** adapter backend，也没有旧字段没收干净 ✔。
- `adapter=none` 是**实测适配器 kind**；`backend-kind=none` 是**解析后的 backend 枚举**（两者当前相等，但语义不同，见 P3-3）。

### 2.3 推断/无推断两态

- **无推断**：`adapter=none backend-kind=none …`，**完全没有 `backend-label=`**（`backendLabel === backendKind` 时不输出后缀）✔
- **推断补位**：`adapter=none backend-kind=host-basic backend-label=host-basic (inferred) …` ✔
- 两态各有单测（`m1.3-inference`：`backend-kind 恒为枚举；实测 none 显示 none（无 label 后缀）`、`推断补位时 backend-kind=枚举 + backend-label=展示串`），我也各自实跑复核 ✔

### 2.4 P3-1：闸改 `git ls-files` 及“只认 tracked”的语义

- 真实仓库：`scanned tracked files=163 violations=0`、pass ✔（与开发口径一致）
- 我在**临时 git 仓库**里复现了语义（`git init` + 1 个 tracked 文件 + 1 个 untracked 文件）：
  - tracked 文件注入 `0x07` → **fail**，打印 `a.md @10 byte=0x07`；
  - untracked 文件注入 `0x07` → **pass**（`scanned tracked files=2 violations=0`，未跟踪文件不参与扫描）。
- 判定：**语义符合预期**——闸只保护“会入库/会进发布包”的内容；本地 `logs/`、`memory/governance/` 等不入库文件不参与是正确的。**前提是发布包必须由 tracked 内容生成**（`git archive` / `git ls-files` 清单），否则未跟踪文件可能绕过闸（见 P3-2）。

### 2.5 P3-3 文档：四处（t/r/n/f）

- `analysis/req-20261025-06/REQ-06-M1.3-报告.md` §11 写明：`AGENTS.md` 实际修复 **4 处**——`0x0C(Form Feed)@2867` 吃掉 `feat/` 的 `f`，另三处为 `t`/`r`/`n` 被 TAB/CR/LF 吃掉；并给出自证：向 tracked 的 `AGENTS.md` 注入 `0x0C` → `files=163 violations=1`、`AGENTS.md @4569 byte=0x0c`，还原后 163/0 ✔
- 当前 `AGENTS.md` 四个正确词都在（`type:`、`remote`、`node_modules`、`feat/`），且用词边界扫 `\bype:`/`\bemote`/`\bode_modules`/`\beat/` **均 0 命中**（没有残留截断形态）✔

### 2.6 无功能变更与版本

- 代码改动面：`adapters.js`（新增纯函数）、`runtime.#writeCost`（改用纯函数）、`cg-status.js`（改用纯函数并改输出）、`no-control-chars.test.mjs`（改 tracked 扫描）、测试与文档；**未动**保护/回注/记忆/选择器。
- 对照实验：**0.1.17 快照 vs 0.1.18** 同周期跑——`stats`（剔除计时）、`failures`、审计事件集合、**成本四字段**全部一致；`auditVersion=cost-v1.4` 维持 ✔

## 3. 测试与证据

- **206/206 pass**（快照 `0d5655e`）；`m1.3-inference` 8→9 条（新增 status 两态用例）。
- 我的独立脚本：`.tmp/check-0117.mjs`（四字段，0.1.17 已验）、`.tmp/gate-semantics`（临时 git 仓库 tracked/untracked 语义）、`.tmp/compare-0117-0118.mjs`（行为/成本字段等价）。
- 闸真实仓库 163/0；status 三种形态实跑；`AGENTS.md` 词边界扫描 0 残留。

## 4. P3 清单

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| P3-1 | status 同一行同时有 `backend-kind=`（解析后枚举）和 `backend=`（**宿主 backend 版本**），字段名撞车，容易被误读成 adapter backend | `cg-status.js:41-45` | 下版可把版本字段改名 `backend-version=`（属输出契约变更，需用户/需求确认） |
| P3-2 | 闸只扫 tracked：新写的未跟踪文件在被 `git add` 前**不参与检查**；若发布包不是从 tracked 清单生成，可能绕过闸 | `test/no-control-chars.test.mjs` | 打包脚本明确用 `git archive`/`git ls-files` 生成 zip；发布前跑全量测试（现有流程满足） |
| P3-3 | `adapter=<实测 kind>` 与 `backend-kind=<解析枚举>` 可能不同（none 推断时 adapter=none、backend-kind=host-basic），文档需写清两者语义 | `docs/T5`、`README` | 文档补一句“adapter=实测；backend-kind=解析结果（可能由推断补位，见 backend-label）” |
| P3-4 | `AGENTS.md` 工作区当前是 CRLF/混合（blob 已规范化 LF）；闸允许 CR，但不同工具写入可能反复引入 CRLF | 仓库属性 | 已由 `.gitattributes` 规范到 LF，维持即可；无需动作 |

## 5. 真机验收观察点（桌面重启后）

1. `apply version=0.1.18`；`/cg status` 的 `backend-kind=` 应为 `none`（本部署实测 none），且**不出现** `backend-label=`。
2. 若某周期观察到 free-form：status 出现 `backend-kind=host-basic backend-label=host-basic (inferred)`；成本行四字段一致。
3. 成本行 `auditVersion=cost-v1.4` 不变。
4. 保护/回注/成本数值与 0.1.17 一致（仅解析/展示层重构）。

## 6. 边界与推送

- 未安装桌面/未重启、未改 profile、未动用户数据；只读 asar、会话日志与仓库。
- 拓扑直线（`b3ff739 → 0d5655e`）；本报告提交前先 `git log -1` 确认父提交，fast-forward push 只推分支、不打 tag。
- 基线口径：0.1.16=`8cb24b4`+`71cbe74`；0.1.17=`3485043`+`d079201`；0.1.18=`0d5655e`。
