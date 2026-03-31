# Claude Code 源码深度分析系列

> Claude Code 是 Anthropic 官方的 AI 编程 CLI 工具，也是目前最强大的 AI agent 系统之一。本系列共 18 篇文章，从源码层面对 Claude Code 的完整架构进行深度拆解。

## 这个系列在讲什么

Claude Code 的源码最近泄露了。我们拿到之后从头到尾读了一遍，发现这套系统的设计哲学跟市面上绝大多数 agent 框架截然不同——**它不追求架构上的"优雅"，而是追求工程上的"正确"。**

这个系列就是我们的读后笔记。我们把 Claude Code 拆成了 18 个子系统，每篇文章都包含：

- **源码级的代码分析**——不是看文档猜实现，而是直接读 `query.ts` 的 1729 行、`permissions.ts` 的 1486 行、`client.ts` 的 3348 行
- **设计决策的深度推演**——不只是"它这样做了"，而是"为什么这样做、还有什么替代方案、各自的 trade-off 是什么"
- **与业界方案的横向对比**——LangGraph、CrewAI、AutoGen、Cursor、Copilot 等，放在一起比较才能看出差异

## 核心发现

读完整个代码库，我们总结了 Claude Code 区别于其他 agent 框架的**五个核心设计决策**：

### 1. 循环优于图

市面上 90% 的 agent 框架用 DAG（有向无环图）编排工具调用。Claude Code 的核心就是一个 `while(true)` 循环——没有状态机，没有图编排引擎，没有 workflow DSL。

听起来原始，但这恰恰是最灵活的选择。图的拓扑是编译时确定的，循环的行为是运行时决定的。当你的 agent 需要根据中间结果动态调整策略时，图是约束，循环是自由。

→ 详见 [00-核心结论](00-core-conclusion.md) 和 [02-主循环](02-main-loop.md)

### 2. 递归优于编排

子 agent 不是新进程、不是微服务、不是独立的 workflow。它就是递归调用了同一个 `query()` 函数。这意味着主循环的所有能力——四层压缩、七种错误恢复、流式工具执行——自动对所有子 agent 生效。维护成本是 O(1)，不是 O(n)。

→ 详见 [06-子Agent](06-sub-agent.md)

### 3. 模型做决策，框架做执行

Claude Code 不尝试在框架层面理解任务的依赖关系。它相信模型知道自己在干什么——如果模型一次输出了三个 Read 调用，那它们就是可以并行的。框架只守一个安全约束：有副作用的操作串行执行。其他的，交给模型。

→ 详见 [04-工具编排](04-tool-orchestration.md)

### 4. 为真实世界设计，不为 demo 设计

四层上下文压缩、三级 413 错误恢复、max_output_tokens 续写、streaming fallback 的 tombstone 处理——这些在 5 分钟的 demo 里完全用不到。但一个使用 Claude Code 4 小时的工程师，会遇到所有这些边界情况。

→ 详见 [07-上下文窗口](07-context-window.md) 和 [11-设计哲学](11-design-philosophy.md)

### 5. 不可变性是成本优化

API 返回的消息对象永远不被修改。这不是代码风格偏好——它直接影响了 prompt caching 的命中率。一个不可变性约束，让长会话的 input 成本降低了 80%。

→ 详见 [09-不可变API消息](09-immutable-api-messages.md)

---

## 目录

### Part 1：核心 Agent 引擎

Agent 执行的核心链路——从用户敲下回车到模型生成响应到工具执行再到下一轮循环。

| # | 主题 | 你会学到什么 |
|---|------|-------------|
| 00 | [核心结论](00-core-conclusion.md) | 为什么 `while(true)` 比 DAG 更适合 agent。与 LangGraph、CrewAI、AutoGen 的对比。ReAct 循环从学术到工程的演进。 |
| 01 | [入口流程](01-entry-point.md) | 从 `main.tsx` 到 `QueryEngine` 到 `query()` 的完整调用链。启动阶段的并行预取优化。WAL 式的断点续传设计。 |
| 02 | [主循环](02-main-loop.md) | `queryLoop` 函数的 1488 行逐段剖析。`State` 类型的 10 个字段各自的故事。7 个 continue site 的精确语义和保护机制。 |
| 03 | [流式处理](03-streaming.md) | `StreamingToolExecutor` 如何在 API 流式返回的同时执行工具。三层 AbortController 层级。为什么只有 Bash 错误触发 sibling abort。 |
| 04 | [工具编排](04-tool-orchestration.md) | `partitionToolCalls` 的贪心分区算法。为什么不做依赖分析。延迟上下文修改器如何解决并发竞态。 |
| 05 | [权限系统](05-permission-system.md) | 1486 行的权限决策链。5 种权限模式的行为差异。推测性 Bash 分类器的 2 秒超时设计。企业 Policy Limits 如何覆盖用户设置。 |
| 06 | [子Agent](06-sub-agent.md) | 递归调用 `query()` 的设计为什么比编排框架更好。隔离设计的五个维度。Worktree 隔离如何让 agent 大胆实验。 |
| 07 | [上下文窗口管理](07-context-window.md) | 四层递进式压缩（Snip → Microcompact → Context Collapse → AutoCompact）。每层的成本和保真度权衡。三级 413 恢复瀑布。 |
| 08 | [消息类型系统](08-message-types.md) | 7 种消息类型的角色和设计理由。TombstoneMessage 如何解决流式系统的追溯性撤回难题。5512 行的消息工具库。 |
| 09 | [不可变API消息](09-immutable-api-messages.md) | Anthropic prompt caching 的字节匹配机制。clone-before-modify 模式和惰性克隆优化。长会话的成本量化分析。 |
| 10 | [全局架构图](10-architecture-diagram.md) | 增强版调用关系图。四种状态作用域的拓扑。并发模型图。Feature Flag 的编译时死代码消除。 |
| 11 | [设计哲学](11-design-philosophy.md) | 四个核心决策的深度展开和边界分析。"无聊但必要"的工程清单。什么是好的 agent 框架。 |

### Part 2：外围子系统

核心引擎之外的六大系统——它们让 Claude Code 从一个"能跑的 agent"变成一个"好用的产品"。

| # | 主题 | 你会学到什么 |
|---|------|-------------|
| 12 | [MCP 集成](12-mcp-integration.md) | 3348 行的 MCP 客户端架构。6 种 Transport（Stdio/SSE/HTTP/WebSocket/InProcess/SdkControl）。OAuth + XAA 企业认证。工具发现的 LRU 缓存策略。 |
| 13 | [Memory 系统](13-memory-system.md) | 五种记忆类型和 frontmatter 存储格式。Sonnet 驱动的相关性检索。异步预取的 RAII 生命周期管理。Session Memory 的渐进式自动提取。 |
| 14 | [System Prompt 构建](14-system-prompt.md) | 动态边界如何分割可缓存和不可缓存的 prompt 区域。20+ 个 Section 的模块化组装。五种信息来源的合并策略。 |
| 15 | [Session Resume 与 Bridge](15-session-resume.md) | JSONL transcript 的 WAL 式持久化。消息链通过 parentUuid 重建。两代 Bridge Transport（WebSocket → SSE+CCR）。VS Code 扩展的远程权限桥接。 |
| 16 | [工具实现](16-tool-implementations.md) | `Tool` 接口的 30+ 个方法/属性。`buildTool()` 的 fail-closed 安全默认。BashTool 的 430KB 安全代码。延迟加载与 ToolSearch。 |
| 17 | [Hook 系统](17-hook-system.md) | 13 种生命周期事件。5 种 Hook 类型（Command/Prompt/Agent/HTTP/Function）。退出码 2 的阻断机制。Hook 如何驱动主循环的第 6 个 continue site。 |

## 阅读路线推荐

根据你的目标，选择不同的阅读路线：

**"我想快速了解 Claude Code 的设计思路"**（30 分钟）
> 00 → 11

**"我想深入理解 Agent 核心引擎"**（2-3 小时）
> 00 → 01 → 02 → 03 → 04 → 07 → 09

**"我在构建自己的 Agent 系统，想学习最佳实践"**（3-4 小时）
> 00 → 02 → 04 → 05 → 06 → 07 → 11

**"我想全面了解 Claude Code 的完整架构"**（6-8 小时）
> 按顺序从 00 读到 17

**"我关注安全和权限设计"**
> 05 → 17 → 16（BashTool 安全部分）

**"我关注性能和成本优化"**
> 07 → 09 → 14 → 03

## 关键数字

| 指标 | 数值 |
|------|------|
| 分析的源码总行数 | ~50,000+ |
| 核心文件数 | 15 个关键文件 |
| 工具数量 | 45+ |
| 主循环 continue site | 7 个 |
| 上下文压缩层数 | 4 层 |
| 错误恢复级别 | 3 级（413）+ 2 级（max_tokens） |
| 权限模式 | 5 种 |
| Hook 事件类型 | 13 种 |
| MCP Transport 类型 | 6 种 |
| 消息类型 | 7 种 |

## 关键源文件索引

| 文件 | 行数 | 核心职责 |
|------|------|----------|
| `query.ts` | 1729 | Agent 主循环，所有恢复逻辑 |
| `QueryEngine.ts` | 1295 | 会话管理，入口编排 |
| `StreamingToolExecutor.ts` | 530 | 流式工具并发执行 |
| `toolOrchestration.ts` | 188 | 工具批次分区与编排 |
| `toolExecution.ts` | 1745 | 单工具执行、权限检查 |
| `permissions.ts` | 1486 | 权限决策链 |
| `runAgent.ts` | 973 | 子Agent 递归调用 |
| `utils/messages.ts` | 5512 | 消息工厂与转换 |
| `services/compact/` | ~11文件 | 四层上下文压缩 |
| `services/mcp/client.ts` | 3348 | MCP 连接与工具调用 |
| `memdir/` | 8文件 | 记忆存储与检索 |
| `constants/prompts.ts` | 914 | System Prompt 组装 |
| `bridge/replBridge.ts` | ~2800 | Bridge 通信层 |
| `Tool.ts` | 793 | 工具接口定义 |
| `utils/hooks/` | ~17文件 | Hook 生命周期系统 |
