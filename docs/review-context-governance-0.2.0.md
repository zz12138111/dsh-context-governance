# 复核基线 · dsh-context-governance 0.2.0（M2 首批：策略层 / 项目层加固 / 压力四段 / `/cg set`）

> 复核人：审核打包会话（cs_DNciCVhuZD）· 2026-10-26 00:1x +08
> 口径：只给问题与证据，**不下验收结论**；验收归用户。范围：REQ-20261025-09 · **0.2.0 = 配置/状态层**，不碰宿主压缩引擎（引擎接线属 0.2.1）。

## 0. 钉住的基线

| 项 | 值 |
|---|---|
| **代码基线** | `e6d859b`（0.2.0 收口，7 files，+639/−46）；另 `d071ca9` 也改 `src`（`/cg policy show` invalid 补 detail）——**00 把它归为文档，实际是代码提交**，故本轮“可运行代码”= `e6d859b` + `d071ca9` |
| **文档/杂项提交** | `7345f2b`（T5/README/样例/交付报告/STATUS）、`b5a7f3e`（DECISIONS 37/38/39）、`9e3b88e`+`532b44c`（ARTIFACTS）、`0ff7e0c`（STATUS+交付报告更正）、`1b818d4`（重启后核对清单）、`591f106`（该清单补 4b 真实 apply+audit 证据）；需求侧 `9fc474f`/`cc33a2a` |
| **快照** | `.tmp/snapshot-020-final/` = `git archive 591f106`（HEAD；`0ff7e0c`→`591f106` 仅新增 1 个 analysis 文档，`src/` 无字节变化）；工作树 clean |
| **全量测试（HEAD 快照内）** | **234/234 pass**（基线 218，+16；+16 全部来自 `m2-policy-status` 94→222 行与 `policy.test.mjs` +34） |
| **拓扑** | `origin/feat/context-governance-m1` = `56030dc` → … → `591f106`，**本地 ahead 18、直线**；tag 为空 |
| **独立探针** | `.tmp/probe-020.mjs`（gitignored）：**27/27 pass**；本报告所有“实测”均来自它 + 手工构造的临时项目 |
| **宿主/安装态** | 宿主 0.2.1-rc.3；桌面仍跑 **0.1.14**；0.2.0 未安装、未重启、未改 profile |

## 1. 结论摘要

- **阻断（P1）：0**；**应修（P2）：0**；**建议（P3）：9**（4 条文档/报告面、1 条可用性边界、1 条残余安全风险、1 条存量审计语义、2 条小一致性）。其中 P3-8/P3-9 为 4a 真机核对时追加（§8）。
- 00 的七条复核重点**全部成立**（§2 逐条给实测证据）。
- 我上一轮报的 **P2×2 + P3×6 全部闭环**，并有经 `apply` 的集成测试兜底（§4）。
- 代码可推分支；**是否上机/发布仍归用户**（§6）。

## 2. 逐项核对（00 的七点）

### 2.1 集成测试是否真“经 apply”

我不看断言、自己构造：临时目录写真 `.cg-policy.json{"compact.at":0.52}` → `apply(ctx, {projectRoot, compression.enabled=false})` → 取宿主注册的 `/cg` 定义执行：

```
policy show → layers: plugin (empty) -> project -> session (empty)
              compact.at=0.52 (source=project)
status      → policy: compact.at=0.52 (source=project)   （无 policy-invalid）
```

拒绝路径（项目文件加 `compact.lowThresholdAck:true`，插件层设 0.58）：

```
logger.warn → [context-governance] policy layer rejected (1): project/compact.lowThresholdAck:project-denied
status      → policy: compact.at=0.58 (source=plugin)
              policy-invalid: 1 (project/compact.lowThresholdAck:project-denied)
show        → invalid: compact.lowThresholdAck (source=project): project-denied — 项目层禁改安全参数
```

- `src/index.js` 全文件 `buildPolicyState` **只剩 2 处**：`:235` 定义、`:294` `apply` 调用；旧内联重建块（profile+plugin）已删除，命令侧（`:468 policy: policyState`）与审计（`:446` 循环）读同一份 ✔
- `apply` 时 `policyState.invalid` **同时**进 audit 与 `logger.warn`（前 5 条摘要）✔

### 2.2 A+C 整层拒绝（项目层按不可信输入）

实测矩阵（插件层固定 `at=0.5` 作下一层）：

| 项目文件内容 | 结果 | 生效来源 |
|---|---|---|
| `{"compact.at":0.45}` / `0.451` | 接受 | project |
| `{"compact.at":0.44}` | 整层拒绝（`below-min`，detail 写 0.45） | plugin |
| `{"compact.at":0.55,"compact.lowThresholdAck":true}` | 整层拒绝（`project-denied`），**0.55 也不生效** | plugin |
| `{"compact.at":0.55,"compact.estimateSafety":999}` | 整层拒绝 | plugin |
| `{"compact.at":0.2,"compact.lowThresholdAck":true}` | 整层拒绝（两个键都不许） | plugin |
| `{"compact.at":0.99}` | 整层拒绝（`over-native`，不支持推迟） | plugin |
| `{"compact.at":0.55,"compact.bogus":1}` | 整层拒绝（未知键） | plugin |
| 非对象 / 非法 JSON / 超 64KB | `layer-must-be-object` / `invalid-json` / `too-large`，不抛错 | plugin |

- 单测覆盖：`P-A`×2、`P-C`、`over-native`、`too-large`、`invalid-json` 均在 `test/m2-policy-status.test.mjs`；三类拒绝与“整层不逐键降级”都断言到 `sources` 回退 ✔
- **审计落盘实测**（compression enabled，临时项目）：`<project>/.dsh/memory/audit.jsonl` 出现
  `{"event":"policy-invalid","source":"project","reason":"project-denied","code":"compact.lowThresholdAck"}` ✔

### 2.3 路径安全与大小闸（我构造的逃逸用例）

| 输入 | 结果 |
|---|---|
| `../x.json`、`a/../../x.json`、`/etc/passwd`、`C:\x.json`、`C:/x.json`、`\\srv\share\x.json` | `resolveConfig` 直接抛 `policy.projectFile must be a relative path inside projectRoot` |
| `C:foo`（Windows 盘符相对，**不是** `isAbsolute`） | `resolveConfig` 放行，但 `buildPolicyState` containment 判 `outside-project-root` → 不读文件 |
| `conf/policy.json`（合法嵌套） | 正常读取、`source=project` |
| 65536 字节 | 读取（边界含） |
| 65537 字节 / 真实 fs 70KB 文件 | `too-large`，**读调用次数 0**，生效值退回 0.60 |

### 2.4 压力四段：只展示，不压缩

实测口径（`windowTokens=1e6, estimateSafety=1.35`）：

```
measured=0.583 estimated=0.412 adjusted=0.556(×1.35) effective=0.583 ratio=1.42
```

- 缺 usage / 缺 tokenMeter：`measured=- estimated=- adjusted=- effective=- ratio=- (no usage/tokenMeter yet)`，不伪造 ✔
- 只展示的独立证据：
  - `/cg` 命令侧源码无 `compactNow|compactIfNeeded|forceCompact|triggerCompaction` 命中 ✔
  - `runtime.js` 不消费 `policyState/buildPolicyState`（唯一 `computePressure` 命中是注释），即“策略层未接进压缩决策” ✔
  - `runtime.pressure()` 内只有 `#lastUsage.get`，无 set / 无压缩调用；`#lastSession` 在 `#belongsToProject` 通过后才赋值（不会把别的项目会话算进来）✔
- `measured` 取 `inputTokens+cacheReadTokens+cacheWriteTokens`（真实上下文侧），与需求 §4.2 一致 ✔

### 2.5 `/cg set` 进程内限制是否诚实

- **诚实**：`docs/T5-状态命令与审计.md:76`“覆盖是**进程内**的：重启插件即失效（0.2.0 未拿宿主会话 id，所以不宣称按会话隔离）”；`README.md:92` 同；`DECISIONS.md` `DEC-PLUGIN-20261025-39` 写明理由与影响 ✔
- 实测：`set compact.at=0.55` → `source=session`；`set compact.at=0.29` → 报错并回滚（`compact.at=0.55` 仍在）；`set compact.lowThresholdAck=true` → “只能在配置文件改”；`set reset` → 回落到 project 0.52；空参/`set show` 列当前覆盖；`policy-set` 审计为 `{source:'session', key, value}` ✔
- **但用户面文档不诚实**：`docs/M2-使用说明-草案-v0.1/v0.2` 仍写“**每个会话**单独设定比例”“`/cg set compact.at=0.5` → **本会话**改成 50% 就压”，并列出 **`/cg cost`、`/cg compact now`** 两个当前不存在的命令（实测返回 usage 错误）→ P3-1、P3-5。

### 2.6 `src/` 本批无引擎引用

- `git diff 1ad5703 0ff7e0c -- packages/dsh-context-governance/src` 的**新增行**对 `agentPresets|serviceFor|compactNow|ctx.compaction` **0 命中**；本批 diff 不含 `adapters.js` ✔
- 现存引用均为 M1 时代：`adapters.js:287/293`（`compactNow` capability probe）、`index.js:341`（`ctx.compaction ??` 探测回退）——本批未改其语义 ✔
- 0.2.0 生产代码无 `ctx.compaction` 改写/替换；G1 探针仍在 `analysis/req-20261025-09/gate-probe-src/`，不在 `files`（发布包 = `src`/`test`/`README.md`/`cordis.patch.yml`）✔

### 2.7 文档面：`early=ready` 清零 / 空层 / fixture

- `early=ready` 全仓仅剩 `analysis/req-20261025-09/0.2.0-交付报告.md:17` 的“已修”记录行，实际文档/样例 0 残留 ✔
- 空层标注实测：`layers: plugin (empty) -> project -> session (empty)`；有项目层时 `project` 不带 `(empty)` ✔
- fixture 首行：`samples-0.2.0.txt` 7 条全部带 `# fixture: profile=…, projectFile=…, host=…, cmd=…`；v0.5/v0.6 示例块同加 ✔
- 新增 `analysis/req-20261025-09/重启后核对清单.md`（`1b818d4`/`591f106`）：四项命令、期望输出、`source=` 形状与实现一致；其 §4b 用“压缩启用 + 临时 projectRoot”补的真实 apply/audit 证据，与我 §2.2 的实测一致 ✔

## 3. 问题清单（P3，建议级）

| 编号 | 位置 | 现象（实测） | 建议 |
|---|---|---|---|
| **P3-1** | `docs/M2-使用说明-草案-v0.1/v0.2`（`:10-20`、`:32-34`、`:42-44`、`:69-71`） | 面向使用者的文档写“每个会话单独设定比例”“本会话改成 50% **就压**”“装完即生效，默认已开启提前压”，并列出 `/cg cost`、`/cg compact now`——0.2.0 引擎未接线、`/cg set` 是进程内覆盖、这两个命令不存在。与 T5/README/交付报告自相矛盾 | 顶部加一段 0.2.0 预览声明：策略/压力只读展示，实际提前压 0.2.1 接线；`/cg set` 进程内、不按会话隔离；未实现命令标“0.2.2 计划” |
| **P3-2** | `src/commands/cg-status.js:259-273` | 配置层本身已带 `low-threshold-unacked`（如插件层 `at=0.25` 未确认）时，**无关的** `/cg set compact.early=off` 也被挡住，报 `compact.at=undefined 低于 0.30…`（实测） | 只判本次 `pairs` 引入的 unacked（或仅当 `pairs` 含 `compact.at`）；消息按实际键渲染 |
| **P3-3** | `cg-status.js` 压力行 / `policy.summarizePressure` | 四段全部按 `policy.windowTokens`（默认 1,000,000）归一，但 `/cg status` 不打印窗口值；实际窗口不同时读数整体偏移且无从判断 | 压力行（或 `policy:` 行）带 `window=1.00M`；若 G4 定为动态来源，再替换 |
| **P3-4** | `src/index.js:250-252` containment | `path.resolve` 是**词法**层：项目内 `conf/` 若是 junction/symlink 指向项目外，`conf/policy.json` 仍会被读。Windows git 默认不落 symlink，风险低，属残余面 | 文档声明“词法 containment、不解析链接”；或在 0.2.1 加 `realpath` 比较（不阻断 0.2.0） |
| **P3-5** | `analysis/req-20261025-09/0.2.0-交付报告.md:33` | 写“`/cg set <key>=<value>` / `list` / `reset`”，但实现**没有** `list`（实测 `set list` → `list 缺少值`；列表是空参或 `set show`） | 改成“空参 / `set show` 列出”；`/cg set list` 可以顺手支持为别名 |
| **P3-6** | `cg-status.js:220-258` | 一条命令里重复键（`compact.at=0.5 compact.at=0.4`）成功返回 `applied: compact.at=0.5, compact.at=0.4`，审计写 2 条，实际后写胜 | 拒绝重复键（报错），或去重后只报最终值 |
| **P3-7** | `docs/T5` §1.1 / `README.md` 策略层 | 项目文件只在 `apply` 读一次，改了 `.cg-policy.json` **必须重启/重载插件**才生效；`analysis/.../重启后核对清单.md:4-5` 已写明，但 T5/README 只说“apply 算一次”，没直说改文件要重启（`/cg set` 反而写明重启失效） | 在 T5 §1.2 / README 加一句“改项目文件后需重启插件生效” |
| **P3-8** | `src/audit.js:257`（`#ensureFile()`） | `audit size=` 显示的不是文件字节数，而是**本进程写入量**：构造时把 `#sizeBytes` 置 0，getter 却声称“当前审计文件字节数”。真机实测：文件 42 行/14990 字节，`size=1379`＝重启后 3 条启动事件字节和（219+580+580）。轮转同按此计数（T6 §3.3 写的是“当前大小”），单文件可超出上限至“既有大小 + 8 MiB”；`(this-process)` 只修饰 `recentFailures`。**存量缺陷**（0.1.6 `3cb6177` 引入，0.2.0 未触碰） | `#ensureFile` 末尾改 `#sizeBytes = null`（或建文件后 stat 一次），让 getter 取真实大小；补“历史文件已存在时 sizeBytes/轮转”单测 |
| **P3-9** | `analysis/req-20261025-09/samples-0.2.0.txt:6,10,61,65` | 样例写 `adapter=none … summary=readable/free-form` 且 `conflicts: none`，与代码和真机矛盾：`kind='none'` 时 summary 固定 `unknown/unknown`，conflicts 至少 3 条（`no-compaction-service` / `self-check-failed` / `backend-version-unverified`），真机也是 `summary=unknown/unknown` + `self-check-failed(error)` | 重跑样例（用真实 guard 输出）或在文件头标注“示意/裁剪，非实跑”；`summary` 只在观察到压缩摘要后才变 readable/free-form |

> 说明：P3-1/P3-5/P3-9 是文档/报告面，不影响代码运行；P3-2 只在“配置本身已误配”时出现；P3-4 需要仓库里带目录链接才成立；P3-8 是 0.1.6 起存量语义 bug（无数据丢失）。**均不阻断 0.2.0 策略层交付**。

## 4. 上一轮（0.2.0 中途）问题闭环

| 上轮编号 | 级别 | 状态 | 证据 |
|---|---|---|---|
| apply 未接 `buildPolicyState`、项目层未交付、单一来源被破坏 | P2 | **已闭环** | §2.1：`index.js` 仅 2 处；集成测试 `①`/`①b` 真经 apply；我独立复跑一致 |
| 项目文件信任面：路径逃逸 / 无大小上限 / 可自盖 `<0.30` 确认 | P2 潜在 | **已闭环** | §2.2/§2.3：containment + 64KB + `project-denied` + 0.45 下限 + 整层拒绝；审计落盘实测 |
| 文档 `early=ready`（旧“引擎就绪”义） | P3 | **已闭环** | §2.7 |
| `layers:` 空层误导 | P3 | **已闭环** | §2.7 `(empty)` |
| 样例无 fixture 标注 | P3 | **已闭环** | 7 条 fixture 首行 |
| `/cg status` 不显示 invalid | P3 | **已闭环** | `policy-invalid:` 行 + apply warn + 审计三通道 |

## 5. 未验证 / 边界（不在本轮结论内）

1. **真机未装**：桌面仍加载 0.1.14（21:18），0.2.0 未安装/未重启；`/cg status` 的 `pressure:` 在真实 1M 窗口/真实 usage 下的数值只有 fixture 与单测，**真机未验**。
2. **G4 未决**：`native` 仍由配置 `windowTokens/reservedTokens` 计算（默认 1M/256k → 0.6785）；宿主动态来源等 0.2.1 前结论。
3. **0.2.1 范围未做**：`agentPresets.serviceFor` 引擎接线、`early-channel`、冷却/增量门槛的真实判定；本轮只确认“没有偷偷接”。
4. 0.1.15+ 的真机观察点（下一次真实压缩后 `batch-list` 不误 fail、`protection-skip.reason` 三态、`manual-compaction-loss` 只留真丢失）仍未验——与 0.2.0 无关，沿用上轮。
5. S1–S6 回归由 234 条单测覆盖，未上机。

## 6. 发布口径（建议，不代决）

- **分支**：本报告随 `feat/context-governance-m1` fast-forward 推送；**不打 tag、不发 Release**（归用户）。
- 若用户决定发 0.2.0：建议 tag `v0.2.0` → **本报告提交后的 HEAD**（含代码 + 文档），zip 用 `git archive <tag>` 生成（控制字符闸只扫 tracked，发布包必须由 tracked 内容生成）。当前 tag 为空；`v0.1.18` 建议仍指 `56030dc`（若还要发 0.1.x 线）。
- **安装/重启仍归用户**：需 00 + 用户批准后执行；我不装、不重启、不改 profile。
- **回滚点**：`1ad5703`（开发给的 0.2.0 收口前）＝ `e6d859b^` 链上位置。

## 7. 复核复现方式

```powershell
git archive --format=tar --output=.tmp/h.tar 591f106
tar -xf .tmp/h.tar -C .tmp/snapshot-020-final
cd .tmp/snapshot-020-final/packages/dsh-context-governance
node --test "test/*.test.mjs"        # 234/234
node --test test/no-control-chars.test.mjs   # 1/1（当前 tracked 176 files, 0 violations）
node .tmp/probe-020.mjs              # 审核侧独立探针 27/27（.tmp 已 gitignore）
```

## 8. 补记（2026-10-26 00:2x）：4a 真机确认 + 三处疑点核查

**4a 真机通过**（用户手打真机 GUI，非等价进程）：`compact.at=0.52 (source=project) native=0.6785 early=on`、`layers: plugin (empty) -> project -> session (empty)`、`invalid: none`，与我的等价进程输出逐字对齐。`/cg status` 另有 `events=344`、压力四段 `measured=0.197 estimated=0.135 adjusted=0.182(×1.35) effective=0.197 ratio=1.46 at=0.52 effective<at`；删掉 `.cg-policy.json` 后仍显示 `source=project`，证明 apply 只读一次（不是每条命令现读）。

**Q1 `audit size=1379` vs 文件 14990 字节**：**是语义 bug（存量，非 0.2.0 引入）**，落 P3-8。构造 `AuditLog` 时 `#ensureFile()` 把 `#sizeBytes` 置 0，而 getter 本意是“当前文件字节数”。真机 `size=1379` 恰好等于重启后 3 条启动事件字节和（`apply` 219 + `capability@apply` 580 + `capability@ready` 580），文件实际 42 行/14990 字节。后果：显示误导；轮转按“本进程写入量”判断（T6 §3.3 写的是“当前大小”），单文件可超出上限至“既有大小 + 8 MiB”；`(this-process)` 只修饰 `recentFailures`。修法一行：`#ensureFile` 末尾改 `#sizeBytes = null`。

**Q2 `self-check-failed(error)`**：适配器自检的 `compaction-service` 检查失败（detail `no usable ctx.compaction provider`）——宿主没挂 `ctx.compaction`（audit `get.compaction=absent`、日志 `compaction-service=absent(token=compaction)`、`warning=provider-unavailable`）。**M1 起既有**：0.1.18 的 `cg-status.js` 同样有 conflicts 行、同样的自检，同样会打印这条；`selectMode` 对 `kind='none'` 显式特判为 `event-level`（`selection.js:97-105`），因此不是降级、也不是 0.2.0 回归。另：代码里 conflict code 是连字符（`self-check-failed`、`backend-version-unverified`），真机粘贴里是点号，属转写差异。

**Q3 `summary=unknown/unknown`**：取自适配器字段——`kind='none'` 时固定 `unknown`，与“是否压过”无关；0.1.18 真机同样是 `unknown/unknown`（见 0.1.18 复核报告 §2.2），不是 0.2.0 新逻辑。只有真正观察到压缩摘要后才会变 `readable|partial|unreadable` + `five-section|free-form`（`runtime.js:1445 applySummaryObservation`）。**但** dev 的 `samples-0.2.0.txt` 写 `adapter=none … summary=readable/free-form` 且 `conflicts: none`，与代码/真机矛盾，落 P3-9。


## 9. P3 闭环预检（2026-10-26 00:4x，复核提交 `d4d680d`，测试快照 `ae34f34`）

预检口径：`git archive ae34f34` 快照内全量 **240/240**；P3-8 用真机同形 `14990B/42 行` 文件独立复跑（不看开发单测）；P3-2/3/5/6 在快照代码上跑端到端。

| 编号 | 状态 | 复核证据 |
|---|---|---|
| P3-1 使用说明声称未实现功能 | **已闭环（725b04b 复检）** | v0.3 顶部版本矩阵 + 正文逐处修正：`:42` 改“装完即生效的是策略层（0.2.0）；0.2.0 没有引擎接线，不会提前压”、`:54` 改“临时改（进程内覆盖、重启失效）”、`:56/62` 的 `/cg cost`（0.2.3 计划）/`/cg compact now`（0.2.2 计划）加版本标记、`:137/139` FAQ 同步、`:46` 加版本节奏；`v0.1` 顶部标“已被 v0.3 取代，仅存档”并声明“本会话/每个会话/两个命令均为当时计划口径，当前不成立”。复核时全文 grep `本会话\|每个会话\|/cg cost\|/cg compact now\|装完即生效` 无未标注的现在时声称 |
| P3-2 `/cg set` 被配置层遗留 unacked 误挡 | 已闭环 | 快照实测：插件层 `at=0.25`（unacked，policy-invalid 在）时 `/cg set compact.early=off` **成功**；代码只判 `source==='session'` 的 unacked，报错文案用 `next/previous` 回退值 |
| P3-3 压力行不带窗口 | 已闭环 | 实测 `pressure: … ratio=1.46 window=1.00M at=0.52 effective<at`；`formatWindow` 输出 `1.00M/256k` |
| P3-4 containment 词法层 | 已闭环（文档） | README/T5 均补“词法层，不解析 junction/symlink” |
| P3-5 交付报告写有 `list` | 已闭环 | 交付报告 §1 改为“空参（`set show`、`set list` 同义）/ `reset`”；`/cg set list` 已作为别名实现 ✔ |
| P3-6 重复键 last-wins | 已闭环 | 实测 `set compact.at=0.5 compact.at=0.4` → 报错“重复键 compact.at（一条命令里每个键只能设一次）” |
| P3-7 改项目文件需重启未写 | 已闭环 | README/T5 §1.2 已补“只在 `apply` 读一次：改文件后需重启插件才生效” |
| P3-8 `audit size=` 是本进程写入量 | 已闭环 | `audit.js` 三处 `#sizeBytes = 0` → `null`（getter 真 stat；轮转/追加后重新 stat）。**独立复跑**：真机同形 42 行/14990B → `sizeBytes=14990`，追加后 15059=真实；65500B 历史文件 + 69B 追加 → `rotations=1`、当前文件 69B（旧代码从 0 起算不会轮转）。开发 3 条单测覆盖“历史大小/追加/跨 64KB 轮转” |
| P3-9 样例不可复现 | 已闭环（标注法） | `samples-0.2.0.txt` 首行加 `# sample: 示意/裁剪，非实跑（mock guard；真机 adapter=none 时 summary=unknown/unknown、conflicts 非空）` |

**结论**：**9/9 已闭环**（P3-1 于 `725b04b` 复检通过，其余 8 条在 `d4d680d`）。
