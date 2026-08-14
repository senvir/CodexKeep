<p align="center">
  <strong>简体中文</strong>
  ·
  <a href="commands.en.md">English</a>
</p>

# CodexKeep 命令手册

本文说明每条公共命令何时使用、是否联网、会修改什么，以及失败后会保留什么。
第一次使用请先阅读[项目 README](../README.md)。

## 全局选项

| 选项 | 作用 |
| --- | --- |
| `--yes` | 接受常规确认；不会绕过验证，也不会替用户解决内容冲突 |
| `--help`、`-h` | 显示帮助 |
| `--version` | 显示版本 |

`--yes` 可以放在命令参数中，例如 `codexkeep sync --yes`。下面各节会说明它对
具体命令的影响。

## `codexkeep`

```bash
codexkeep
```

- **适用场景：** 希望从方向键菜单选择操作。
- **网络访问：** 打开菜单本身不联网；后续行为由选中的命令决定。
- **可能改动：** 选择操作并接受对应计划前没有改动。
- **确认与恢复：** 与最终选中的命令相同。

当前菜单使用中文，包含同步、升级、检查、远端、连接设备和初始化入口。在非
交互环境中直接运行 `codexkeep` 会显示帮助。

## `codexkeep init [git-url]`

```bash
codexkeep init
codexkeep init git@github.com:your-name/codexkeep-config.git
```

- **适用场景：** 设置第一台 Mac、在新 Mac 加入已有 CodexKeep 仓库，或安全
  合并受支持的本机配置。
- **网络访问：** 提供 Git URL 时会先探测远端。空仓库成为首次发布目标；已有
  内容的仓库必须是有效 CodexKeep 仓库。
- **可能改动：** CodexKeep 先在临时目录构建结果。确认后才安装
  `~/.codexkeep`、导入或合并受支持配置、应用可移植偏好、创建五个官方路径
  符号链接、提交，并在存在远端时同步。
- **确认：** 交互模式展示一份完整计划并确认一次。`--yes` 接受常规确认；未
  提供 URL 时，非交互初始化保持纯本地模式。
- **冲突：** 已有内容但无效的仓库会被拒绝。同名 skills、agents、全局
  instructions、来源记录、插件清单或可移植偏好发生差异时，必须明确选择仓库
  版本或本机版本。`--yes` 不会自动选边。
- **失败与恢复：** 远端无法访问或无效时，不修改官方路径。如果确认后的安装
  失败，原始基础配置会恢复，可找回的新仓库数据保存在 CodexKeep 状态目录。

在另一台 Mac 加入已有仓库时也使用 `init <git-url>`，不要使用 `link`。

## `codexkeep sync`

```bash
codexkeep sync
codexkeep sync --yes
```

- **适用场景：** 保存本机改动、接收其他设备的改动，或把共享配置应用到当前
  Mac。
- **网络访问：** 读取本机 Codex 插件清单；配置了 `origin` 时执行 fetch。
  fetch 用于生成准确计划，plugin 安装和 push 只在接受计划后进行。
- **可能改动：** 可能安装或卸载第三方 marketplaces 和 plugins、更新
  `plugins.json`、协调可移植 `config.toml` 白名单、备份并修改真实 Codex
  配置、提交本地文件、rebase 远端更新并 push。
- **确认：** 执行写入前以 `+` 和 `-` 展示完整同步计划；交互终端分别使用绿色
  和红色。`--yes` 接受常规计划，但不会替用户判断本机缺少的插件是需要恢复
  还是已经主动删除。
- **冲突：** 不兼容的 marketplace 来源会在受管理内容改动前停止。同一可移植
  设置被本机和远端同时修改时必须明确选边。共享清单仍有而本机缺少的插件也会
  要求选择“恢复共享插件”或“采用本机删除”。未解决的 Git 冲突会停止同步，
  不会强制覆盖任意一方。
- **失败与恢复：** 远端离线不妨碍保存本地提交；push 失败时保留本机改动，
  稍后重新运行 `codexkeep sync` 即可。plugin 操作失败时目标清单保留在本机，
  修复后可继续重试。账号绑定的 plugins 只会提示手工安装或登录，不会复制凭据。

没有配置远端时，`sync` 仍会保存受支持的本机改动，但会报告当前只在本机使用。

## `codexkeep update`

```bash
codexkeep update
codexkeep update --yes
```

- **适用场景：** 希望在同步前升级带来源记录的全局 skills 和 Git-backed
  plugin marketplaces。
- **网络访问：** 通过 `npx` 运行全局 skills 更新器，请 Codex 升级
  marketplaces，然后执行与 `sync` 相同的远端访问。
- **可能改动：** 第三方来源可能在普通同步计划出现前完成升级；随后执行完整
  `sync` 流程。
- **确认：** 升级阶段没有单独确认。普通同步仍会展示计划，除非提供 `--yes`。
- **失败与恢复：** skills 或 marketplace 升级失败时保留现有内容，并继续
  尝试其余升级与同步步骤。任何部分失败都会返回非零状态。运行
  `codexkeep check` 检查问题，修复后重试 `update`；不需要再次升级时可以只
  运行 `sync`。

## `codexkeep check`

```bash
codexkeep check
```

- **适用场景：** 验证新设备、诊断失败命令，或检查本机是否存在待同步改动。
- **网络访问：** 从不访问 Git 远端。它可能调用已安装的 Codex CLI 读取本机
  plugin 与 marketplace 清单。
- **可能改动：** 无。这是一条只读诊断命令。
- **检查内容：** 官方路径链接、`~/.codex/skills` 下意外出现的非内置 skills、
  插件清单、可移植偏好、Git 仓库与工作区状态、已配置的 `origin`，以及最近
  一次技术错误记录。
- **失败与恢复：** 按输出中的可操作警告处理。技术详情保存在
  `~/.local/state/codexkeep`，避免直接打印可能包含敏感信息的子进程输出。

`check` 不会 fetch，因此“状态正常”只描述当前本机状态，不代表远端此刻可达。

## `codexkeep remote [git-url]`

```bash
codexkeep remote
codexkeep remote git@github.com:your-name/codexkeep-config.git
```

- **适用场景：** 查看当前 `origin`，为已初始化的本地仓库连接第一个远端，或
  更换为空仓库的远端。
- **网络访问：** 不带参数时只读取本地 Git 配置。提供 URL 时会在修改
  `origin` 前探测远端。
- **可能改动：** 确认后添加或替换 `origin`，随后直接进入现有同步流程，不再
  进行第二次常规确认。
- **确认：** 提供新 URL 时展示远端变更和首次发布计划；`--yes` 可以接受。
- **冲突：** 目标必须是空仓库。已有内容的 CodexKeep 仓库应在新设备上通过
  `init <git-url>` 使用。未完成的 Git 操作或不完整链接会阻止本命令。
- **失败与恢复：** 发布失败时，选中的 `origin` 和本地提交都会保留，之后可以
  通过 `codexkeep sync` 重试。

## `codexkeep link`

```bash
codexkeep link
codexkeep link --yes
```

- **适用场景：** 本机已经存在 `~/.codexkeep`，但一个或多个受支持的官方路径
  符号链接缺失。
- **网络访问：** 从不联网。
- **可能改动：** 验证完整本地仓库，列出缺失链接，确认后再创建。
- **确认：** `--yes` 接受创建不存在冲突的缺失链接。
- **冲突：** 如果官方路径已经包含不同内容，命令不会修改任何内容，并提示
  使用 `codexkeep init` 做安全合并。
- **失败与恢复：** 链接创建失败时，本次已经创建的链接会回滚。重复运行是
  幂等的。

`link` 不会克隆远端，不能替代新设备上的 `init <git-url>`。

## 进一步阅读

- [安全与恢复指南](safety-and-recovery.md)
- [项目 README](../README.md)
- [实现说明](IMPLEMENTATION.md)
