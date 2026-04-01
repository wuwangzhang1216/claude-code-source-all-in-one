# Claude Code Source (Learning Material)

## Disclaimer / 免责声明

> **IMPORTANT: READ BEFORE USE**

### English

**This repository is strictly for educational and research purposes only.**

- **Source**: The source code referenced in this repository was discovered from publicly available sources, including [instructkr/claw-code](https://github.com/instructkr/claw-code). It contains extracted source code of [Claude Code](https://claude.ai/code), a product by [Anthropic](https://anthropic.com).
- **Ownership**: All intellectual property rights of the source code belong exclusively to **Anthropic, PBC**. This repository does not claim any ownership, authorship, or rights over the original code.
- **Purpose**: This repository is provided **solely** as learning material for understanding AI agent system architecture and engineering patterns. It is intended for academic study, technical research, and educational discussion.
- **Prohibited uses**: This repository and its contents **must not** be used for:
  - Commercial purposes of any kind
  - Building competing products or services
  - Redistribution or repackaging of the source code
  - Any purpose that violates Anthropic's [Terms of Service](https://www.anthropic.com/terms) or applicable laws
- **Analysis articles**: The deep analysis articles (`claude-code-deep-analysis/`) are **original commentary and analysis** written by the repository maintainers. They contain code snippets for the purpose of commentary, criticism, and education, which is generally considered fair use. However, these articles should not be considered legal advice.
- **DMCA / Takedown**: If you are a representative of Anthropic or believe this repository infringes on any intellectual property rights, please contact us and we will **promptly remove** the infringing content. You may also file a DMCA takedown notice through [GitHub's DMCA process](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy).
- **No warranty**: This repository is provided "as is" without warranty of any kind. The maintainers are not responsible for any consequences arising from the use of this material.

---

### 中文

**本仓库严格仅供学习和研究用途。**

- **来源**：本仓库引用的源代码来自公开渠道，包括 [instructkr/claw-code](https://github.com/instructkr/claw-code)，其中包含 [Anthropic](https://anthropic.com) 公司的 [Claude Code](https://claude.ai/code) 产品的源代码。
- **知识产权**：源代码的所有知识产权完全归 **Anthropic, PBC** 所有。本仓库不主张对原始代码的任何所有权、著作权或权利。
- **用途**：本仓库**仅**作为学习材料提供，用于理解 AI agent 系统架构和工程设计模式，面向学术研究、技术学习和教育讨论。
- **禁止用途**：本仓库及其内容**不得**用于：
  - 任何形式的商业用途
  - 构建竞品产品或服务
  - 再分发或重新打包源代码
  - 任何违反 Anthropic [服务条款](https://www.anthropic.com/terms) 或适用法律的行为
- **分析文章**：深度分析文章（`claude-code-deep-analysis/`）是仓库维护者撰写的**原创评论和分析**。文章中包含的代码片段用于评论、批评和教育目的。但这些文章不构成法律建议。
- **侵权处理**：如您是 Anthropic 的代表或认为本仓库侵犯了任何知识产权，请联系我们，我们将**立即删除**相关内容。您也可以通过 [GitHub 的 DMCA 流程](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy) 提交侵权通知。
- **免责条款**：本仓库按"现状"提供，不附带任何形式的保证。维护者不对因使用本材料而产生的任何后果承担责任。

**Contact / 联系方式**: 如有任何问题，请通过 GitHub Issues 联系。

## 从源码启动 / Run from Source

本仓库现已支持从源码本地启动 Claude Code（功能有所缩减）。已验证可成功运行，版本号 `2.1.88 (Claude Code)`。

### 环境要求

| 依赖 | 说明 |
|------|------|
| **Node.js** ≥ 18 | 运行 setup 脚本 |
| **Bun** ≥ 1.0 | 运行 Claude Code（setup 脚本会自动安装） |
| **Anthropic API Key** | 需要有效的 `sk-ant-xxx` 密钥 |

### 快速开始

```bash
# 1. 安装依赖并设置 shim
node scripts/setup.mjs

# 2. 设置 API Key
export ANTHROPIC_API_KEY="sk-ant-xxx"

# 3. 启动
bun src/entrypoints/cli.tsx

# 或使用启动脚本 (macOS/Linux)
./start.sh

# Windows 用户
set ANTHROPIC_API_KEY=sk-ant-xxx
bun src/entrypoints/cli.tsx
```

### 创建的 Shim 文件

以下文件是为了让源码可运行而创建的，不属于原始源码：

| 文件 | 作用 |
|------|------|
| `package.json` | 从 import 语句逆向工程出的 100+ 依赖声明 |
| `tsconfig.json` | TypeScript 配置，含 `src/*` 路径映射 |
| `bunfig.toml` | Bun 配置，指定 preload 插件 |
| `preload.ts` | 核心 shim：`bun:bundle` 模拟、`MACRO.*` 全局变量、`src/` 路径解析、`.md` 文件加载 |
| `scripts/setup.mjs` | 一键安装：依赖安装、私有包 stub、缺失文件生成、ripgrep 下载 |
| `start.sh` | macOS/Linux 启动脚本，含首次运行检测和 API Key 校验 |

### 工作原理

| 问题 | 解决方案 |
|------|----------|
| `bun:bundle` 编译时 API | `preload.ts` 提供运行时 shim，`feature()` 全部返回 `false` |
| 89 个 Feature Flag | 全部禁用（所有 feature-gated 代码路径不执行） |
| `MACRO.*` 编译时宏 | `preload.ts` 中定义为全局变量 |
| `from 'src/...'` 导入 | 源码放在 `src/` 目录下，路径天然匹配，无需额外重定向 |
| 无 `package.json` | 已从 import 语句逆向工程出 100+ 依赖 |
| `@ant/*` 内部包 | `scripts/setup.mjs` 创建空实现 stub |

### 不可用的功能（缺失私有包）

以下功能依赖 Anthropic 私有包，在本地运行时**不可用**：

| 功能 | 缺失的包 | 说明 |
|------|----------|------|
| Computer Use（电脑操控） | `@ant/computer-use-mcp` | 截屏、鼠标点击、键盘输入等 |
| 原生键鼠输入 | `@ant/computer-use-input` | Rust/enigo 原生绑定 |
| macOS 截屏/窗口管理 | `@ant/computer-use-swift` | Swift 原生绑定，仅 macOS |
| Chrome 浏览器集成 | `@ant/claude-for-chrome-mcp` | Chrome 扩展 MCP server |
| 沙箱运行时 | `@anthropic-ai/sandbox-runtime` | 命令执行沙箱 |
| MCP Bridge | `@anthropic-ai/mcpb` | MCP 协议桥接 |

### 所有 89 个 Feature Flag（全部禁用）

由于 `feature()` 在运行时返回 `false`，以下功能全部被禁用：

`ABLATION_BASELINE` `AGENT_MEMORY_SNAPSHOT` `AGENT_TRIGGERS` `BRIDGE_MODE` `BUDDY` `BUILDING_CLAUDE_APPS` `CCR_AUTO_CONNECT` `COORDINATOR_MODE` `DAEMON` `DIRECT_CONNECT` `DUMP_SYSTEM_PROMPT` `FORK_SUBAGENT` `HISTORY_PICKER` `KAIROS` `MCP_SKILLS` `MONITOR_TOOL` `NATIVE_CLIPBOARD_IMAGE` `PERFETTO_TRACING` `QUICK_SEARCH` `SSH_REMOTE` `STREAMLINED_OUTPUT` `TEAMMEM` `TEMPLATES` `TERMINAL_PANEL` `TORCH` `ULTRAPLAN` `ULTRATHINK` `VOICE_MODE` `WEB_BROWSER_TOOL` `WORKFLOW_SCRIPTS` 等共 89 个。

### 构建流程推断

```
TypeScript 源码
  │
  ├─ Bun bundler (`bun build`)
  │   ├─ 注入 MACRO.* 常量（--define）
  │   ├─ 解析 feature() 调用 → 设置 89 个 feature flag 的 true/false
  │   ├─ Dead Code Elimination → 移除未启用 feature 的代码分支
  │   └─ 打包为单文件 JS bundle
  │
  ├─ 可选：Bun compile → 编译为单文件可执行二进制
  │
  └─ 发布到 npm (@anthropic-ai/claude-code)
```

### Windows 注意事项

- **ripgrep**：setup 脚本中的 tar 解压在 Windows 上可能失败。如果 Grep/搜索功能不可用，请手动安装 [ripgrep](https://github.com/BurntSushi/ripgrep/releases) 并确保 `rg` 在 PATH 中
- **Bun 路径**：安装 Bun 后需要重启终端，或手动将 `%USERPROFILE%\.bun\bin` 添加到 PATH
- **启动脚本**：`start.sh` 仅适用于 macOS/Linux，Windows 用户请直接使用 `bun src/entrypoints/cli.tsx`

### 故障排查

| 错误 | 解决方案 |
|------|----------|
| `Cannot find module 'src/...'` | 确认源码在 `src/` 目录下，且 `bunfig.toml` 存在 |
| `Missing 'default' export in module '*.md'` | 确认 `preload.ts` 包含 `.md` 文件加载器 |
| `Cannot find package '@ant/...'` | 运行 `node scripts/setup.mjs` 重新创建 stub |
| `bun: command not found` | 安装 Bun: `curl -fsSL https://bun.sh/install \| bash`（或重启终端） |
| `ANTHROPIC_API_KEY is not set` | 设置环境变量: `export ANTHROPIC_API_KEY="sk-ant-xxx"` |
| 使用非 Anthropic 代理 | 设置 `DISABLE_PROMPT_CACHING=1` 和 `DISABLE_INTERLEAVED_THINKING=1` |

### 如果你想运行官方版本

```bash
npm install -g @anthropic-ai/claude-code
```

## 深度分析系列 / Deep Analysis

我们对 Claude Code 的完整架构进行了源码级的深度拆解，产出了 **18 篇分析文章**，覆盖核心 Agent 引擎和六大外围子系统。

**[→ 进入分析系列](claude-code-deep-analysis/README.md)**

### 核心发现

| 设计决策 | 说明 |
|---------|------|
| **循环优于图** | 用 `while(true)` 取代 DAG，获得运行时的最大灵活性 |
| **递归优于编排** | 子 agent 递归调用 `query()`，新功能自动传播到所有层级 |
| **模型做决策，框架做执行** | 框架只管并发安全和权限，决策逻辑完全交给模型 |
| **为真实世界设计** | 四层压缩、三级错误恢复——demo 用不到，但 4 小时会话离不开 |
| **不可变性是成本优化** | 消息不可变 → prompt caching 命中 → 长会话成本降低 80% |

### 文章列表

**Part 1：核心 Agent 引擎**

| # | 主题 | 核心内容 |
|---|------|---------|
| 00 | [核心结论](claude-code-deep-analysis/00-core-conclusion.md) | while(true) vs DAG，与 LangGraph/CrewAI/AutoGen 对比 |
| 01 | [入口流程](claude-code-deep-analysis/01-entry-point.md) | main.tsx → QueryEngine → query() 全链路 |
| 02 | [主循环](claude-code-deep-analysis/02-main-loop.md) | State 类型 10 字段、7 个 continue site |
| 03 | [流式处理](claude-code-deep-analysis/03-streaming.md) | StreamingToolExecutor、三层 AbortController |
| 04 | [工具编排](claude-code-deep-analysis/04-tool-orchestration.md) | partitionToolCalls 贪心分区、延迟上下文修改器 |
| 05 | [权限系统](claude-code-deep-analysis/05-permission-system.md) | 5 种模式、推测性分类器、企业 Policy |
| 06 | [子Agent](claude-code-deep-analysis/06-sub-agent.md) | 递归 query()、worktree 隔离、后台 agent |
| 07 | [上下文窗口](claude-code-deep-analysis/07-context-window.md) | 四层压缩、三级 413 恢复瀑布 |
| 08 | [消息类型](claude-code-deep-analysis/08-message-types.md) | 7 种消息类型、TombstoneMessage |
| 09 | [不可变消息](claude-code-deep-analysis/09-immutable-api-messages.md) | prompt caching、clone-before-modify |
| 10 | [架构图](claude-code-deep-analysis/10-architecture-diagram.md) | 调用图、数据流、并发模型 |
| 11 | [设计哲学](claude-code-deep-analysis/11-design-philosophy.md) | 四个核心决策的深度展开 |

**Part 2：外围子系统**

| # | 主题 | 核心内容 |
|---|------|---------|
| 12 | [MCP 集成](claude-code-deep-analysis/12-mcp-integration.md) | 6 种 Transport、OAuth/XAA 认证、工具发现 |
| 13 | [Memory 系统](claude-code-deep-analysis/13-memory-system.md) | 跨会话记忆、Sonnet 驱动检索、异步预取 |
| 14 | [System Prompt](claude-code-deep-analysis/14-system-prompt.md) | 模块化组装、缓存边界、多源合并 |
| 15 | [Session & Bridge](claude-code-deep-analysis/15-session-resume.md) | WAL 持久化、IDE 集成、崩溃恢复 |
| 16 | [工具实现](claude-code-deep-analysis/16-tool-implementations.md) | 45+ 工具、统一接口、BashTool 安全体系 |
| 17 | [Hook 系统](claude-code-deep-analysis/17-hook-system.md) | 13 种事件、5 种 Hook 类型、阻断机制 |

## Structure / 项目结构

```
根目录/
├── README.md                    ← 文档
├── package.json                 ← 依赖声明（逆向工程）
├── tsconfig.json                ← TypeScript 配置
├── bunfig.toml                  ← Bun preload 配置
├── preload.ts                   ← 运行时 shim
├── start.sh                     ← 启动脚本
├── scripts/setup.mjs            ← 一键安装脚本
├── claude-code-deep-analysis/   ← 深度分析文章（原创）
└── src/                         ← Anthropic 源码
    ├── query.ts                 ← 核心 Agent 循环
    ├── QueryEngine.ts           ← 会话管理
    ├── Tool.ts                  ← 工具接口定义
    ├── entrypoints/             ← 入口文件
    ├── commands/                ← 103+ slash 命令
    ├── components/              ← 146+ UI 组件
    ├── tools/                   ← 45+ 工具实现
    ├── utils/                   ← 564+ 工具函数
    ├── services/                ← 核心服务
    ├── hooks/                   ← 104 React hooks
    ├── memdir/                  ← 跨会话记忆
    ├── bridge/                  ← CLI ↔ VS Code 通信
    ├── constants/               ← System Prompt 组装
    ├── plugins/                 ← 插件架构
    └── voice/                   ← 语音输入
```

## License / 版权声明

- **Source code**: All rights belong to **Anthropic, PBC**. This repository does not claim any ownership of the original code. No license is granted for the source code.
- **Analysis articles** (`claude-code-deep-analysis/`): Original analysis and commentary by the repository maintainers. Code snippets included within articles are for educational commentary purposes only.
- **源代码**：所有权利归 **Anthropic, PBC** 所有。本仓库不主张对原始代码的任何所有权。不授予源代码的任何许可。
- **分析文章**（`claude-code-deep-analysis/`）：仓库维护者的原创分析和评论。文章中包含的代码片段仅用于教育评论目的。
