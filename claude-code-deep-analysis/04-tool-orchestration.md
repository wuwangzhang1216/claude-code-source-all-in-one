# 04 - 工具编排深度分析：为什么不用 DAG

---

## 1. partitionToolCalls：贪心分区算法

### 1.1 算法核心

```typescript
// toolOrchestration.ts:91-116
function partitionToolCalls(
  toolUseMessages: ToolUseBlock[],
  toolUseContext: ToolUseContext,
): Batch[] {
  return toolUseMessages.reduce((acc: Batch[], toolUse) => {
    const tool = findToolByName(toolUseContext.options.tools, toolUse.name)
    const parsedInput = tool?.inputSchema.safeParse(toolUse.input)
    const isConcurrencySafe = parsedInput?.success
      ? (() => {
          try {
            return Boolean(tool?.isConcurrencySafe(parsedInput.data))
          } catch {
            return false  // 保守策略
          }
        })()
      : false
    if (isConcurrencySafe && acc[acc.length - 1]?.isConcurrencySafe) {
      acc[acc.length - 1]!.blocks.push(toolUse)  // 追加到当前并发批次
    } else {
      acc.push({ isConcurrencySafe, blocks: [toolUse] })  // 新建批次
    }
    return acc
  }, [])
}
```

### 1.2 算法分析

这是一个**单遍贪心**算法，时间复杂度 O(n)：

1. 从左到右扫描工具调用列表
2. 如果当前工具是并发安全的，且上一个批次也是并发安全的 → 合并
3. 否则 → 新建批次

**示例**：

```
输入: [Read, Read, Grep, Bash, Read, Write, Read, Read]

扫描过程:
  Read   → 并发安全, 新建 batch [Read]
  Read   → 并发安全, 合并到 batch [Read, Read]
  Grep   → 并发安全, 合并到 batch [Read, Read, Grep]
  Bash   → 不安全, 新建 batch [Bash]
  Read   → 并发安全, 新建 batch [Read]
  Write  → 不安全, 新建 batch [Write]
  Read   → 并发安全, 新建 batch [Read]
  Read   → 并发安全, 合并到 batch [Read, Read]

结果: 
  [Read, Read, Grep] → 并发批次
  [Bash]             → 串行批次
  [Read]             → 并发批次
  [Write]            → 串行批次
  [Read, Read]       → 并发批次
```

### 1.3 并发安全判定

`isConcurrencySafe` 的判定有三层防御：

```
1. inputSchema.safeParse(input) 成功？
   → 否：视为不安全（无法解析输入，保守处理）
2. tool.isConcurrencySafe(parsedInput) 不抛异常？
   → 否：视为不安全（如 shell-quote 解析失败）
3. 返回值为 truthy？
   → 否：视为不安全
```

**为什么 shell-quote 解析失败会导致不安全？**

Bash 工具的 `isConcurrencySafe` 需要解析命令来判断它是否是只读的（比如 `ls` 是安全的，`rm` 不是）。如果命令包含特殊字符导致 shell-quote 库解析失败，Claude Code 选择**保守处理**——视为不安全，串行执行。

这是安全优先的设计：宁可慢一点（串行），也不能让两个有副作用的命令并行执行导致竞态。

### 1.4 为什么不做更智能的分区

一个自然的问题是：为什么不做依赖分析？比如 `Read("a.ts")` 和 `Write("b.ts")` 理论上可以并行，因为它们操作不同的文件。

Claude Code 选择不这样做，原因有两个：

1. **模型已经做了决策**——如果模型在一次响应中输出了 `[Read, Read, Write]`，它已经隐含了"这个 Write 不依赖于这两个 Read"的判断。而如果 Write 依赖 Read 的结果，模型会在 Read 完成后的下一轮才输出 Write。

2. **框架层的依赖分析不可靠**——`Write("b.ts")` 看起来和 `Read("a.ts")` 无关，但如果 b.ts import 了 a.ts，修改 b.ts 可能影响对 a.ts 的理解。这种语义依赖在框架层无法可靠检测。

---

## 2. 执行引擎：并发 vs 串行

### 2.1 runTools 主控

```typescript
// toolOrchestration.ts:19-82
export async function* runTools(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext
  for (const { isConcurrencySafe, blocks } of partitionToolCalls(...)) {
    if (isConcurrencySafe) {
      // 并发路径
      yield* runConcurrentBatch(blocks, currentContext)
    } else {
      // 串行路径
      yield* runSerialBatch(blocks, currentContext)
    }
  }
}
```

**每个批次顺序执行**，批次内部根据类型选择并发或串行。这确保了跨批次的**执行顺序**和模型输出的顺序一致。

### 2.2 并发执行路径

```typescript
// toolOrchestration.ts:152-177
async function* runToolsConcurrently(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdateLazy, void> {
  yield* all(
    toolUseMessages.map(async function* (toolUse) {
      yield* runToolUse(toolUse, assistantMessage, canUseTool, toolUseContext)
      markToolUseAsComplete(toolUseContext, toolUse.id)
    }),
    getMaxToolUseConcurrency(),  // 默认 10
  )
}
```

`all()` 是一个自定义的 async generator 合并函数（来自 `utils/generators.ts`）。它接受多个 async generator，以最大并发度运行它们，并**按完成顺序**输出结果。

**最大并发度 10** 通过环境变量 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 可配置：

```typescript
// toolOrchestration.ts:8-11
function getMaxToolUseConcurrency(): number {
  return parseInt(process.env.CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY || '', 10) || 10
}
```

### 2.3 串行执行路径

```typescript
// toolOrchestration.ts:118-150
async function* runToolsSerially(
  toolUseMessages: ToolUseBlock[],
  assistantMessages: AssistantMessage[],
  canUseTool: CanUseToolFn,
  toolUseContext: ToolUseContext,
): AsyncGenerator<MessageUpdate, void> {
  let currentContext = toolUseContext

  for (const toolUse of toolUseMessages) {
    for await (const update of runToolUse(toolUse, ...)) {
      if (update.contextModifier) {
        currentContext = update.contextModifier.modifyContext(currentContext)  // 立即应用
      }
      yield { message: update.message, newContext: currentContext }
    }
    markToolUseAsComplete(toolUseContext, toolUse.id)
  }
}
```

**关键区别**：串行路径中，上下文修改器是**立即应用**的——每个工具的修改对下一个工具**立即可见**。

---

## 3. 延迟上下文修改器：并发安全的核心

### 3.1 问题

工具执行时可能需要修改共享的 `ToolUseContext`。比如 Read 工具读取文件后，需要更新文件缓存。

在串行执行中，这很简单——每个工具修改后，下一个工具看到最新状态。

但在并发执行中，如果三个 Read 工具同时修改文件缓存，会产生**竞态条件**——最后一个写入的覆盖前两个。

### 3.2 解决方案：收集-应用模式

```typescript
// toolOrchestration.ts:30-62
// 并发执行期间
const queuedContextModifiers: Record<string, ((ctx) => ToolUseContext)[]> = {}

for await (const update of runToolsConcurrently(blocks, ...)) {
  if (update.contextModifier) {
    const { toolUseID, modifyContext } = update.contextModifier
    queuedContextModifiers[toolUseID] ??= []
    queuedContextModifiers[toolUseID].push(modifyContext)
  }
  yield { message: update.message, newContext: currentContext }  // 旧 context
}

// 并发批次结束后，按工具声明顺序应用
for (const block of blocks) {
  const modifiers = queuedContextModifiers[block.id]
  if (!modifiers) continue
  for (const modifier of modifiers) {
    currentContext = modifier(currentContext)
  }
}
```

这个模式的三个关键点：

1. **收集阶段**（并发执行中）：只记录修改器函数，不执行
2. **应用阶段**（并发执行后）：按**工具声明顺序**依次应用
3. **确定性**：无论工具以什么顺序完成，应用顺序始终确定

### 3.3 为什么按声明顺序

按声明顺序（而非完成顺序）应用修改器，确保了**确定性**——相同的输入总是产生相同的输出。

考虑这个场景：Read_1 和 Read_2 并发执行，Read_1 先完成，Read_2 后完成。如果按完成顺序应用：

```
场景 A（Read_1 先完成）: ctx → modifier_1(ctx) → modifier_2(result)
场景 B（Read_2 先完成）: ctx → modifier_2(ctx) → modifier_1(result)
```

不同的网络延迟可能导致不同的执行结果。而按声明顺序：

```
始终: ctx → modifier_1(ctx) → modifier_2(result)
```

这在实践中可能影响不大（文件缓存的修改通常是独立的），但**确定性是正确性的基础**。

---

## 4. 工具执行的细节：toolExecution.ts

### 4.1 runToolUse 的执行流

`runToolUse`（toolExecution.ts，1745 行）是单个工具的执行入口：

```
runToolUse(toolUse, assistantMessage, canUseTool, context)
  │
  ├─ 1. findToolByName → 查找工具定义
  ├─ 2. inputSchema.safeParse → 验证输入
  ├─ 3. canUseTool → 权限检查
  │     ├─ allow → 继续
  │     ├─ deny → 生成拒绝 tool_result
  │     └─ ask → 弹窗确认
  ├─ 4. tool.fn(input, context) → 实际执行
  │     ├─ yield ProgressMessage → 实时进度
  │     └─ return result
  └─ 5. 构建 tool_result message
        ├─ contextModifier（如有）
        └─ yield MessageUpdate
```

### 4.2 backfillObservableInput

工具执行后，Claude Code 可能需要在 tool_use 的 input 中补充**可观测字段**——让 UI 能显示更有用的信息：

```typescript
if (tool.backfillObservableInput) {
  const inputCopy = { ...block.input }
  tool.backfillObservableInput(inputCopy)
  
  if (hasNewFields) {
    // 克隆消息，不修改原始对象
    clonedContent[i] = { ...block, input: inputCopy }
  }
}
```

比如 Bash 工具可能在执行后补充 `exitCode` 字段，让 UI 显示命令的退出码。

**重要**：这里只**添加新字段**，不修改已有字段——避免破坏 prompt caching 的字节匹配。

### 4.3 工具进度追踪

```typescript
// 标记工具开始执行
toolUseContext.setInProgressToolUseIDs(prev => new Set(prev).add(toolUse.id))

// 工具执行完成后
markToolUseAsComplete(toolUseContext, toolUse.id)
```

`setInProgressToolUseIDs` 使用**函数式更新**（传入一个函数而非新值），确保在并发场景下的正确性——类似 React 的 `setState(prev => ...)`。

---

## 5. 与其他编排方案的对比

### 5.1 OpenAI Function Calling

OpenAI 的 parallel_tool_calls 允许模型同时输出多个工具调用，但**没有提供编排层**——客户端需要自己决定如何执行这些工具。

Claude Code 的 `partitionToolCalls` + `runTools` 就是 Anthropic 的答案：一个客户端编排层，自动处理并发/串行分区。

### 5.2 LangChain ToolExecutor

LangChain 的 ToolExecutor 是串行的——每个工具依次执行。没有并发批次的概念。

### 5.3 CrewAI Task Orchestration

CrewAI 需要用户手动定义 task 之间的依赖关系。Claude Code 的方法是**零配置**——并发安全性声明在工具定义上，框架自动编排。

---

## 6. 总结

Claude Code 的工具编排遵循一个核心原则：

> **框架负责安全约束，模型负责决策逻辑。**

- 框架知道哪些工具是只读的（并发安全）
- 框架确保有副作用的工具不会并发
- 框架确保上下文修改的确定性
- 模型决定调哪些工具、传什么参数、以什么顺序

这种分工让框架代码保持简单（188 行），同时给了模型最大的灵活性。相比需要手动画 DAG 或定义依赖关系的框架，这是一个更优雅的解决方案。
