# 06 - 子 Agent 深度分析：递归而非编排

---

## 1. 核心设计：递归调用 query()

### 1.1 一行代码说明一切

```typescript
// runAgent.ts:15
import { query } from '../../query.js'
```

子 agent 的全部"魔法"就在这个 import 里。它导入了主循环的 `query()` 函数，然后**递归调用**它：

```typescript
// runAgent.ts 核心逻辑（极度简化）
export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  availableTools,
  ...
}): AsyncGenerator<Message, void> {
  // 创建子 agent 的上下文
  const childContext = createSubagentContext(toolUseContext)
  const childTools = filterToolsForAgent(agentDefinition, availableTools)
  
  // 递归调用主循环
  for await (const event of query({
    messages: promptMessages,
    tools: childTools,
    toolUseContext: childContext,
    canUseTool,
  })) {
    yield event  // 流式传递子 agent 的输出
  }
}
```

这意味着子 agent 自动继承了主循环的**所有能力**：
- 四层上下文压缩
- 七种错误恢复
- 流式工具执行
- 权限检查
- 模型降级

**不需要为子 agent 单独实现任何基础设施。**

### 1.2 递归 vs 编排的对比

| 特性 | 递归（Claude Code） | 编排（CrewAI/AutoGen） |
|------|---------------------|----------------------|
| 基础设施代码 | 写一次，自动继承 | 每层独立实现 |
| 新功能传播 | 自动（加在 query 里就行） | 手动（每层更新） |
| 维护成本 | O(1) | O(n)，n = agent 层数 |
| 嵌套深度 | 受 token 预算限制 | 受架构限制 |
| 调试复杂度 | 只看一个函数 | 需要跨多个框架概念 |

---

## 2. 隔离设计：选择性共享

### 2.1 createSubagentContext

子 agent 的上下文是从父 agent **派生**的，但有选择性的隔离：

```typescript
// utils/forkedAgent.ts（简化）
function createSubagentContext(parentContext: ToolUseContext): ToolUseContext {
  return {
    // 隔离的
    abortController: new AbortController(),            // 独立取消
    fileStateCache: parentContext.fileStateCache.clone(), // 克隆文件缓存
    agentId: generateId(),                              // 独立 ID
    
    // 共享的
    setAppState: parentContext.setAppState,   // 全局状态路由到根
    getAppState: parentContext.getAppState,   // 全局状态
    
    // 受限的
    options: {
      tools: filteredTools,                   // 可能是工具子集
      ...parentContext.options,
    },
  }
}
```

### 2.2 为什么 AbortController 隔离

如果子 agent 的 abort 和父 agent 共享，那么：
- 子 agent 被取消 → 父 agent 也被取消 → 整个会话终止

这不是想要的行为。子 agent 可能因为超时或用户取消被终止，但父 agent 应该能继续工作（比如告诉用户"子 agent 超时了，我换个方法"）。

### 2.3 为什么文件缓存克隆

文件缓存是一个性能优化——避免重复读取同一个文件。克隆的原因：

1. **父→子**：子 agent 继承父 agent 已经读过的文件缓存，避免重复 I/O
2. **子→父**：子 agent 读的新文件不污染父 agent 的缓存（子 agent 可能在不同的 worktree 中）
3. **子→子**：多个子 agent 之间互不影响

```typescript
// 克隆时设置大小限制
const childCache = parentCache.clone()
childCache.maxSize = READ_FILE_STATE_CACHE_SIZE  // 防止内存泄漏
```

### 2.4 为什么 AppState 共享

`AppState` 包含了全局状态，最重要的是**权限更新**。

场景：用户在子 agent 的弹框中点了 "Always Allow for Read"。如果 AppState 不共享，这个决策只对当前子 agent 生效——父 agent 和其他子 agent 还会继续弹框。

通过路由到根 store，权限更新对所有 agent **立即全局生效**。

---

## 3. Agent 定义系统

### 3.1 AgentDefinition 类型

每个 agent 类型由一个定义文件描述：

```typescript
type AgentDefinition = {
  name: string              // "Explore", "Plan", "general-purpose"
  prompt: string            // agent 的系统提示
  tools: string[]           // 可用工具列表（或 ['*']）
  model?: string            // 模型覆盖
  permissionMode?: string   // 权限模式覆盖
  mcpServers?: McpServer[]  // agent 专属的 MCP 服务器
}
```

### 3.2 内置 Agent 类型

Claude Code 内置了几种 agent 类型：

| Agent | 工具限制 | 典型用途 |
|-------|---------|---------|
| `general-purpose` | 所有工具 | 复杂多步骤任务 |
| `Explore` | 只读工具（无 Edit/Write） | 代码搜索和探索 |
| `Plan` | 只读工具（无 Edit/Write） | 设计实现方案 |

### 3.3 工具过滤

`filterToolsForAgent()` 根据 agent 定义过滤可用工具：

```typescript
// agentToolUtils.ts:70-116
function filterToolsForAgent(
  agentDefinition: AgentDefinition,
  allTools: Tools,
): Tools {
  // 1. MCP 工具（mcp__*）始终允许
  // 2. ALL_AGENT_DISALLOWED_TOOLS 对所有 agent 禁用
  // 3. CUSTOM_AGENT_DISALLOWED_TOOLS 对非内置 agent 禁用
  // 4. 异步 agent 有额外的允许工具列表限制
}
```

MCP 工具始终允许的设计很有意思——这意味着自定义 MCP 服务器提供的工具对所有 agent 类型可用，不受工具过滤影响。

---

## 4. 后台 Agent

### 4.1 fire-and-forget 模式

当 `run_in_background: true` 时：

```
父 agent:  [处理工具1] [处理工具2] [继续对话...]
                                        ↑
子 agent:  [独立运行中...]  ──完成通知──→ ┘
```

父 agent 不等待子 agent 完成。子 agent 在后台独立运行，完成后通过通知机制告知父 agent。

### 4.2 生命周期管理

```typescript
// agentToolUtils.ts:508-686
async function runAsyncAgentLifecycle({
  agentGenerator,
  taskId,
  progressTracker,
  ...
}) {
  try {
    // 1. 驱动 query generator
    for await (const message of agentGenerator) {
      // 更新进度
      updateAsyncAgentProgress(taskId, message)
    }
    
    // 2. 成功完成
    transitionTaskState(taskId, 'completed')
    enqueueNotification(taskId, 'completed')
    
  } catch (error) {
    // 3. 失败处理
    transitionTaskState(taskId, 'failed')
    enqueueNotification(taskId, 'failed')
  }
}
```

### 4.3 权限处理

后台 agent 有一个棘手的问题：它需要权限确认，但 UI 焦点在父 agent 上。

解决方案取决于配置：

```typescript
if (isAsync) {
  // 默认：跳过权限弹框，使用 shouldAvoidPermissionPrompts
  shouldAvoidPermissionPrompts: true
  
  // 但如果显式配置了 canShowPermissionPrompts：
  if (canShowPermissionPrompts) {
    // 可以弹框，但先等自动化检查完成
    awaitAutomatedChecksBeforeDialog: true
  }
}
```

`awaitAutomatedChecksBeforeDialog: true` 确保在弹框之前先运行所有自动化检查（如分类器）——减少不必要的弹框。

---

## 5. Worktree 隔离

### 5.1 什么是 Git Worktree

Git worktree 允许你在同一个仓库中同时检出多个分支：

```bash
git worktree add /tmp/my-experiment feature-branch
# 现在 /tmp/my-experiment 是一个完整的仓库副本
# 在 feature-branch 上工作
```

### 5.2 在 Claude Code 中的应用

当 `isolation: "worktree"` 时：

```
1. 创建临时 worktree（新分支）
2. 子 agent 在 worktree 目录中工作
3. 所有文件操作都在 worktree 中（不影响主仓库）
4. 子 agent 完成后：
   ├─ 有变更 → 返回 worktree 路径和分支名
   └─ 无变更 → 自动清理 worktree
```

### 5.3 使用场景

```
用户: "试试用 Redis 替代 Memcached，看看性能怎么样"

Claude Code:
  ├─ 主分支: 保持不动
  └─ Worktree（子 agent）:
      ├─ 替换 Memcached → Redis
      ├─ 运行 benchmark
      ├─ 报告结果
      └─ 如果用户满意 → 合并分支
         如果不满意 → 丢弃 worktree
```

这解决了一个真实痛点：**让 agent 大胆实验，不怕搞砸**。

### 5.4 工程细节

Worktree 的创建和清理由 `EnterWorktreeTool` 和 `ExitWorktreeTool` 管理：

- 创建时：`git worktree add` + 设置工作目录
- 清理时：检查是否有未提交的变更
  - 有变更：保留 worktree，返回路径信息
  - 无变更：`git worktree remove` 自动清理

---

## 6. MCP 服务器生命周期

### 6.1 Agent 专属 MCP 服务器

Agent 定义可以声明自己需要的 MCP 服务器：

```yaml
# agent 定义
name: database-explorer
mcpServers:
  - name: postgres
    command: npx
    args: ["@modelcontextprotocol/server-postgres"]
```

### 6.2 初始化和清理

```typescript
// runAgent.ts:95-218
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: McpClients,
): Promise<{ clients: McpClients; cleanup: () => Promise<void> }> {
  // 1. 继承父 agent 的 MCP 连接
  const mergedClients = { ...parentClients }
  
  // 2. 启动 agent 专属的 MCP 服务器
  for (const server of agentDefinition.mcpServers) {
    mergedClients[server.name] = await startMcpServer(server)
  }
  
  // 3. 返回清理函数（只清理新创建的，不关闭继承的）
  return {
    clients: mergedClients,
    cleanup: async () => {
      for (const server of agentDefinition.mcpServers) {
        await mergedClients[server.name].close()
      }
    }
  }
}
```

**只清理新创建的**——继承的 MCP 连接由父 agent 管理，子 agent 不应该关闭它们。

---

## 7. 上下文传递

### 7.1 forkContextMessages

父 agent 可以传递部分对话历史给子 agent：

```typescript
// runAgent.ts:369-378
if (forkContextMessages) {
  // 过滤不完整的工具调用
  const filtered = filterIncompleteToolCalls(forkContextMessages)
  promptMessages = [...filtered, ...promptMessages]
}
```

**过滤不完整的工具调用**是关键——如果父 agent 的历史中有一个 `tool_use` 但没有对应的 `tool_result`（比如工具正在执行中），把它传给子 agent 会导致 API 400 错误。

### 7.2 Prompt Cache 稳定性

`forkContextMessages` 还有一个缓存优化的作用：如果子 agent 使用相同的上下文前缀，prompt caching 可以利用这些共享前缀。

---

## 8. Auto 模式下的分类检查

### 8.1 Handoff 分类

当 `auto` 模式启用时，子 agent 的输出在返回给用户之前会经过**分类检查**：

```typescript
// agentToolUtils.ts:404-460
async function classifyHandoffIfNeeded(
  agentOutput: Message[],
  autoModeEnabled: boolean,
) {
  if (!autoModeEnabled) return
  
  const decision = await classifyYoloAction(agentOutput)
  
  if (decision === 'block') {
    // 阻止子 agent 的输出直接展示给用户
    // 需要人工确认
  }
}
```

这是一层**额外的安全网**——即使子 agent 的权限检查通过了，它的最终输出仍然会被分类器审查。

---

## 9. 总结

Claude Code 的子 agent 系统证明了一个反直觉的设计原则：

> **最强大的抽象不是创建新概念，而是复用已有概念。**

- 没有新的"Crew"抽象——子 agent 就是递归的 query()
- 没有新的通信协议——子 agent 通过 yield 传递消息
- 没有新的状态管理——隔离通过 context 克隆实现
- 没有新的权限模型——子 agent 继承父 agent 的权限

结果是一个**零额外概念**的子 agent 系统——你理解了 query()，就理解了子 agent。
