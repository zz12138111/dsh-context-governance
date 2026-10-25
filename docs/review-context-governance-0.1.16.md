# 复核基线 · dsh-context-governance 0.1.16（控制字符闸 + backend 三字段 / cost-v1.4）

> 复核人：审核打包会话（cs_DNciCVhuZD）· 2026-10-25 23:2x +08
> 口径：只给问题与证据，不下验收结论；验收归用户。

## 0. 钉住的基线

| 项 | 值 |
|---|---|
| **代码基线** | `8cb24b4`（0.1.16 主提交）+ `71cbe74`（控制字符闸扫描计数） |
| 需求文档 | `e5bf9b2`（REQ-20261025-07 出单） |
| 快照 | `.tmp/snapshot-0116/`（`git archive HEAD` = `71cbe74`） |
| 全量测试 | **204/204 pass**（0.1.15 为 202，+2：控制字符闸 1 + 无观察用例 1） |
| 拓扑 | `caea83f（origin）→ e5bf9b2 → 8cb24b4 → 71cbe74`（直线） |
| 宿主/安装态 | 0.2.1-rc.3；桌面未安装/未重启 |

## 1. 结论摘要

- **阻断（P1）：0**；**应修（P2）：0**；**建议（P3）：4**。
- **A 控制字符闸**：README 按字节已无违规字符；闸**真的会响**（我注入 0x07 后 fail 并打印 `@偏移 byte=0x07`）；扫描范围/允许字符符合要求（但只覆盖包内，见 P3-1）。
- **B backend 三字段**：四形态表逐项成立——`backend` 恒为枚举、`backendKind === backend`、`backendLabel` 才可带 `(inferred)`；无观察三字段 `unknown/unknown/false`；实测可得时保持 measured。
- **无功能逻辑变更**：我用 0.1.15 快照做对照，同一周期的 stats、failures、功能审计事件集合**完全一致**。

## 2. A. 控制字符闸（P3-1）

### 2.1 README 按字节核

- 当前 `packages/dsh-context-governance/README.md`（10878 字节）全文件**无** 0x00–0x08 / 0x0B / 0x0C / 0x0E–0x1F / 0x7F（只允许 \t\n\r）。
- 说明：0.1.15 那行是**整句重写**（不是原地补字节），所以旧的 `@8269`/`@8317` 偏移已不再对应；直接验证词语——新 0.1.16 行里 **`backendInferred`**、**`auditVersion=cost-v1.4`** 拼写完整、无控制字符。
- 旧 0.1.15 行现在写作“只进 /cg status/审计展示，功能路径不读推断”，不再出现被吞字母的 `ackendInferred`/`uditVersion`。

### 2.2 闸自证（我复现过）

- 原始跑（包内 54 个文本文件）：`scanned files=54 violations=0`、**pass**。
- 我在 `.tmp/gate-test/pkg/README.md` **注入 0x07**（offset 10878）后重跑同一测试：
  `scanned files=54 violations=1` → **fail**，断言信息 `README.md @10878 byte=0x07`，`exit=1`。
- 结论：闸不是恒过，命中会打印“文件 @偏移 byte=0xNN”。

### 2.3 范围/允许字符

- 扩展名：`.js .mjs .json .md .yml .yaml .txt`（要求是 `.md/.js/.mjs/.json/.yml`，这里更宽，没问题）；跳过 `node_modules`/`.git`。
- 禁用字节：`≤0x08`、`0x0B`、`0x0C`、`0x0E–0x1F`、`0x7F`；允许 `\t(0x09)/\n(0x0A)/\r(0x0D)` —— 与要求一致。
- **范围只到包根**（`PACKAGE_ROOT = packages/dsh-context-governance`）；仓库根 `AGENTS.md` 仍有 `0x0C@2907`（在 `9e8eb73` 时就存在，非本单引入），不在闸覆盖内（P3-1）。
- 闸以 `node --test` 测试形式存在，跑全量测试即生效；没有独立 pre-commit/CI 钩子。

## 3. B. backend 三字段（P3-2 修复）

### 3.1 四形态表（我逐个跑出来的，不是抄报告）

| 形态 | `backend` | `backendKind` | `backendLabel` | `backendInferred` |
|---|---|---|---|---|
| free-form（实测 none） | `host-basic` | `host-basic` | `host-basic (inferred)` | `true` |
| five-section（实测 none） | `context-zip` | `context-zip` | `context-zip (inferred)` | `true` |
| mixed（两轮形态不同） | `unknown` | `unknown` | `mixed (unverified)` | `true` |
| 无观察（空摘要） | `unknown` | `unknown` | `unknown` | `false` |
| 实测 `host-basic`（不补位） | `host-basic` | `host-basic` | `host-basic` | `false` |

- `backend` 全部满足 `^(host-basic|context-zip|unknown)$`，**无括号/空格**；`backendKind === backend` ✔
- `backendLabel` 才允许带 ` (inferred)` / ` (unverified)` ✔
- `auditVersion=cost-v1.4`；`backendKind`/`backendLabel` 已进审计白名单（`text`）✔；`backendInferred` 仍是显式布尔 ✔

### 3.2 mixed 的 kind 归属（回答 00 的第 5 点）

- 现行实现：`mixed → backendKind=unknown、backendLabel="mixed (unverified)"、backendInferred=true`。
- 我的判断：**归到 `unknown` 更诚实**——`backendKind` 的枚举空间是“实测后端”（host-basic/context-zip），`mixed` 不是一个后端，而是一种**观察冲突/低置信状态**；把它当 kind 会诱导下游把它当第三类后端。`backendInferred=true` 表示“该行不是实测得出的”，与 label 的 `(unverified)` 一起已经能自解释。
- 若下游确实需要区分“没观察到”与“观察到混合”，建议（不阻塞）再加 `inferenceKind=mixed` 或复用 `backendLabel` 判断——不建议把 `mixed` 塞进 `backendKind`。

### 3.3 `/cg status`

- 已改为 `backend-label=<label>`：实测 `adapter=none` + free-form → `adapter=none backend-label=host-basic (inferred)`；实测 `host-basic` → `adapter=host-basic backend-label=host-basic`；旧的 `inferred=` 标记已移除。
- 我验证了“实测 kind 可得时 status 不打印 inferred”（脚本 D 组）。

## 4. 无功能逻辑变更（证据）

- 代码改动面：`audit.js`（白名单 +2）、`cg-status.js`（改成 backend-label）、`runtime.js`（仅 `#writeCost` 的归属字段与 version）、测试；**未动** `selection.js`/`protection.js`/回注/记忆/成本计算。
- 我用 **0.1.15 快照 vs 0.1.16** 跑同一周期（free-form，同一 fixture）对照：`stats`（events/protectionWrites/reinjections/失败计数）**完全一致**、`lastReport.failures` 名称一致、**功能审计事件集合（剔除 `adapter-inferred`）完全一致**；差异只在成本行归属字段（v1.3 写 label → v1.4 写 enum+kind+label）。
- 0.1.15 的“推断不参与行为”结论不受影响（选择器/保护/回注路径仍零读取 inference）。

## 5. 测试

- **204/204 pass**（快照 `71cbe74`）；+2 = `test/no-control-chars.test.mjs`（1 条）+ `m1.3-inference` 新增“无观察”用例（1 条）。
- `m1.3-inference` 的既有断言已全部改为新字段（backend 枚举 + backendKind + backendLabel），并含 `backend 不含空格/括号` 的断言。

## 6. P3 清单

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| P3-1 | 控制字符闸只覆盖包内；仓库根 `AGENTS.md` 仍有 `0x0C`（早于本单，非回归） | `test/no-control-chars.test.mjs` | 可选把扫描扩到 `docs/`、`analysis/`、仓库根；或明确“闸只保护发布包” |
| P3-2 | 实测 `none` 在成本行被折叠成 `unknown`，与“实测 unknown/无法识别”不再可区分（status/apply 行仍显示 `adapter=none`） | `runtime.js#writeCost` | 若下游需要区分，可保留 `none` 枚举或加 `backendMeasured=none`；当前文档已说明“只在实测可得时写枚举” |
| P3-3 | `mixed` 行 `backendKind=unknown` + `backendInferred=true` 语义上有点绕（“推断出一个 unknown”） | 同上 | 保持现状即可；如需更细，加独立 `inferenceKind` 字段，别改 backendKind 枚举空间 |
| P3-4 | 闸只有 `node --test` 入口，没有独立脚本/钩子；若发布流程跳过测试则闸不生效 | `test/no-control-chars.test.mjs` | 发布前跑全量测试（现有流程已如此）；可选加 `scripts/` 入口 |

## 7. 真机验收观察点（桌面重启后）

1. `apply version=0.1.16`；`compaction-cost.auditVersion=cost-v1.4`。
2. 成本行 `backend`/`backendKind` 为枚举、`backendLabel` 带 `(inferred)`/`(unverified)`（视形态）。
3. `/cg status` 出现 `backend-label=…`，不再有 `inferred=`。
4. 实测 kind 可得时 `backendInferred=false`、`backendLabel` 与 `backend` 一致。
5. 保护/回注/成本数值行为与 0.1.15 一致（仅归属字段变化）。

## 8. 边界与推送

- 未安装桌面/未重启、未改 profile、未动用户数据；只读 asar、会话日志与仓库。
- 拓扑直线（`caea83f → e5bf9b2 → 8cb24b4 → 71cbe74`）；本报告提交前先 `git log -1` 确认父提交，fast-forward push 只推分支、不打 tag。
- 基线口径：0.1.11=`01a7598`；0.1.12=`a75ce82`；0.1.13=`2cea1ca`；0.1.14=`b6729da`；0.1.15=`fd0b08d`；0.1.16=`8cb24b4`+`71cbe74`。
