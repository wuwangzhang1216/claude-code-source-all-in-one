# 00 - 核心结论深度分析：while(true) 循环 vs DAG

---

## 1. DAG 范式的前世今生

### 1.1 什么是 DAG 编排

DAG（有向无环图）编排是目前主流 agent 框架的核心范式。它的基本思路是：把 agent 的行为拆解为一系列"节点"（Node），每个节点执行一个特定的操作（如调用 LLM、执行工具、条件判断），节点之间通过"边"（Edge）连接，形成一个有向无环图。

典型代表：

| 框架 | 编排方式 | 核心抽象 |
|------|----------|----------|
| **LangGraph** | 状态图（StateGraph） | Node + Edge + State |
| **CrewAI** | 角色编排 | Agent + Task + Crew |
| **AutoGen** | 对话协议 | ConversableAgent + GroupChat |
| **Semantic Kernel** | 管道编排 | Plugin + Planner + Pipeline |
| **Dify** | 可视化 DAG | WorkflowNode + Connection |

### 1.2 DAG 的优点

DAG 编排确实有其优势，不能一概否定：

1. **可视化友好**——DAG 天然适合用流程图展示，Dify、Coze 等产品靠这个做了很好的低代码体验
2. **可解释性强**——每一步做了什么、下一步去哪，一目了然
3. **确定性管道**——对于固定流程（如 RAG 管线：检索 → 重排 → 生成），DAG 提供了清晰的结构
4. **并行编排**——DAG 的拓扑排序天然支持无依赖节点的并行执行

### 1.3 DAG 的根本局限

但在 **agent 场景**（而非固定管线）下，DAG 有一个根本问题：

> **图的拓扑是编译时确定的，agent 的行为是运行时决定的。**

一个真实的编程 agent 需要：
- 读了文件发现不对，临时决定去搜索另一个目录
- 执行了一个命令失败了，动态调整策略
- 在修改过程中发现需要先修另一个依赖

这些"临时决定"在 DAG 中要么需要预先枚举所有可能的分支（导致图爆炸），要么需要"动态图"——但动态图本质上就是在运行时构建图，那为什么不直接用循环？

### 1.4 LangGraph 的例子

LangGraph 试图用 `conditional_edge` 来解决动态路由：

```python
# LangGraph 的条件边
graph.add_conditional_edges(
    "agent",
    should_continue,          # 运行时决定下一个节点
    {"continue": "tools", "end": END}
)
```

但这种方式有两个问题：
1. `should_continue` 的返回值集合必须在定义时枚举——你不能在运行时发明一个新目标节点
2. 每增加一种新的"继续原因"，就需要修改图定义——而 Claude Code 的 7 种 continue 原因都是在循环体内自然处理的

---

## 2. Claude Code 的 while(true) 循环

### 2.1 async generator 模式

Claude Code 的核心循环不是一个普通函数，而是一个 **async generator**：

```typescript
// query.ts:241
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
```

这个设计选择有深意。`async function*` 有三个关键特性：

1. **惰性求值**——只有消费者调用 `.next()` 时才执行下一步，天然支持背压（backpressure）
2. **双向通信**——`yield` 既能输出数据，也能接收外部信号（虽然这里主要用 AbortController）
3. **组合性**——`yield*` 可以把一个 generator 的输出委托给另一个，形成管道

### 2.2 yield* 委托链

入口函数 `query()` 通过 `yield*` 将控制权完全委托给 `queryLoop()`：

```typescript
// query.ts:219-239
export async function* query(
  params: QueryParams,
): AsyncGenerator<...> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // 只有 queryLoop 正常返回才会执行到这里
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}
```

`yield*` 的语义是：**把内层 generator 的每个 yield 原样传递给外层的消费者**。这意味着 `queryLoop` yield 的每条消息、每个流事件，都会直接传递到 `QueryEngine.submitMessage()` 的 `for await` 循环中。

### 2.3 循环体的真实结构

去掉错误处理和边缘情况后，循环体的骨架是：

```typescript
while (true) {
  // 1. 解构状态
  let { toolUseContext } = state
  const { messages, autoCompactTracking, ... } = state

  // 2. 四层上下文压缩
  let messagesForQuery = messages
  messagesForQuery = snip(messagesForQuery)
  messagesForQuery = microcompact(messagesForQuery)
  messagesForQuery = contextCollapse(messagesForQuery)
  messagesForQuery = autocompact(messagesForQuery)

  // 3. 流式调用 API
  for await (const event of callModel(messagesForQuery)) {
    yield event                          // 直接传给 UI
    if (event.type === 'tool_use') {
      streamingToolExecutor.addTool(event) // 边流边执行
    }
  }

  // 4. 收集剩余工具结果
  for await (const result of streamingToolExecutor.getRemainingResults()) {
    yield result
  }

  // 5. 决策：继续还是结束
  if (needsFollowUp) {
    state = { messages: [...messagesForQuery, ...results], ... }
    continue  // ← 关键：回到循环顶部
  }
  return { reason: 'completed' }
}
```

**注意这里没有任何"路由"逻辑。** 循环要么 `continue`（带着新状态回到顶部），要么 `return`（结束 generator）。没有条件分支、没有节点跳转、没有状态转移表。

---

## 3. ReAct 循环的工程演进

### 3.1 学术原型

2022 年 Yao et al. 提出的 ReAct（Reason + Act）范式，核心就是一个循环：

```
Thought → Action → Observation → Thought → Action → ...
```

Claude Code 的循环可以看作 ReAct 的工程级实现，但加入了大量真实世界的处理：

| ReAct 原型 | Claude Code 实现 |
|-----------|-----------------|
| Thought | 模型的 thinking block |
| Action | tool_use block |
| Observation | tool_result（包含错误恢复） |
| 循环终止 | 7 种 continue 原因 + 多种 return 原因 |
| 无 | 四层上下文压缩 |
| 无 | 流式处理 + 并发工具执行 |
| 无 | 权限检查 + 安全分类 |

### 3.2 从学术到工程的鸿沟

ReAct 论文里的循环大约 20 行 Python。Claude Code 的 `queryLoop` 是 **1488 行 TypeScript**（1729 - 241）。

这 1468 行的差距，就是学术原型和生产系统之间的距离。它包括：

- **7 个 continue site**——每个都有不同的状态恢复语义
- **多级错误恢复**——413、max_output_tokens、模型降级、用户中断
- **缓存优化**——不可变消息、prompt caching 感知
- **并发控制**——流式工具执行、sibling abort
- **可观测性**——analytics 事件、query chain tracking

---

## 4. 为什么 while(true) 更适合 Agent

### 4.1 灵活性论证

考虑 Claude Code 的 7 种 continue 原因：

1. **模型降级**（line 950）——主模型过载，切换到备用模型
2. **Context Collapse 排空**（line 1115）——413 后排空 collapse 队列
3. **反应式压缩**（line 1165）——紧急全量压缩
4. **Max Output Tokens 升级**（line 1220）——8k → 64k
5. **Max Output Tokens 恢复**（line 1251）——注入续写提示
6. **Stop Hook 阻断**（line 1305）——hook 返回错误，需要重试
7. **Token 预算续行**（line 1340）——预算允许继续

在 DAG 中，这 7 种情况需要 7 条回边——从"结束节点"回到"开始节点"的边。每条回边都有不同的上下文（比如 collapse_drain_retry 需要带上 `committed` 计数）。这在图中会形成复杂的循环结构，而且 DAG 定义上不允许循环——你需要把它变成一个有环图（DCG），这就失去了 DAG 的核心优势。

而在 `while(true)` 中，每种情况只是一个 `state = { ... }; continue`——自然、直观、不需要额外的抽象。

### 4.2 错误恢复论证

Claude Code 的错误恢复是**瀑布式**的：

```
413 错误
  → 尝试 collapse drain（如果之前没试过）
    → 成功 → continue
    → 失败 → 尝试 reactive compact
      → 成功 → continue
      → 失败 → 向用户报错，return
```

这种嵌套的条件恢复在循环中就是自然的 if-else 链。在 DAG 中，你需要设计一个"错误恢复子图"，而且这个子图需要访问主图的状态（比如 `hasAttemptedReactiveCompact`），这就引入了跨子图的状态共享问题。

### 4.3 类型安全论证

原文提到的 TypeScript 类型安全技巧值得深入分析：

```typescript
// 每个 continue site 都必须提供完整的 State 对象
const next: State = {
  messages: drained.messages,
  toolUseContext,
  autoCompactTracking: tracking,
  maxOutputTokensRecoveryCount,
  hasAttemptedReactiveCompact,
  maxOutputTokensOverride: undefined,
  pendingToolUseSummary: undefined,
  stopHookActive: undefined,
  turnCount,
  transition: { reason: 'collapse_drain_retry', committed: drained.committed },
}
state = next
continue
```

如果你漏掉了任何一个字段（比如忘了设 `pendingToolUseSummary`），TypeScript 编译器会立即报错。这在 DAG 框架中很难实现——状态通常是一个松散的字典或者 JSON 对象，缺少编译时检查。

---

## 5. 什么时候 DAG 更好

公平地说，while(true) 不是万能的：

| 场景 | DAG 更优 | while(true) 更优 |
|------|---------|-----------------|
| 固定管线（RAG、ETL） | ✅ 结构清晰 | ❌ 过于灵活 |
| 可视化需求 | ✅ 天然可视化 | ❌ 需要额外日志 |
| 多人协作低代码 | ✅ 图形化编辑 | ❌ 需要代码 |
| 动态决策 agent | ❌ 图爆炸 | ✅ 自然适配 |
| 长时间会话 | ❌ 状态管理复杂 | ✅ 状态集中 |
| 错误恢复 | ❌ 需要复杂回边 | ✅ continue 即可 |

Claude Code 选择 while(true)，是因为它的使用场景——**长时间、动态决策、需要复杂错误恢复的编程 agent**——恰好是 DAG 最不适合的领域。

---

## 6. 设计启示

### 6.1 简单性是特性

> "Simplicity is the ultimate sophistication." — Leonardo da Vinci

Claude Code 的 while(true) 循环之所以强大，恰恰因为它足够简单。简单意味着：

- **易于理解**——新工程师加入团队，花 30 分钟就能理解循环的整体结构
- **易于调试**——出了问题，只需要看 `state.transition` 就知道上一次循环为什么 continue
- **易于扩展**——新增第 8 种 continue 原因？加一个 if 块和一个 `state = { ... }; continue` 就行

### 6.2 框架的职责边界

Claude Code 的设计暗示了一个关于 agent 框架的核心洞察：

> **框架应该管理执行（how），而不是管理决策（what）。**

DAG 框架试图在框架层面管理"下一步做什么"——这恰恰应该是模型决定的事。Claude Code 的框架只管三件事：

1. 调 API，拿结果
2. 执行工具，管权限
3. 管理上下文窗口

至于"接下来该读哪个文件"、"要不要并行调三个工具"——这些决策完全交给模型。

这种设计的哲学基础是：**如果你的模型足够强，框架应该尽量少干预。** 框架的工程复杂性应该花在 robustness（错误恢复、上下文管理）上，而不是 intelligence（决策路由）上。
