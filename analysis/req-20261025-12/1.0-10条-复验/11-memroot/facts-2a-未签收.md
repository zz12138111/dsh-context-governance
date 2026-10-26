# 2a 真机首轮证据（事实汇总，**未签收**）

- 时间：2026-10-26 11:37:54（+08）
- 代码：`47c1a20`（`git rev-parse HEAD` = `47c1a207d5c74790642098c0bd6d2f39ae9aed3b`），插件版本 1.0.0
- 宿主：`DeepSeek Harness.exe` pid **5668**（CreationDate 2026/10/26 11:27:06），
  profile `C:\Users\19091\.dsh\profiles\desktop`
- 配置：`cordis.patch.yml` 已由 00 备份为 `cordis.patch.yml.bak-2a-20261026-112627` 并删除
  `projectRoot` 一行（121→120）；`memoryRoot` / `diagnostics` / `armed=false` 保留。

## 结论（仅事实）

**推断成功**：`source=inferred`，根 = `D:\DS-PROJECT\DSH插件开发`，
状态文件 = `C:\Users\19091\.dsh\context-governance\root-state-desktop.json`（233 B，创建 11:37:54）。

## 两段原文（`logs/governance.log` 行号）

第一段（根未知 → 非 git 会话失败；此段**没有**状态文件）：
```
 55|persistence-identity: source=profileContext name=desktop dir=C:\Users\19091\.dsh\profiles\desktop home=present anchor=home path=C:\Users\19091\.dsh\context-governance\root-state-desktop.json
 56|persistence: root=unknown (awaiting first inference)
 57|persistence: watching session/event for first cwd
 58|persistence: no-project-root session=session-53ece2c2-6726-4550-8d89-e7ac24e4ebc6 cwd=G:\DS-HARNESS
```
第二段（随后本区 git 会话 → 推断 → 落盘 → 完整 runtime；行 63–66 为带时间戳的启动/就绪行）：
```
 59|persistence-identity: source=profileContext name=desktop dir=C:\Users\19091\.dsh\profiles\desktop home=present anchor=home path=C:\Users\19091\.dsh\context-governance\root-state-desktop.json
 60|persistence: root=unknown (awaiting first inference)
 61|persistence: watching session/event for first cwd
 62|persistence: no-project-root session=session-53ece2c2-6726-4550-8d89-e7ac24e4ebc6 cwd=G:\DS-HARNESS
 63|2026-10-26T03:37:54.934Z governance capability@apply version=1.0.0 pid=5668 ...
 64|2026-10-26T03:37:54.937Z governance apply version=1.0.0 pid=5668 adapter=none mode=event-level host=0.2.1-rc.3 backend=unknown compaction-service=absent(token=compaction) perception=event event-api=on audit=D:\DS-PROJECT\DSH插件开发\memory\governance\audit.jsonl memory=D:\DS-PROJECT\DSH插件开发\memory\governance warning=provider-unavailable
 65|persistence-identity: source=profileContext name=desktop dir=C:\Users\19091\.dsh\profiles\desktop home=present anchor=home path=C:\Users\19091\.dsh\context-governance\root-state-desktop.json
 66|2026-10-26T03:37:54.941Z governance capability@ready version=1.0.0 pid=5668 ...
```
（`...` 处为能力探测长串，原文见 `diagnostics-numbered.txt`。）

## 状态文件（原文）

路径：`C:\Users\19091\.dsh\context-governance\root-state-desktop.json`
- 大小 233 B；CreationTime = LastWriteTime = 2026/10/26 11:37:54
- SHA256：`E254490B428BEFFA26F045931036DAB0B403F8EAF25316478938108228C767AA`
```json
{
  "version": 1,
  "root": "D:\\DS-PROJECT\\DSH插件开发",
  "source": "inferred",
  "inferredAt": "2026-10-26T03:37:54.715Z",
  "inferredFromCwd": "D:\\DS-PROJECT\\DSH插件开发",
  "instance": {
    "profile": "desktop"
  }
}
```

## 审计（`memory/governance/audit.jsonl` 原文）

```
{"ts":"2026-10-26T03:37:54.938Z","event":"persistence-identity","source":"profileContext","name":"desktop","dir":"C:\\Users\\19091\\.dsh\\profiles\\desktop","home":"present","anchor":"home","path":"C:\\Users\\19091\\.dsh\\context-governance\\root-state-desktop.json"}
{"ts":"2026-10-26T03:37:54.938Z","event":"inferred-fresh","root":"D:\\DS-PROJECT\\DSH插件开发","path":"C:\\Users\\19091\\.dsh\\context-governance\\root-state-desktop.json","inferredFromCwd":"D:\\DS-PROJECT\\DSH插件开发"}
```
审计目录仍是 `D:\DS-PROJECT\DSH插件开发\memory\governance\`（`memoryRoot` 相对推断根解析，1a 证据可连续 join）。

## “第一次失败没写状态文件”的证据

- 行 55–58 / 59–62 的 `no-project-root` 出现在 `root-state-desktop.json` **创建时间 11:37:54 之前**
  （日志行本身无时间戳；前一条带时间戳行是旧的 02:48:58，后一条是 03:37:54.934Z）。
- 状态文件 CreationTime = 11:37:54，且代码只在推断成功分支调用 `persistInferredRoot`（失败分支直接 return）。
- 因此“失败段没有状态文件”是**文件创建时间 + 写点代码**的合并证据；无法回溯证明目录当时为空。

## 观察（未定性，交审核判断）

日志里 `persistence-identity`/`root=unknown`/`no-project-root` 出现**两组**（55–58、59–62）。
当前宿主只有 pid 5668（11:27:06 启动），11:26:37 那次启动的进程已不在。
两组等价块的可能来源：11:26:37 首次启动的进程写了一组（随后被 11:27:06 的进程替换），
或同一进程 apply 两次。目前**没有**重复的 `apply`/`capability@apply`/`persistence-identity` 审计
（03:37:54 各恰 1 条），也未观察到重复注册告警；待审核判断是否需要追查。

## 未做/未含

- 未采集 `/cg status` 输出（按审核裁定：不加探针，2a 自带只读证据）。
- 未写签收结论；根变化可见性（`project-root-changed`）与重启沿用留 2b 真机门禁。
