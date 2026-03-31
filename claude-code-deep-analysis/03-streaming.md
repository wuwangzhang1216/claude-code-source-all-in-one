# 03 - 流式处理深度分析：不只是逐字显示

---

## 1. StreamingToolExecutor 的核心设计

### 1.1 为什么需要流式工具执行

传统的 agent 框架是这样执行工具的：

```
1. 等待 API 完整响应
2. 解析出所有 tool_use blocks
3. 按顺序执行每个工具
4. 收集所有结果
5. 发送给 API
```

Claude Code 的方式完全不同：

```
1. API 开始流式返回
2. 一个 tool_use block 完整到达 → 立即开始执行
3. 继续接收流 → 更多 tool_use blocks → 并行执行
4. API 响应结束
5. 等待所有工具完成
```

**核心优势：工具执行和 API 流式传输重叠。** 如果模型输出了 3 个 Read 工具，第一个 Read 在模型还在输出第三个的时候就已经开始执行了。

### 1.2 类结构

```typescript
// StreamingToolExecutor.ts:40-62
export class StreamingToolExecutor {
  private tools: TrackedTool[] = []           // 所有已知工具
  private toolUseContext: ToolUseContext       // 共享上下文
  private hasErrored = false                  // 是否有 Bash 工具报错
  private erroredToolDescription = ''         // 报错工具的描述
  private siblingAbortController: AbortController  // sibling abort
  private discarded = false                   // 是否被丢弃（model fallback）
  private progressAvailableResolve?: () => void    // 进度唤醒信号
}
```

### 1.3 TrackedTool 生命周期

每个工具经历四个状态：

```
queued → executing → completed → yielded
  │         │           │          │
  │         │           │          └─ 结果已传给消费者
  │         │           └─ 执行完成，结果已缓存
  │         └─ 正在执行中
  └─ 等待执行
```

```typescript
// StreamingToolExecutor.ts:21-32
type TrackedTool = {
  id: string
  block: ToolUseBlock
  assistantMessage: AssistantMessage
  status: ToolStatus   // 'queued' | 'executing' | 'completed' | 'yielded'
  isConcurrencySafe: boolean
  promise?: Promise<void>
  results?: Message[]
  pendingProgress: Message[]         // 进度消息（立即 yield）
  contextModifiers?: Array<(ctx: ToolUseContext) => ToolUseContext>
}
```

**进度消息和结果消息的分离**是一个关键设计。进度消息（如 Bash 命令的实时输出）需要**立即**传递给 UI，而结果消息需要**按顺序**传递（确保 tool_use/tool_result 配对）。

---

## 2. 并发控制模型

### 2.1 canExecuteTool 判断

```typescript
// StreamingToolExecutor.ts:129-135
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return (
    executingTools.length === 0 ||                           // 没有正在执行的工具
    (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))  // 都是并发安全的
  )
}
```

规则很简单：
- 如果没有工具在执行 → 可以执行
- 如果有工具在执行，且当前工具和所有正在执行的工具**都是并发安全的** → 可以执行
- 否则 → 排队等待

### 2.2 processQueue 调度

```typescript
// StreamingToolExecutor.ts:140-151
private async processQueue(): Promise<void> {
  for (const tool of this.tools) {
    if (tool.status !== 'queued') continue

    if (this.canExecuteTool(tool.isConcurrencySafe)) {
      await this.executeTool(tool)
    } else {
      // 非并发安全工具阻塞后续所有工具
      if (!tool.isConcurrencySafe) break
    }
  }
}
```

**关键细节**：当遇到一个不能执行的非并发安全工具时，`break`——不继续检查后面的工具。这保证了**有副作用的操作按模型输出的顺序执行**。

但如果遇到的是一个并发安全工具不能执行（因为前面有非并发安全工具在执行），则**跳过**它而不 break——它可以在前面的工具完成后再执行。

### 2.3 执行流示例

假设模型输出了：`[Read_1, Read_2, Bash_1, Read_3, Read_4]`

```
时间线:
T0: addTool(Read_1) → 立即执行（无工具在执行）
T1: addTool(Read_2) → 立即执行（Read_1 是并发安全的）
T2: addTool(Bash_1) → 排队（Read_1, Read_2 在执行）
T3: addTool(Read_3) → 排队（Bash_1 在排队，且非并发安全，break）
T4: addTool(Read_4) → 排队
T5: Read_1 完成 → processQueue → Bash_1 还不能执行（Read_2 还在）
T6: Read_2 完成 → processQueue → Bash_1 开始执行
T7: Bash_1 完成 → processQueue → Read_3 开始, Read_4 开始
T8: Read_3 + Read_4 完成
```

---

## 3. 三层 AbortController 层级

### 3.1 层级关系

```
toolUseContext.abortController (顶层 - 用户按 Ctrl+C)
  ↓ createChildAbortController
siblingAbortController (中层 - Bash 错误级联)
  ↓ createChildAbortController
toolAbortController (底层 - 每个工具独立)
```

这是一个**树状取消传播**模型：
- 顶层 abort → 所有工具停止
- 中层 abort → 当前批次的兄弟工具停止，但不影响循环
- 底层 abort → 只影响单个工具

### 3.2 为什么只有 Bash 触发 sibling abort

```typescript
// StreamingToolExecutor.ts:357-363
if (isErrorResult) {
  thisToolErrored = true
  if (tool.block.name === BASH_TOOL_NAME) {
    this.hasErrored = true
    this.erroredToolDescription = this.getToolDescription(tool)
    this.siblingAbortController.abort('sibling_error')
  }
}
```

**只有 Bash 工具的错误会触发 sibling abort**。源码注释解释了原因：

> "Only Bash errors cancel siblings. Bash commands often have implicit dependency chains (e.g. mkdir fails → subsequent commands pointless). Read/WebFetch/etc are independent — one failure shouldn't nuke the rest."

这是一个基于**领域知识**的工程决策：
- Bash 命令之间通常有隐式依赖（`mkdir` 失败 → 后续 `cd` 无意义）
- Read/Grep/WebFetch 是独立的（一个文件读不到不影响另一个）

### 3.3 合成错误消息

被 abort 的工具不能简单地"消失"——API 要求每个 `tool_use` block 必须有对应的 `tool_result`。因此，被取消的工具会收到一个**合成的错误消息**：

```typescript
// StreamingToolExecutor.ts:153-204
private createSyntheticErrorMessage(
  toolUseId: string,
  reason: 'sibling_error' | 'user_interrupted' | 'streaming_fallback',
  assistantMessage: AssistantMessage,
): Message {
  if (reason === 'sibling_error') {
    return createUserMessage({
      content: [{
        type: 'tool_result',
        content: `<tool_use_error>Cancelled: parallel tool call ${desc} errored</tool_use_error>`,
        is_error: true,
        tool_use_id: toolUseId,
      }],
    })
  }
  // ... 其他原因的合成消息
}
```

这些合成消息确保了 API 的 tool_use/tool_result **配对完整性**——即使工具被取消，模型也能看到"这个工具因为 X 原因被取消了"。

### 3.4 权限拒绝的特殊处理

当用户拒绝一个工具的权限时，per-tool abort 需要**向上冒泡**到顶层：

```typescript
// StreamingToolExecutor.ts:304-318
// Permission-dialog rejection also aborts this controller
// — that abort must bubble up to the query controller so the
// query loop's post-tool abort check ends the turn.
const toolAbortController = createChildAbortController(this.siblingAbortController)
toolAbortController.signal.addEventListener('abort', () => {
  if (toolAbortController.signal.reason === 'permission_rejected') {
    toolUseContext.abortController.abort('permission_rejected')
  }
})
```

这是一个**选择性冒泡**——只有 `permission_rejected` 原因会冒泡到顶层，其他原因（如 `sibling_error`）不会。这确保了权限拒绝能正确终止整个 turn，而兄弟工具错误只影响当前批次。

---

## 4. discard() 和模型降级

当主模型过载、需要切换到备用模型时，已经在流式执行中的工具怎么办？

```typescript
// StreamingToolExecutor.ts:68-71
discard(): void {
  this.discarded = true
}
```

`discard()` 设置一个标记。之后：
1. 正在排队的工具不会开始执行
2. 正在执行的工具在下次检查 abort reason 时会发现 `discarded === true`
3. 所有未完成的工具会收到 `streaming_fallback` 合成错误消息

主循环（query.ts）在模型降级时调用 discard()，然后创建一个**新的** StreamingToolExecutor：

```typescript
// query.ts:913-918
streamingToolExecutor.discard()
streamingToolExecutor = new StreamingToolExecutor(
  toolUseContext.options.tools,
  canUseTool,
  toolUseContext,
)
```

这确保了新模型的工具执行不会和旧模型的残留结果混在一起。

---

## 5. 结果排序和进度流

### 5.1 getCompletedResults：同步收集

```typescript
// 收集已完成工具的结果（不等待）
*getCompletedResults() {
  for (const tool of this.tools) {
    // 先 yield 进度消息
    yield* tool.pendingProgress
    
    if (tool.status === 'completed') {
      yield* tool.results
      tool.status = 'yielded'
    } else {
      break  // 保证顺序
    }
  }
}
```

### 5.2 getRemainingResults：异步等待

```typescript
// 等待所有工具完成并收集结果
async *getRemainingResults() {
  while (hasUnfinishedTools()) {
    await Promise.race([
      ...toolPromises,           // 等任何一个工具完成
      progressAvailablePromise,  // 或者有新的进度消息
    ])
    // 收集并 yield 可用结果
    yield* getCompletedResults()
  }
}
```

`Promise.race` 的使用确保了**低延迟的进度反馈**——不需要等到所有工具都完成，任何一个工具有进度更新就能立即传递给 UI。

### 5.3 中断行为分类

```typescript
// StreamingToolExecutor.ts:233-241
private getToolInterruptBehavior(tool: TrackedTool): 'cancel' | 'block' {
  const definition = findToolByName(this.toolDefinitions, tool.block.name)
  if (!definition?.interruptBehavior) return 'block'  // 默认不可中断
  try {
    return definition.interruptBehavior()
  } catch {
    return 'block'  // 出错时保守处理
  }
}
```

每个工具可以声明自己的中断行为：
- `'block'`（默认）——不可中断，用户必须等它完成
- `'cancel'`——可以安全取消

当用户在工具执行期间输入新消息（`interrupt` 原因）时，只有 `cancel` 类工具会被停止。这防止了写文件操作被意外中断导致文件损坏。

---

## 6. 与传统方案的对比

| 特性 | 传统 agent 框架 | Claude Code |
|------|---------------|-------------|
| 工具执行时机 | API 响应完成后 | 流式传输中 |
| 并发控制 | 无/手动 | 自动（基于并发安全声明） |
| 错误传播 | 全局中止 | 选择性级联（Bash-only） |
| 进度反馈 | 轮询/回调 | 流式 yield |
| 中断处理 | 全部取消 | 分类取消（block/cancel） |
| 结果排序 | 执行顺序 | 声明顺序（保证配对） |

Claude Code 的流式处理不是简单的"把字一个一个显示出来"，而是一个完整的**并发执行框架**——它解决了流式系统中的排序、取消、错误传播、资源清理等核心问题。
