# 02 - 主循环深度分析：Agent 的心脏

---

## 1. State 类型：每个字段的故事

```typescript
// query.ts:204-217
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
}
```

### 1.1 messages: Message[]

整个对话历史。每次 continue 时，这个数组会被**完整替换**（不是 push）：

```typescript
state = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  // ...
}
```

为什么是替换而不是 push？因为 `messagesForQuery` 可能已经经过了压缩（snip、microcompact、context collapse），和原始的 `state.messages` 不同。如果用 push，你需要先把压缩后的消息替换回去，逻辑会更复杂。

### 1.2 toolUseContext: ToolUseContext

工具执行的共享上下文。包含：
- `options.tools`——可用工具列表
- `options.mainLoopModel`——当前使用的模型（可能在 fallback 时被替换）
- `abortController`——取消信号
- `setInProgressToolUseIDs`——追踪正在执行的工具
- 文件缓存、会话状态等

注意这是 State 中**唯一在迭代内会被修改**的字段——其他字段只在 continue site 被整体替换。

### 1.3 autoCompactTracking: AutoCompactTrackingState | undefined

追踪自动压缩的状态。包含上一次 API 调用的 token 用量，用于判断是否需要触发 autocompact。

`undefined` 表示"还没有追踪数据"——第一次迭代时必然是 undefined。

### 1.4 maxOutputTokensRecoveryCount: number

当模型输出被截断时（max_output_tokens），Claude Code 会注入续写提示重试。这个计数器记录已经重试了多少次，上限是 3 次（`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT`）。

### 1.5 hasAttemptedReactiveCompact: boolean

**单次触发保护**。reactive compact 是一个昂贵的操作（需要额外的 API 调用来生成摘要）。如果第一次 compact 后仍然 413，说明问题不在于上下文太长，再 compact 一次也没用。这个布尔值防止了无限 compact 循环。

这个字段在 stop hook blocking 的 continue site 中被**特别保留**（不重置为 false），因为团队曾经遇到过一个 bug：

```typescript
// 注释来自源码（line 1293-1296）：
// Preserve the reactive compact guard — if compact already ran and
// couldn't recover from prompt-too-long, retrying after a stop-hook
// blocking error will produce the same result. Resetting to false
// here caused an infinite loop: compact → still too long → error →
// stop hook blocking → compact → … burning thousands of API calls.
```

**这条注释记录了一次真实的生产事故。** 重置这个布尔值导致了一个无限循环，烧掉了大量 API 调用。

### 1.6 maxOutputTokensOverride: number | undefined

当触发 max_output_tokens 升级时（8k → 64k），这个字段被设为 `ESCALATED_MAX_TOKENS`。升级是**单次的**——如果 64k 也不够，就走多轮恢复路径。

### 1.7 pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined

这是一个巧妙的异步优化。工具调用的摘要由 Haiku 模型生成（~1秒），但主循环不会等它——摘要在**下一次迭代开始时**被 await：

```typescript
// 上一轮的摘要在这里被消费
if (pendingToolUseSummary) {
  const summary = await pendingToolUseSummary
  if (summary) yield summary
}

// 本轮的摘要在这里被启动（异步）
state = {
  pendingToolUseSummary: generateToolUseSummary(assistantMessages),
  // ...
}
```

这意味着摘要生成和模型调用是**重叠的**——当主模型在处理下一轮时，Haiku 正在生成上一轮的摘要。

### 1.8 stopHookActive: boolean | undefined

当 stop hook 返回 blocking errors 时，这个字段被设为 `true`，防止同一个 hook 被重复执行。

### 1.9 turnCount: number

循环迭代次数。用于 `maxTurns` 限制——当 `turnCount` 超过 `maxTurns` 时，循环强制终止。

### 1.10 transition: Continue | undefined

**最精妙的字段**。它是一个带标签的联合类型：

```typescript
type Continue =
  | { reason: 'collapse_drain_retry'; committed: number }
  | { reason: 'reactive_compact_retry' }
  | { reason: 'max_output_tokens_escalate' }
  | { reason: 'max_output_tokens_recovery'; attempt: number }
  | { reason: 'stop_hook_blocking' }
  | { reason: 'token_budget_continuation' }
  | { reason: 'next_turn' }
```

它有三个用途：

1. **循环保护**——`state.transition?.reason !== 'collapse_drain_retry'` 防止重复排空
2. **测试断言**——测试可以检查 `transition.reason` 来验证走了哪条恢复路径
3. **元数据传递**——某些 continue 原因携带额外信息（如 `committed` 计数）

---

## 2. 七个 Continue Site 完整分析

### Site 1: 模型降级 (Line 950)

```typescript
// 触发条件: FallbackTriggeredError
catch (error) {
  if (error instanceof FallbackTriggeredError) {
    // 1. 发送 tombstone 消息，撤回已流式输出的内容
    yield* yieldTombstoneMessages(assistantMessages)
    
    // 2. 清空中间状态
    assistantMessages.length = 0
    toolResults.length = 0
    
    // 3. 丢弃 StreamingToolExecutor 的待处理结果
    streamingToolExecutor.discard()
    
    // 4. 切换模型
    toolUseContext.options.mainLoopModel = fallbackModel
    
    // 5. 清理 thinking 签名（fallback 模型可能不支持）
    messagesForQuery = stripSignatureBlocks(messagesForQuery)
    
    // 6. 通知用户
    yield createSystemMessage('Switched to fallback model...')
    
    continue  // 用原始 messagesForQuery 重试
  }
}
```

**这是唯一一个不创建新 State 对象的 continue site。** 因为模型降级是在 API 调用的 catch 块中发生的，此时 state 还没有被修改。直接 continue 会用现有的 state 回到循环顶部，然后用新模型重试。

**Tombstone 处理**是这里的难点——已经 yield 出去的消息不能"收回"，只能通过 tombstone 告诉 UI "忘掉这些消息"。

### Site 2: Context Collapse 排空 (Line 1115)

```typescript
if (feature('CONTEXT_COLLAPSE') && contextCollapse &&
    state.transition?.reason !== 'collapse_drain_retry') {
  const drained = contextCollapse.recoverFromOverflow(messagesForQuery, querySource)
  if (drained.committed > 0) {
    state = {
      messages: drained.messages,
      // ...
      transition: { reason: 'collapse_drain_retry', committed: drained.committed },
    }
    continue
  }
}
```

关键保护：`state.transition?.reason !== 'collapse_drain_retry'`——如果上一轮已经排空过了，不再尝试。这防止了"排空 → 仍然 413 → 再排空 → ..."的无限循环。

### Site 3: 反应式压缩 (Line 1165)

```typescript
const compacted = await reactiveCompact.tryReactiveCompact({
  hasAttempted: hasAttemptedReactiveCompact,
  messages: messagesForQuery,
  // ...
})
if (compacted) {
  const postCompactMessages = buildPostCompactMessages(compacted)
  state = {
    messages: postCompactMessages,
    hasAttemptedReactiveCompact: true,  // 单次触发保护
    autoCompactTracking: undefined,     // 压缩后重新开始追踪
    // ...
  }
  continue
}
```

注意 `autoCompactTracking: undefined`——压缩后 token 数量发生了巨大变化，之前的追踪数据不再有意义。

### Site 4: Max Output Tokens 升级 (Line 1220)

```typescript
if (capEnabled && maxOutputTokensOverride === undefined &&
    !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
  state = {
    messages: messagesForQuery,  // 用同样的输入重试
    maxOutputTokensOverride: ESCALATED_MAX_TOKENS,  // 8k → 64k
    transition: { reason: 'max_output_tokens_escalate' },
    // ...
  }
  continue
}
```

**静默升级**——没有注入任何 meta message，用户看不到任何变化。只是把输出上限从 8k 提高到 64k，然后用**完全相同的输入**重试。

### Site 5: Max Output Tokens 恢复 (Line 1251)

```typescript
const recoveryMessage = createUserMessage({
  content: 'Output token limit hit. Resume directly — no apology, ' +
           'no recap of what you were doing. Pick up mid-thought...',
  isMeta: true,
})

state = {
  messages: [...messagesForQuery, ...assistantMessages, recoveryMessage],
  maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
  transition: { reason: 'max_output_tokens_recovery', attempt: count + 1 },
  // ...
}
continue
```

注意 `...assistantMessages` 被保留了——被截断的响应仍然在消息历史中。模型会看到自己的半截响应加上 recovery message，从而知道从哪里继续。

`isMeta: true` 标记这条消息为"系统元消息"，UI 通常不会直接展示给用户。

### Site 6: Stop Hook 阻断 (Line 1305)

```typescript
if (stopHookResult.blockingErrors.length > 0) {
  state = {
    messages: [...messagesForQuery, ...assistantMessages, ...blockingErrors],
    stopHookActive: true,                     // 防止 hook 重复执行
    hasAttemptedReactiveCompact,              // 保留！不重置！
    maxOutputTokensRecoveryCount: 0,          // 重置
    // ...
  }
  continue
}
```

**`hasAttemptedReactiveCompact` 被保留**而 `maxOutputTokensRecoveryCount` 被重置——这两个看似矛盾的决策背后有不同的原因：

- `hasAttemptedReactiveCompact` 保留：防止 compact 无限循环（上面的生产事故）
- `maxOutputTokensRecoveryCount` 重置：hook 错误后模型会产生新的响应，新响应有权获得完整的 3 次恢复机会

### Site 7: Token 预算续行 (Line 1340)

```typescript
if (decision.action === 'continue') {
  state = {
    messages: [...messagesForQuery, ...assistantMessages,
               createUserMessage({ content: decision.nudgeMessage, isMeta: true })],
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,   // 重置！
    transition: { reason: 'token_budget_continuation' },
    // ...
  }
  continue
}
```

这是唯一一个**同时重置** `hasAttemptedReactiveCompact` 和 `maxOutputTokensRecoveryCount` 的 continue site。原因是：token budget continuation 是一种"正常的继续"——模型成功完成了当前工作，只是预算允许它做更多。这时候所有恢复机制都应该被重置，因为接下来是一轮全新的交互。

---

## 3. 循环入口：不可变配置快照

```typescript
// query.ts:293-295
const config = buildQueryConfig()
```

`buildQueryConfig()` 在循环入口**一次性快照**所有不可变的环境配置：
- Statsig feature flags
- 环境变量
- 会话配置

为什么要快照而不是每次迭代重新读取？

1. **一致性**——整个循环执行期间看到相同的配置，避免中途配置变更导致的不一致行为
2. **性能**——feature flag 检查可能涉及网络请求或磁盘 I/O，只做一次
3. **可调试性**——可以在日志中记录整个 config 对象，知道这个 turn 用了什么配置

注意源码中有一条注释特别说明了为什么 `feature()` 调用被**排除**在 config 之外——因为 `feature()` 是编译时常量（通过 Bun bundler 做死代码消除），不需要运行时快照。

---

## 4. taskBudgetRemaining：跨压缩边界的预算追踪

```typescript
// query.ts:282-291
let taskBudgetRemaining: number | undefined = undefined
```

这个变量在**循环外**声明，而不是放在 State 里。源码注释解释了原因：

> "Loop-local (not on State) to avoid touching the 7 continue sites."

如果放在 State 里，每个 continue site 都需要传递这个值。但实际上只有在 compact 发生时才需要更新它——在大多数 continue site 中，它是不变的。

把它放在循环外，让它成为一个**跨迭代的闭包变量**，只在 compact 逻辑中被修改，其他地方自动继承上一次的值。这是一个工程上的务实选择——减少 7 个 continue site 的代码量，换来稍微不那么"纯"的状态管理。

---

## 5. Memory Prefetch：RAII 风格的资源管理

```typescript
// query.ts:301-304
using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
  state.messages,
  state.toolUseContext,
)
```

`using` 关键字（TC39 Stage 3 提案，TypeScript 5.2+）实现了 **RAII（Resource Acquisition Is Initialization）** 模式：

1. **进入循环**时启动 memory prefetch（异步查询相关记忆）
2. **退出循环**时自动 dispose（无论是正常 return、throw、还是 generator 被 .return()）

`startRelevantMemoryPrefetch` 只在**第一次迭代**启动查询——prompt 在各迭代间不变，重复查询没有意义。后续迭代通过 `settledAt` 检查直接使用已缓存的结果。

---

## 6. 总结：主循环的设计哲学

Claude Code 的主循环体现了几个关键设计原则：

1. **整体替换 > 逐字段修改**——TypeScript 类型系统确保不遗漏
2. **单次触发保护**——布尔标记防止无限循环
3. **注释记录事故**——源码注释是团队知识的载体
4. **务实的状态管理**——该放在 State 里的放 State，该放闭包的放闭包
5. **异步重叠**——摘要生成和模型调用并行，memory prefetch 和循环并行

这不是一个"优雅"的循环——它有 1488 行，7 个 continue site，10 个 State 字段。但它是一个**正确**的循环——每个字段、每个 continue、每条注释都有其存在的工程理由。
