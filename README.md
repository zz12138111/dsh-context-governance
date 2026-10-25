# DSH 插件开发

本工作区开发自建 DeepSeek Harness 插件，产物发布到 GitHub 并同时在本机安装使用。

## 结构

```
D:\DS-PROJECT\DSH插件开发\
├─ AGENTS.md        工作区约定（红线/分工/工作流）
├─ REQUIREMENTS.md  需求单（需求会话维护）
├─ DECISIONS.md     决策记录（开发会话单写）
├─ STATUS.md        当前状态（在办/等待/阻塞/下一步）
├─ TASKS\           任务单
├─ docs\            设计说明、插件开发笔记
├─ memory\
│  └─ ARTIFACTS.md  精确事实（路径/版本/hash/发布记录）
├─ packages\        插件源码（一个插件一个目录，待建）
└─ dist\            打包产物 zip（待建）
```

## 三条分工

- **需求**：出需求单、拆任务、排优先级；只读账本。
- **开发**：实现 + 自测 + 打包前准备；`DECISIONS.md` 单写者。
- **审核打包**：独立复核（规范/兼容/安全/回滚）+ 打包 + 发布口径；只读账本。

## 与 00 的关系

- 00 管：环境、边界、资源、决策路由、进度跟踪；不做细节验收。
- 用户管：验收、发布批准、安装批准。
- 子会话交付：摘要 + 路径 + 关键数字 + 验证项；验收时 00 整理成一份转用户。

## 许可与第三方

- **本项目**：MIT，`Copyright (c) 2026 zz12138111` —— 见根 `LICENSE` 与 `packages/dsh-context-governance/LICENSE`。
- **宿主/依赖**：DeepSeek Harness 的 `@deepseek-ai/*` 包（含 `cordis`）为 **MIT**，`Copyright (c) 2026 DeepSeek`；本项目在**运行时依赖**它们，仓库内**不含其源码副本**。
- **文档引用**：`docs/`、`analysis/` 里出现的宿主源码行号、事件名与短句引用仅用于兼容性说明，版权归 DeepSeek，按其 MIT 许可使用，不是本项目代码。
- **未发布外壳**：根 `@deepseek-ai/dsh-desktop-runtime` 是 `private: true` 的 Electron 外壳（未发布到 npm），**不作为“闭源/专有”论据**。
- **第三方插件**：`dsh-context-zip`、`dsh-cost-meter`、`dsh-cross-session-approval` 等为用户环境依赖，不在本仓库分发。
- **发布物**：打 zip / Release 时必须包含 `LICENSE`；若将来包含宿主代码片段，需随附 `MIT License, Copyright (c) 2026 DeepSeek`。
- **数据提示**：`analysis/` 含本机绝对路径与真实会话 id，公开仓库前需脱敏或排除该目录（见 `scripts/compliance-scan.mjs`）。
