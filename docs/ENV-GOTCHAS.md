# 本机环境坑位清单（审核打包维护）

> 只记"换机器/换 git 发行版要重查"的环境级陷阱；一条一段：症状 → 根因 → 处置 → 复查点。
> 记录人：审核打包（只记账，不改他人账本）。

## G1 · PortableGit + 非默认 HOME ⇒ ssh 找错密钥目录（2026-10-25）

- **症状**：`git push/fetch` 报 `Host key verification failed.`，而同一台机器 `ssh -T git@github.com` 正常（`Hi zz12138111! ...`）。
- **根因**：本机 git 是 PortableGit（`C:\Users\19091\AppData\Local\Programs\PortableGit`），它调用自带 `usr\bin\ssh.exe`；该 ssh 的 `userknownhostsfile`/`identityfile` 跟着 `HOME` 走，而 **HOME 被 Cadence 设成了 `F:\Cadence\SPB_Data`**（`ssh -G github.com` 可见 `userknownhostsfile /f/Cadence/SPB_Data/.ssh/known_hosts`）。那里既没有 github 主机键、也没有 `id_ed25519`；真密钥在 `C:\Users\19091\.ssh`（Windows 自带 OpenSSH 走 `%USERPROFILE%`，所以它正常）。
- **处置（已生效）**：全局一条 `git config --global core.sshCommand "C:/Windows/System32/OpenSSH/ssh.exe"`，写入 `F:/Cadence/SPB_Data/.gitconfig`。**未改** HOME / `GIT_SSH` / 代理配置。
- **复查点**：换机器、换 git 发行版（如装官方 Git for Windows / 升 PortableGit）、或 Cadence 改 HOME 后，重跑
  `ssh -G github.com | findstr userknownhosts` 与 `git config --global core.sshCommand`；
  若推送又开始要求"临时设 `GIT_SSH` 才能通"，视为配置失效，报 00，不加更多环境变量。
- **另**：`%USERPROFILE%\.ssh` 与其他 `.ssh` 目录属敏感路径，安全网会拦读取/列举，不要绕。
