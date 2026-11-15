# 1.1.0 终版复核与出包（a3ff87d）

日期：2026-11-15｜对象 commit：**`a3ff87d`**（C36 + D 项目模板 + C38 会话级记忆，含 W1–W6 收口）｜签发：审核打包
状态：**可装 = 是；可发 = 待装机后真机**（CP1–CP8 + C36/C37/C38 真机项未跑）。

## 1. N3 复核（我逐条核代码，不只看状态表）

| 项 | 结论 | 证据 |
|---|---|---|
| CP0 能力前置门 | **16/16 PASS**（39 源文件，exit 0） | `tools/cp0-capability.mjs` 对 clean a3ff87d |
| 全量测试 | **615/615 pass / 0 fail**（我自跑 4.2s） | 干净 worktree |
| W1 A2 活跃保护 | 闭。`recentGovernedSessions` 由无界 Set 改 **`Map<sessionId,tick>`**：10 分钟内算活跃、超 500 条按 lastSeen 淘汰、去掉重复 `markActive` 键 | `index.js` `markSessionActive/isSessionActive` |
| W2 `read()` 静默删 | 闭。过期只返 null，统一由 `evict` 处理（带审计） | `a2-store.js` |
| W3 `a2-evicted` 字段 | 闭。带 `sessionIds` 列表 | `a2-store.js` |
| W4 `policy-resolved` 每 cycle | 闭。`compaction/start` 首次解析写一条、按 `compactionId` 去重、Set 上限 500、带 `at/source` | `runtime.js:2542-2565` |
| W5 C37④ 模板缓存 | 闭。`policyForEntry` 每次比 `stat(mtimeMs:size)`，删/改即重建；每根用 `entry.root` 各读自己的文件 | `index.js` `projectTemplateSignature` |
| W6 header/legacy/文档 | 闭。`resolvePointers` 非空优先 → 短行 header，超限 `header-truncated` 经 `onTruncated` 落审计；`import.js` 只写 `legacy-shared-v1.json` 标记不改内容；`analysis/.../C38-实现记录-20261115.md` 在 | `header.js`/`import.js`/`index.js` |
| C38 ⑮–⑱ | 闭。默认 `session`（`=0` opt-out）；`memory-mode{sessionId,mode}` 审计 + `/cg status:130` 显示；`memory-legacy-detected` 提示不自动迁移；无 sid 根写拒 `LEGACY_READ_ONLY`、带 sid 写正文拒 `POINTER_ONLY` | `index.js`/`mem-tools.js:353`/`c38-mem-default.test.mjs` |

已知偏差（开发声明，我认同不阻塞）：C37④ 无独立单测（实现静态可核 + 真机可验）；header 空指针库不注入（契约）。

## 2. N4 出包核对（从提交树构建）

| 项 | 值 |
|---|---|
| 产物 | `dist\dsh-context-governance-1.1.0.zip` |
| 大小 | **243,370 B** |
| SHA256 | **`37F7000104C77A7557D2A3D7120A63D5FE02DA9A7B4DD19E141BED6B23B123D5`** |
| 文件数 | **43**（`src/` 38 + `lib/client.js` + `package.json` + `README.md` + `cordis.patch.yml` + `LICENSE`） |
| 逐文件对树 | 解 zip 后逐文件 SHA256 对 `a3ff87d` → **43/43 内容一致、0 缺失、0 不符、0 越界** |
| 禁入目录 | `test/` `docs/` `analysis/` `node_modules/` `.git/` `dist/` `coverage/` 均 **0** |
| 合规扫描 | `compliance-scan --strict` → **blocker 0 / review 0 / info 0**，43 文本 / 16,760 行，退出码 0 |
| 版本 | `package.json` `version=1.1.0` |
| SUMS | `dist\SHA256SUMS-1.1.0` 同值 |

构建方式：干净 worktree 检 `a3ff87d` → `npm pack`（43 文件 / 214,834 B tgz）→ 解包改顶层名 `dsh-context-governance-1.1.0` → zip。不碰工作树。

## 3. 签发

- **可装 = 是**（`a3ff87d`）。
- **可发 = 待真机**：装机后需验 CP1–CP8 + C36（两会话 A2 重启保留、`session-governed` 自动纳入、`root-unresolved` 不静默）+ C37（无模板不出 `project`、删文件立即失效、`/cg status` 可见）+ C38（两会话指针库隔离、`--from-role` 原记忆不变、legacy 只读+显式导入、header 短行）。
- **建议 tag**：`v1.1.0`（终版，不带 rc；rc.1–rc.3 为 RC 线）。**等用户批**；Release 另定。
- **行为变更需 00 转用户知情**：`mem_*` 默认写会话指针库；legacy 根只读、不自动迁移（`memory import --from legacy --session <id>` 显式导入）；`DSH_CG_SESSION_MEMORY=0` 可回退并写 `memory-mode{legacy}`。
- 未做：未装 00 的 profile（本次是审计侧出包）、未重启、未打 tag、未建 Release。
