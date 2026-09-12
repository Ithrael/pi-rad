# pi-red

[English](README.md) | [中文](README_ZH.md)

**给 [pi](https://pi.dev) 的上帝模式。**

pi-red 是一个 [pi 包](https://pi.dev/docs/latest/packages)：一组扩展、子代理、
提示词模板、技能和主题，补齐 pi 有意省略的进阶能力，并移除阻碍这类工作的摩擦。

与 fork 不同，pi-red 不改 pi 源码，全部通过扩展 API 接入。因此 `pi update`
不会影响它，任何带扩展 API 的 pi 版本都能用（已在 0.85.1 验证）。

```
┌─ pi-red ─────────────────────────────────────────────────┐
│  子代理   计划模式   精简工具   安全研究语境             │
│  自动信任   状态栏    /red 面板   请求头清理             │
└──────────────────────────────────────────────────────────┘
```

## 前置条件

| 工具 | 用途 | 安装 |
|------|------|------|
| **pi** | pi-red 是 pi 包 | `curl -fsSL https://pi.dev/install.sh \| sh` 或 `npm i -g @earendil-works/pi-coding-agent` |
| **Node.js >= 22** | 安装器的 settings 合并与单元测试 | [nodejs.org](https://nodejs.org) |

## 安装

从源码目录安装：

```bash
git clone https://github.com/ithrael/pi-red
cd pi-red
bash install.sh
```

安装会：把包复制到 `~/.pi-red`，在 `~/.pi/agent/settings.json` 注册，
写入 `~/.pi-red/patches.json`，并在 `~/.local/bin` 安装 `pi-red` 启动器。

选项：

```bash
bash install.sh --dev            # 就地注册当前 checkout
bash install.sh --dir DIR        # 自定义安装目录
bash install.sh --bin DIR        # 自定义启动器目录
bash install.sh --no-settings    # 不修改 settings.json
bash install.sh --uninstall      # 取消注册并删除启动器
bash install.sh --uninstall --purge   # 同时删除安装目录
```

也可以直接用 pi 的包管理器：

```bash
pi install /path/to/pi-red
```

## 命令

```bash
pi-red                 # 带 pi-red 启动 pi
/red                   # 交互式功能开关面板
/red <feature> on|off  # 切换单个功能（写入 patches.json）
/red-doctor            # 诊断：版本、路径、活跃工具、patches
/plan                  # 切换只读计划模式（ctrl+alt+p）
/goal <text>           # 目标模式：不完成不停止
/agents                # 列出 subagent 可用的代理
/armor                 # 破甲状态：标记数、override、上次剔除数
```

## 功能

### 能力解锁

| 功能 | 说明 |
|------|------|
| **子代理 Subagents** | `subagent` 工具，把任务委派给隔离的 `pi` 进程：单个、并行（最多 4 个）、或链式（`{previous}` 引用上一步输出）。每个子代理有独立上下文窗口、工具、模型和系统提示词。传 `tmux: true` 可让每个子代理跑在独立的 tmux 窗口里，随时切过去看。 |
| **计划模式 Plan mode** | 只读规划姿态：限制工具集、注入规划指令、硬拦截 `edit`/`write`。`/plan` 或 `ctrl+alt+p` 切换，状态跨 resume 保留。 |
| **目标模式 Goal mode** | `/goal <text>` 把一个需求变成完成契约。每次 agent 停下来时，pi-red 会重新催促它继续，直到它带着证据调用 `goal_complete`（或带阻碍调用 `goal_blocked`）。受迭代预算约束。 |
| **内置代理** | `scout`、`planner`、`worker`、`reviewer`、`sec-auditor`。 |
| **提示词模板** | `/red-review`、`/red-harden`、`/red-deep`。 |
| **技能** | `red-security-review`，按需加载的安全审计工作流。 |
| **主题** | `pi-red` 红色主题，会话启动即生效，一眼就能看出 pi-red 已加载。仅作用于当前会话（不会改写 `settings.json` 里的 `theme`），显式传入 `--use-theme` / `--theme` / `--no-themes` 时以命令行参数为准。 |
| **状态栏** | 页脚显示 pi-red 是否生效。 |

### 限制移除

| 功能 | 移除的内容 |
|------|-----------|
| **破甲 Armor** | ClawGod 限制移除补丁的 pi 移植版。在出站 provider payload 里剔除客户端注入的谨慎指令（`CYBER_RISK_INSTRUCTION`、"NEVER generate or guess URLs" 限制、"Executing actions with care" 段落、登录提示），并在安全类请求上替换为明确的授权安全指令。可用 `~/.pi-red/armor.json` 自定义，用 `~/.pi-red/armor.md` 写自己的指令。 |
| **安全研究语境** | 轻量层（armor 关闭时启用）：提示词可判定为安全工作时注入安全研究语境，让模型直接干活而不是泛泛拒绝。基于关键词场景识别 + 否定词过滤。 |
| **自动信任** | 跳过项目信任提示并记住决定，项目级资源不再被打断。 |
| **请求头清理** | 移除出站请求中的 provider 归属/追踪头（`x-openrouter-title`、`x-anthropic-billing-header`）。 |

### Token 与可靠性

| 功能 | 说明 |
|------|------|
| **Lean** | 当 `bash` 能覆盖时，去掉冗余的 `grep`、`find`、`ls`。 |
| **Lean max** | 工具集只留 `read`、`bash`、`edit`、`write` 加扩展工具。 |
| **Guard** | 可选。执行危险 bash 前确认（`rm -rf`、`sudo`、`mkfs`、`dd of=/dev/...`、`git push --force` 等）。默认关闭。 |

`lean` / `lean-max` 在会话启动时应用，用 `/red` 切换时立即生效；其他功能在下一轮或
下一个会话生效。

### 主题作为生效标识

默认开启 `theme` 功能后，pi-red 会在会话启动时把交互主题切换到 `pi-red`，一眼即可
确认 pi-red 已加载。实现上应用的是主题实例而非主题名，因此**不会改写**你 settings 里
保存的 `theme`。显式的命令行主题参数优先级更高：

```bash
pi-red --use-theme light        # 本次运行保留自己的主题
PI_RED_FEATURE_THEME=false pi   # 完全关闭该标识
/red theme off                  # 持久化关闭
```

### 目标模式

`/goal <text>` 设定目标并立即开始工作。目标激活期间，pi-red 会把「完成契约」注入
系统提示词；每次 agent 停下来但目标未完成时，会自动补一条“继续推进下一步”的消息。
直到以下任一情况才停：

- agent 用 **`goal_complete`** 提交总结与具体证据
- agent 用 **`goal_blocked`** 提交确切阻碍，交还控制权
- 迭代预算耗尽（`PI_RED_GOAL_MAX`，默认 20）→ 暂停
- 你 **主动中断**（Ctrl+C），会抑制下一次自动续跑
- 你执行 `/goal done` 或 `/goal clear`

命令：`/goal <text>`、`/goal`（查看状态）、`/goal resume`、`/goal done`、`/goal clear`。
目标存在会话里，resume 后仍保留。

```bash
/goal 让 `npm test` 全部通过，并把输出作为证据
/goal resume        # 解决阻碍后继续
/goal clear         # 不再追求该目标
PI_RED_GOAL_MAX=50 pi-red    # 调大续跑预算
```

目标自动续跑只在交互模式和 RPC 模式生效；一次性模式（`print` / `json`）只能设目标，
无法开新一轮。

### 破甲（Armor）

ClawGod 的做法是用正则改 Claude Code 本地 bundle，把客户端注入的谨慎指令抹掉：把
`CYBER_RISK_INSTRUCTION` 字符串置空、删掉 `NEVER generate or guess URLs` 那句、让
`Executing actions with care` 段落返回空。pi 自身不注入这些字符串，所以 `armor` 把
同一套技术用在 pi 能控制的最后一环——**出站 provider payload**：

1. **剔除**：每次 provider 请求前，从序列化后的系统指令中删除已知谨慎指令段落/章节。
   覆盖自定义 `--system-prompt` / `SYSTEM.md`、provider 或网关注入的提示词，以及任何
   复用 Claude Code 提示词的框架。
2. **替换**：安全类请求追加正向的授权安全指令（比 ClawGod 置空更有用）。
3. **覆盖**：存在 `~/.pi-red/armor.md` 时，每轮原样追加为最高优先级的自定义指令。

```bash
/armor                              # 状态：标记数、override、上次剔除数
/armor reload                       # 重载 armor.json / armor.md
/red armor off                      # 关闭剔除层
```

用 `~/.pi-red/armor.json`（参考 `armor.example.json`）和 `~/.pi-red/armor.md`
（参考 `armor.example.md`）自定义：

```json
{
  "paragraphMarkers": ["CUSTOM_CAUTION_STRING"],
  "sectionHeadings": ["# Some caution section"],
  "regexes": ["refuse to (?:help|assist)[^\\n]*cyber[^\\n]*"]
}
```

**能力边界**：armor 改的是**客户端系统提示词文本**，这正是 ClawGod 补丁的作用范围。
模型厂商服务端的策略与安全分类器不在 pi 能触及的范围内，既不能绕过也不声称绕过。
指令里也明确写了这一点，并保留授权边界、要求攻防配对。

## 配置

首次安装会生成 `~/.pi-red/patches.json`。未列出的功能按默认值，每个功能都可以用
环境变量临时覆盖：

```json
{
  "sec-research": true,
  "armor": true,
  "auto-trust": true,
  "attribution-off": true,
  "subagents": true,
  "plan-mode": true,
  "goal": true,
  "statusline": true,
  "theme": true,
  "lean": false,
  "lean-max": false,
  "guard": false
}
```

```bash
PI_RED_FEATURE_LEAN=true pi-red          # 仅本次运行
PI_RED_FEATURE_SUBAGENTS=false pi-red    # 仅本次关闭
PI_RED_HOME=/custom/pi-red pi-red        # 自定义配置目录
```

优先级（从高到低）：环境变量 → `patches.json` → 内置默认值。

### 子代理文件

代理是带 YAML frontmatter 的 markdown 文件：

```markdown
---
name: scout
description: 快速代码侦察
tools: read, bash, grep, find, ls
---

你是一个 scout……
```

发现顺序（同名后者覆盖前者）：

1. 包内置 `agents/` 目录
2. `~/.pi/agent/agents/*.md`
3. `<cwd>/.pi/agents/*.md`（最近的祖先目录）

### 在 tmux 里看子代理

默认情况下子代理就是一个不透明的 `subagent` 工具调用：只看得到最终结果，看不到过程。传
`tmux: true`（或在 tmux 里运行 pi，默认 `auto` 就会启用），每个子代理会开一个独立的
tmux 窗口，里面是**实时可读的转录**。用你习惯的 tmux 快捷键（`Ctrl-b n`、`Ctrl-b 1`…）
切过去看，pi 本体仍在自己的窗口继续跑。

窗口里能看到：流式助手文本、`⚙ 工具 参数`、`✔`/`✖` 结果，以及一行 “agent 名 + 退出码”。
跑完窗口不会关（提示 “Press Enter to close”），方便回头读。

结果怎么还能拿回来：窗口把子代理的 NDJSON 流同时交给 `scripts/subagent-view.mjs`，它一边
打印可读视图，一边把原始流追加到日志文件；父进程 pi-red 读该日志得到结构化结果。所以
“可看”和“可编程消费”同时满足。

配置：`~/.pi-red/subagents.json`（参考 `subagents.example.json`）。

```json
{
  "tmux": "auto",
  "focus": false,
  "session": "pi-red"
}
```

| 键 | 取值 | 含义 |
|-----|------|------|
| `tmux` | `auto`（默认）\| `always` \| `off` | `auto` 只在 pi 已处于 tmux 会话时用；`always` 会自动建会话 |
| `focus` | 布尔 | `true` 会切换客户端到新窗口；默认 `false` 保持 pi 在前台 |
| `session` | 字符串 | 不在 tmux 内时使用的会话名（用 `tmux attach -t <name>` 接入） |

优先级：工具参数 `tmux` > 环境变量 > 配置文件。

```bash
PI_RED_SUBAGENT_TMUX=always pi-red   # 总是用 tmux
PI_RED_SUBAGENT_TMUX=off pi-red      # 从不用 tmux
```

`/agents` 会显示当前生效的传输方式。tmux 不可用或建窗失败时，自动回退到 pipe 模式。

## 工作原理

pi-red 是一个使用约定目录的 pi 包：

```
pi-red/
├── extensions/          # pi 自动发现
│   ├── red-core.ts      # 功能开关、/red、安全语境、lean、guard
│   ├── red-armor.ts     # 客户端指令剔除 + /armor
│   ├── red-subagent.ts  # subagent 工具 + /agents
│   ├── red-plan.ts      # 计划模式 + /plan
│   ├── red-goal.ts      # 目标模式 + /goal + goal_complete/goal_blocked
│   └── lib/             # 无依赖的共享逻辑
├── scripts/
│   ├── patch-settings.mjs
│   ├── smoke.mjs            # 端到端冒烟测试
│   └── subagent-view.mjs    # tmux 窗格实时格式化 + 原始 NDJSON 转存
├── agents/              # 内置子代理人格
├── prompts/             # /red-* 提示词模板
├── skills/              # red-security-review
└── themes/pi-red.json   # 主题
```

- **不打补丁。** 全部走 pi 扩展 API（`pi.on`、`pi.registerTool`、
  `pi.registerCommand`）。升级 pi 不影响 pi-red。
- **自愈启动器。** 如果 `~/.pi/agent/settings.json` 里的注册丢失，
  `pi-red` 会自动重新注册。
- **开关即数据。** `/red` 写入 `patches.json`，每个钩子在调用时检查自己的
  功能 id，多数功能无需重启。

## 更新

```bash
cd pi-red && git pull && bash install.sh
```

pi-red 以本地包形式注册，`pi update` 不会动它。拉取后重跑安装器即可同步到
`~/.pi-red`；`patches.json` 会在重装时保留。

## 卸载

```bash
bash install.sh --uninstall          # 在源码目录
# 或者已安装的副本：
bash ~/.pi-red/install.sh --uninstall
```

会从 pi settings 中移除包并删除启动器。`~/.pi-red` 与 settings 偏好会保留；
加 `--purge` 删除安装目录（如想还原 `defaultProjectTrust`、
`enableInstallTelemetry`、`theme`，请手动修改）。

## 开发

```bash
npm test        # 功能开关与场景识别的单元测试
```

扩展通过 jiti 直接加载 TypeScript，无需构建。不安装也可试用：

```bash
pi -e ./extensions/red-core.ts -e ./extensions/red-subagent.ts -e ./extensions/red-plan.ts
```

## 许可证

MIT。与 pi 项目无隶属关系，使用风险自负。
