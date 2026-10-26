# 1a 真机派发证据（A 级）：宿主 `commands.execute` 通道

- 时间：2026-10-26 10:35:56 +08:00（UTC 02:35:56）
- 宿主进程：pid **4068**（插件 1.0.0，`capability@ready` 02:35:56.302Z）
- 探针 commit（临时）：**`5992cdd`**（叠加在 `b23b74d` 上）；pre-probe 基线 `d05c1eb`
- 探针文件（原样未裁剪）：`C:\Users\19091\AppData\Local\Temp\cg-1a-probe-1792982156614.json`（9481 B）
- 同目录附件：`real-invocation.json`（9481 B，sha256=`05d1f6f72759973eeb2d0a0ed715a588597424c25ebd89df05cf37b7f3729540`，00 已复核）

## 1. 渠道与构造器锚点

派发渠道 = **宿主 `commands.execute(agent, line, submittedAttachments, signal)`**（插件内临时探针调用；`agent` 来自 `ctx.get('agents').list()`）。

- 服务名：`super(ctx, "commands")` → `/dsh/node_modules/@deepseek-ai/dsh-commands/lib/index.js:260`
- 派发方法：`:328` `async execute(agent, line, submittedAttachments, signal)`
- `@Remote` 装饰：`:215/220/232`
- **invocation 构造器**：`:380` `const invocation = Object.freeze({ commandId, agent, rawInput: parsed.rawInput, attachments, signal })`
- **与 slash 共用同一构造器**：桌面 slash 走 `ctx.remote.commands.execute(sessionId, line, attachments)`（`/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js:2475`）→ 命中同一个 `@Remote execute` → 同一个 `:380` 构造器。IM（QQ 等）的 `ctx.typertGateway.invoke({namespace:'commands',method:'execute',args:{agentId,line,images:[]}})`（`dsh-im/plugin-src/host/harness-command-executor.mjs:18-27`）也落到同一 execute。

> 结论：本次证据不是直调 handler、不是自造 invocation，而是宿主 `execute` 用真实 agent 构造 invocation 后调用插件 handler。

## 2. 探针执行（10 步全部 success）

会话：`session-53ece2c2-6726-4550-8d89-e7ac24e4ebc6`；初始状态：`armed=false`（来源 config/default）、profile 默认（none）。

| # | line | commandId | kind |
|---|---|---|---|
| 1 | `/cg compact status` | `cmd-dc117694-1` | success |
| 2 | `/cg profile status` | `cmd-dc117694-2` | success |
| 3 | `/cg compact disarm` | `cmd-dc117694-3` | success |
| 4 | `/cg status` | `cmd-dc117694-4` | success |
| 5 | `/cg profile review` | `cmd-dc117694-5` | success |
| 6 | `/cg status` | `cmd-dc117694-6` | success |
| 7 | `/cg profile reset` | `cmd-dc117694-7` | success |
| 8 | `/cg compact arm` | `cmd-dc117694-8` | success |
| 9 | `/cg compact disarm`（按初始值复原） | `cmd-dc117694-9` | success |
| 10 | `/cg profile reset`（复原） | `cmd-dc117694-10` | success |

## 3. 宿主 `command/run` 原始事件（10 run + 10 done，seq 42079–42098）

probe JSON 的 `commandEvents` 捕获本会话 `command/run`/`command/done`，共 20 条（10 run + 10 done），seq 范围 **42079–42098**。run 事件（时间本地 +08:00）：

```
command/run seq=42079 time=10:35:56.301 name=cg cmd=cmd-dc117694-1 src=user
command/run seq=42081 time=10:35:56.304 name=cg cmd=cmd-dc117694-2 src=user
command/run seq=42083 time=10:35:56.304 name=cg cmd=cmd-dc117694-3 src=user
command/run seq=42085 time=10:35:56.304 name=cg cmd=cmd-dc117694-4 src=user
command/run seq=42087 time=10:35:56.306 name=cg cmd=cmd-dc117694-5 src=user
command/run seq=42089 time=10:35:56.306 name=cg cmd=cmd-dc117694-6 src=user
command/run seq=42091 time=10:35:56.306 name=cg cmd=cmd-dc117694-7 src=user
command/run seq=42093 time=10:35:56.307 name=cg cmd=cmd-dc117694-8 src=user
command/run seq=42095 time=10:35:56.307 name=cg cmd=cmd-dc117694-9 src=user
command/run seq=42097 time=10:35:56.307 name=cg cmd=cmd-dc117694-10 src=user
```

对应 `command/done` seq=42080/42082/…/42098（与 run 一一配对）。

## 4. 审计原始行（全 id + 短 id）

```json
{"ts":"2026-10-26T02:35:56.304Z","event":"early-disarmed","source":"session","sessionId":"session-53ece2c2-6726-4550-8d89-e7ac24e4ebc6","sessionShortId":"53ece2c2"}
{"ts":"2026-10-26T02:35:56.307Z","event":"early-armed","source":"session","sessionId":"session-53ece2c2-6726-4550-8d89-e7ac24e4ebc6","sessionShortId":"53ece2c2"}
{"ts":"2026-10-26T02:35:56.307Z","event":"early-disarmed","source":"session","sessionId":"session-53ece2c2-6726-4550-8d89-e7ac24e4ebc6","sessionShortId":"53ece2c2"}
```

- `sessionId` 为全 id、非 null；`sessionShortId` = 全 id 去掉 `session-` 后前 8 位 `53ece2c2`（复用 `policy.shortSessionId`）。
- 第一条 `early-disarmed` 夹在 `command/run` cmd-3（seq 42083，02:35:56.304Z）与 cmd-4（42085）之间；`early-armed` 在 cmd-8（42093，02:35:56.307Z）之后；第三条是复原 disarm。

## 5. 命令输出原文（探针 steps）

### 5.1 初始状态（step 1/2）

```
/cg compact status →
armed: off (source=config/default)

/cg profile status →
profile: (none) (source=default)
```

### 5.2 disarm 后 `/cg status`（step 4，原文）

```
context-governance status
time: 2026-10-26T02:35:56.305Z
policy: compact.at=0.60 (source=builtin) native=0.6785 (config-fallback) early=off (session)
profile: (none) (source=default)
window: current=unknown source=config-fallback conservative=unknown native-current=0.6785(config-fallback) native-conservative=- unvalidated (at 允许但未经保守窗口校验)
policy-session: compact.early.armed=off
last-early: none
compression: mode=event-level adapter=none backend-kind=none perception=event event-api=on events=0(no session/event observed yet) summary=unknown/unknown host=0.2.1-rc.3 backend=unknown
capabilities: control=unknown hooks=best-effort/event protectionRole=validator
pressure: measured=- estimated=0.000 adjusted=0.000(×1.35) effective=0.000 ratio=- window=1M (session 53ece2c2) at=0.60 effective<at
degraded: none
conflicts: no-compaction-service(warning), self-check-failed(error), backend-version-unverified(warning)
write-latency: n=0 p50=- p95=- max=-
last-compaction: none
last-cost: none
protection: writes=0 writeFailures=0 reinjections=0 injectionFailures=0 pendingJournals=0 reinjection=enabled(streak=0,maxFailures=3)
scope: project=D:\DS-PROJECT\DSH插件开发 only-project=on capture-title=on ignored-foreign=7/1 unattributed=0
memory: project=DSH插件开发 root=D:\DS-PROJECT\DSH插件开发\memory\governance active=14 proposed=25 total=51 pendingJournals=0
audit: file=D:\DS-PROJECT\DSH插件开发\memory\governance\audit.jsonl max=8388608 size=78040 rotations=0 recentFailures=none (this-process)
```

### 5.3 profile review 后 `/cg status`（step 6，原文；#7 证据）

```
context-governance status
time: 2026-10-26T02:35:56.306Z
policy: compact.at=0.55 (source=profile=review) native=0.6785 (config-fallback) early=off (session)
profile: review (source=session)
window: current=unknown source=config-fallback conservative=unknown native-current=0.6785(config-fallback) native-conservative=- unvalidated (at 允许但未经保守窗口校验)
policy-session: compact.early.armed=off
last-early: none
compression: mode=event-level adapter=none backend-kind=none perception=event event-api=on events=0(no session/event observed yet) summary=unknown/unknown host=0.2.1-rc.3 backend=unknown
capabilities: control=unknown hooks=best-effort/event protectionRole=validator
pressure: measured=- estimated=0.000 adjusted=0.000(×1.35) effective=0.000 ratio=- window=1M (session 53ece2c2) at=0.55 effective<at
degraded: none
conflicts: no-compaction-service(warning), self-check-failed(error), backend-version-unverified(warning)
write-latency: n=0 p50=- p95=- max=-
last-compaction: none
last-cost: none
protection: writes=0 writeFailures=0 reinjections=0 injectionFailures=0 pendingJournals=0 reinjection=enabled(streak=0,maxFailures=3)
scope: project=D:\DS-PROJECT\DSH插件开发 only-project=on capture-title=on ignored-foreign=11/1 unattributed=0
memory: project=DSH插件开发 root=D:\DS-PROJECT\DSH插件开发\memory\governance active=14 proposed=25 total=51 pendingJournals=0
audit: file=D:\DS-PROJECT\DSH插件开发\memory\governance\audit.jsonl max=8388608 size=78147 rotations=0 recentFailures=none (this-process)
```

### 5.4 disarm / profile review / reset / arm（步骤输出）

```
/cg compact disarm →
armed: off (source=session)

/cg profile review →
profile: review (source=session)

/cg profile reset →
profile: (none) (source=default)

/cg compact arm →
armed: on (source=session)

/cg compact disarm（复原）→
armed: off (source=session)

/cg profile reset（复原）→
profile: (none) (source=default)
```

> 说明：探针序列里没有 "arm 后 `/cg status`" 这一步（审核定的序列是 disarm→status→…→arm）；arm 的证据是 step 8 的 `armed: on (source=session)` 与 `early-armed` 审计行。disarm 后 `/cg status` 见 5.2。

## 6. 复原与清理

- 初始 `armed=false`、profile 默认 → 复原为 `disarm`（step 9）+ `profile reset`（step 10），未盲 arm；当前会话 armed 回到初始 false，临时的 session 覆盖**重启即清**。
- marker `.tmp\cg-1a-probe.flag` 已删除；探针 commit（`b23b74d`、`5992cdd`）已回退到 `d05c1eb`，`src/` 零残留（回退后全量 348/348）。
- `/cg status` 含本机路径（`scope: project=...` / `memory: root=...`），按审核口径不算正文，未脱敏。

## 7. 判定

- 渠道：宿主 `commands.execute`（与 slash 同 `@Remote execute`、同 `:380` 构造器）。
- `command/run` 原始事件 10 条（≥3 条要求），带 commandId/seq/time。
- 审计 `early-disarmed`/`early-armed` 各一条（+复原一条），全 id 非 null、短 id 正确。
- `/cg status` 原文提供（disarm 后 + profile review 后）。
- 探针每步 `kind=success`；`commandEvents` 非空。
