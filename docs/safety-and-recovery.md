<p align="center">
  <strong>简体中文</strong>
  ·
  <a href="safety-and-recovery.en.md">English</a>
</p>

# CodexKeep 安全与恢复指南

CodexKeep 只同步明确允许的个人 Codex 配置。它不会把整个 `~/.codex` 复制到
Git，也不会通过自动确认绕过冲突或安全检查。

第一次使用请先阅读[项目 README](../README.md)；每条命令的具体行为见
[命令手册](commands.md)。

## 安全边界

| 会同步 | 始终留在本机 |
| --- | --- |
| `~/.agents/skills` 中的个人 skills | 身份认证、token、connector 凭据和 MCP headers |
| `.skill-lock.json` 中的 skill 来源记录 | 会话、历史、日志、SQLite 数据库、缓存和桌面状态 |
| 全局 `~/.codex/AGENTS.md` | 项目信任与机器专属绝对路径 |
| `~/.codex/agents` 中的自定义 agents | Codex 内置 skills、plugin bundles 和缓存快照 |
| 白名单允许的可移植偏好 | 项目级 instructions、skills 和配置 |
| 验证过的第三方 marketplace 与 plugin 清单 | 账号 plugin 的凭据和登录状态 |

即使仓库不含凭据，它仍保存个人 instructions、skills、agents 和偏好。跨设备
同步应使用私有仓库。

## 可移植偏好白名单

CodexKeep 当前允许同步这些顶层标量：

- `model`
- `model_reasoning_effort`
- `approval_policy`
- `approvals_reviewer`
- `sandbox_mode`

它还可以同步：

- `features` 下不含疑似机密键的布尔值；
- 清理后的 `skills.config` 项；
- 使用安全相对 `config_file` 路径的自定义 agents。

以下内容会被排除：

- 键名包含 token、secret、password、credential、authorization、API key、
  header 或 env 的字段；
- 绝对路径和以 `~` 开头的路径；
- 指向父目录的自定义 agent 路径；
- 不在白名单中的机器专属配置段。

## 数据目录与符号链接

可移植内容保存在用户自己的 Git 仓库：

```text
~/.codexkeep/
├── skills/
├── skill-lock.json
├── plugins.json
└── codex/
    ├── AGENTS.md
    ├── codexkeep.config.toml
    └── agents/
```

五个受支持的官方路径指向这些内容：

```text
~/.agents/skills                    → ~/.codexkeep/skills
~/.agents/.skill-lock.json          → ~/.codexkeep/skill-lock.json
~/.codex/AGENTS.md                  → ~/.codexkeep/codex/AGENTS.md
~/.codex/agents                     → ~/.codexkeep/codex/agents
~/.codex/codexkeep.config.toml      → ~/.codexkeep/codex/codexkeep.config.toml
```

CodexKeep 不会接管 `~/.codex/skills`；Codex 内置 skills 继续保留在原位置。

当前 Codex 版本只有在传入 `--profile codexkeep` 时才加载具名 profile，不能
持久设置默认 profile。为了让同步后的偏好在 Codex app、CLI 和 IDE 中直接
生效，CodexKeep 会把可移植白名单合并到真实的 `~/.codex/config.toml`。不属于
CodexKeep 的配置段会保留；每次文件实际变化前，原内容都会备份。

## 受管理内容写入前会发生什么

### 初始化

`codexkeep init` 先在临时目录创建或克隆配置仓库，发现本机配置，验证完整结构，
再展示一份计划。远端无效、无法访问或内容不符合 CodexKeep 格式时，不修改官方
路径。

### 同步

`codexkeep sync` 先验证仓库、五个链接、Git 状态、plugin 清单和可移植偏好。
如果配置了远端，它会 fetch 并通过共同 Git 基线识别双方的新增与删除，再以绿色
`+` 和红色 `-` 生成计划。plugin 安装或卸载、配置写入、提交和 push 都在接受
计划后执行；无法判断本机缺失是待恢复还是主动删除时必须明确选边。

### 恢复链接

`codexkeep link` 会先检查全部链接。只要任意目标已经包含不同内容，就不会创建
任何链接，而是提示使用 `init` 做安全合并。创建过程中失败时，本次新增链接会
回滚。

## 备份与状态

机器专属备份和技术错误记录保存在：

```text
~/.local/state/codexkeep/
```

其中包括：

- 修改真实 `~/.codex/config.toml` 前生成的时间戳备份；
- plugin 操作中断时用于继续同步的 `pending-plugins.json`；
- 初始化接管已有官方路径时保留的原内容；
- 初始化后续步骤失败时留下的可找回仓库数据；
- 最近一次未处理异常的技术详情。

这个状态目录不会进入 Git。

## 失败与恢复

### `init` 时远端无法访问

现有官方路径保持不变。确认仓库地址、访问权限和网络后重新运行 `init`。

### 已有内容的远端不是有效 CodexKeep 仓库

本机配置保持不变。使用正确的私有仓库；不要把任意已有仓库强行连接为配置
仓库。

### `sync` 遇到 Git 冲突

双方内容都会保留，CodexKeep 不会 force push 或自动覆盖。解决当前 Git 状态，
然后运行：

```bash
codexkeep check
codexkeep sync
```

### push 失败

本地提交和选中的 `origin` 会保留。远端恢复后重新运行 `codexkeep sync`。

### 应用链接失败

本次创建的链接会回滚。运行 `codexkeep check`，处理报告的路径后再运行
`codexkeep link`。

### plugin 操作失败

文件和 Git 同步仍可能完成。账号绑定的 plugin 需要在当前设备手工安装或登录；
普通 plugin 可以修复 Codex 或 marketplace 状态后重新同步。

### 操作被中断

已经完成的本机内容会保留，尚未开始的步骤不会执行。先运行
`codexkeep check`，再根据状态重试原命令。

## 排查顺序

1. 运行 `codexkeep check` 查看本机链接、配置、plugin 清单和 Git 状态。
2. 处理输出中的第一条可操作警告。
3. 如果需要技术详情，查看
   `~/.local/state/codexkeep/last-error.log`。
4. 状态恢复后重新运行原命令。

`check` 不访问 Git 远端。验证远端地址可以运行不带参数的
`codexkeep remote` 查看当前 `origin`，再用 `codexkeep sync` 实际连接。

## 常见问题

### Git 仓库必须是私有的吗？

纯本地使用不需要远端。跨设备同步应使用私有仓库，因为仓库仍包含个人
instructions、skills、agents 和偏好设置。

### 新设备应该使用 `init` 还是 `link`？

新设备使用 `codexkeep init <git-url>`。只有本机已经存在 `~/.codexkeep`、
需要恢复官方路径符号链接时，才使用 `codexkeep link`。

### npm 安装能代替本地符号链接吗？

不能。`npm install -g codexkeep` 安装 CLI；符号链接负责把 Codex 与 agents
的官方路径连接到 `~/.codexkeep` 中的配置。

### 两台设备修改了同一个偏好会怎样？

CodexKeep 比较共同版本、本机版本和远端版本。真正的双边修改必须明确选择本机
或远端；`--yes` 会取消，而不是猜测。

### CodexKeep 会复制已经安装的 plugins 吗？

它同步经过验证的第三方 marketplace 和 plugin ID 清单，并可以请求 Codex
安装缺少的普通 plugins。Bundles、缓存、凭据和账号登录状态始终留在本机。

## 进一步阅读

- [完整命令手册](commands.md)
- [项目 README](../README.md)
- [实现说明](IMPLEMENTATION.md)
