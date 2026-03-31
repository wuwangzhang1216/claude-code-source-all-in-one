# 07 - 上下文窗口管理深度分析：真正的工程深水区

---

## 1. 为什么需要四层压缩

一个简单的 AI 编程会话可能持续 4 小时。在这 4 小时里：

```
- 读取了 50 个文件（每个平均 200 行）= ~50,000 行
- 执行了 100 条 Bash 命令（每条平均 50 行输出）= ~5,000 行
- 模型生成了 200 条响应（每条平均 100 行）= ~20,000 行
```

粗略估算：**75,000 行文本 ≈ 300,000+ tokens**。

即使使用 200k 上下文窗口的模型，这也远超限制。更重要的是，越长的上下文 = 越慢的推理 + 越高的成本。

Claude Code 的解决方案不是一个通用的压缩算法，而是**四层递进式压缩**——每层解决不同粒度的问题，成本从零到高依次递增。

```
原始消息 ─→ Snip ─→ Microcompact ─→ Context Collapse ─→ AutoCompact ─→ API
              │          │                │                  │
           零成本     零API调用       延迟摘要          全量摘要
           移除整turn  精简tool_result  读时投影         独立API调用
```

---

## 2. 第一层：Snip — 零成本修剪

### 2.1 触发条件

`feature('HISTORY_SNIP')` 开启时自动运行。

### 2.2 移除规则

Snip 移除**整个 turn**——一对 assistant message + tool_result。判定"低价值"的规则：

```
低价值 turn =
  ├─ 工具调用返回空结果（grep 没找到、glob 没匹配）
  ├─ 工具调用被用户拒绝（tool_result 是 REJECT_MESSAGE）
  └─ 已经被 context collapse 覆盖的 turn
```

### 2.3 为什么是零成本

Snip 是纯本地操作——遍历消息数组，过滤掉符合条件的 turn。没有 API 调用，没有 LLM 生成摘要，就是一个 `Array.filter()`。

### 2.4 风险

Snip 可能移除了模型后续可能需要参考的信息。但实践中，空结果的 turn 确实几乎没有参考价值——"没找到"本身不包含有用信息。

---

## 3. 第二层：Microcompact — 缓存感知精简

### 3.1 目标

压缩 `tool_result` 的内容，但**保持消息结构不变**。

### 3.2 可压缩的工具

```typescript
// microCompact.ts
const COMPACTABLE_TOOLS = new Set([
  'Read',          // 文件内容
  'Bash',          // 命令输出
  'Grep',          // 搜索结果
  'Glob',          // 文件列表
  'WebSearch',     // 搜索结果
  'WebFetch',      // 网页内容
])
```

这些工具的输出通常很长（一个大文件可能 1000+ 行），但在后续对话中通常只需要一个摘要。

### 3.3 压缩策略

Microcompact 有两种策略：

**基于时间的清理**：
```typescript
// 超过一定时间的 tool_result 被替换为占位符
if (messageAge > threshold) {
  toolResult.content = TIME_BASED_MC_CLEARED_MESSAGE
  // "[This tool result has been cleared to save context space]"
}
```

**缓存感知压缩**：
```typescript
// 只压缩不在 prompt cache 中的消息
if (!isInPromptCache(message)) {
  compress(message)
}
```

### 3.4 与 Prompt Caching 的深度集成

这是 Microcompact 最巧妙的地方。Anthropic 的 prompt caching 是基于**消息前缀匹配**的——如果你修改了消息列表中靠前的消息，后面所有消息的缓存都失效。

Microcompact 知道这个规则，所以它：

1. **只压缩尾部消息**——靠前的消息可能在缓存中，压缩它们会导致大量缓存失效
2. **延迟发出 boundary message**——直到 API 响应后才能拿到真实的 `cache_deleted_input_tokens`
3. **计算压缩收益**——压缩节省的 token 必须大于缓存失效的代价

```
压缩决策 = 压缩节省的 token > 缓存失效损失的 token ?
  是 → 执行压缩
  否 → 保持原样（保住缓存更划算）
```

### 3.5 图片 Token 估算

Microcompact 也处理图片消息。图片的 token 估算使用固定上限：

```typescript
const IMAGE_MAX_TOKEN_SIZE = 2000  // 每张图片最多 2000 token
```

---

## 4. 第三层：Context Collapse — 读时投影

### 4.1 设计哲学

Context Collapse 是最创新的一层。它不修改原始消息，而是创建一个**虚拟视图**。

类比数据库：
- Snip/Microcompact = 直接修改行（UPDATE/DELETE）
- Context Collapse = 创建视图（CREATE VIEW）

### 4.2 工作原理

```
原始消息: [M1, M2, M3, M4, M5, M6, M7, M8, M9, M10]

Collapse 操作:
  "将 M3-M7 摘要为 S1"

Collapse Store:
  { range: [3,7], summary: S1 }

projectView() 的输出:
  [M1, M2, S1, M8, M9, M10]

原始消息不变！
```

### 4.3 读时投影：projectView()

每次循环迭代的入口，`projectView()` 回放 collapse 日志，生成压缩后的视图：

```typescript
// 每次迭代
const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
  messagesForQuery, toolUseContext, querySource,
)
messagesForQuery = collapseResult.messages
// 原始 messages 不变！这是 projection，不是 mutation。
```

### 4.4 为什么不直接修改

两个原因：

1. **跨 turn 持久化**——collapse 记录存在 store 里，重启 Claude Code 后依然有效。如果直接修改消息，重启后摘要就丢了（原始消息已被替换）。

2. **与 autocompact 解耦**——如果 collapse 已经把 token 数降到阈值以下，autocompact 就不需要运行，省了一次 API 调用。如果直接修改消息，就无法区分"已经 collapse 过"和"还需要 autocompact"。

### 4.5 Overflow 恢复

当 API 返回 413（prompt too long）时，Context Collapse 提供第一级恢复：

```typescript
// contextCollapse.recoverFromOverflow()
const drained = contextCollapse.recoverFromOverflow(messagesForQuery, querySource)
// 立即提交所有待提交的 collapse（释放更多空间）
// 如果之前有延迟提交的摘要，现在全部提交
```

"drain"（排空）这个比喻很形象——就像排空水管里积蓄的水，把所有待处理的 collapse 一次性提交。

---

## 5. 第四层：AutoCompact — 全量摘要

### 5.1 触发条件

```typescript
// autoCompact.ts:72-91
function getAutoCompactThreshold(): number {
  const effectiveContextWindow = getModelContextWindow()
  return effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS  // 减去 13,000 token 缓冲
}

// 当 token 用量超过阈值时触发
if (tokenCount > getAutoCompactThreshold()) {
  await autocompact()
}
```

### 5.2 压缩过程

AutoCompact 是最重量级的操作——它 fork 一个独立的 API 调用来生成摘要：

```
1. 移除图片（减少 token）
2. 移除重新注入的附件（skill_discovery 等）
3. 调用 LLM 生成整个会话的摘要
4. 恢复文件上下文（最多 5 个文件，50K token 预算）
5. 重新注入技能（每个技能最多 5K token）
6. 构建压缩后的消息数组
```

### 5.3 熔断器

```typescript
// 连续 3 次压缩失败后自动禁用
if (consecutiveFailures >= 3) {
  disableAutoCompact()
  logEvent('tengu_autocompact_circuit_breaker')
}
```

为什么需要熔断器？因为压缩失败通常意味着系统性问题（API 不可用、prompt 太长连摘要都生成不了）。继续重试只会浪费 token 和时间。

### 5.4 Token 预算跨压缩传递

```typescript
// query.ts:282-291
let taskBudgetRemaining: number | undefined = undefined

// 压缩前记录
const preCompactContext = finalContextTokensFromLastResponse(messagesForQuery)
taskBudgetRemaining = Math.max(
  0,
  (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
)
```

这确保了 token 预算在压缩前后的**连续性**——压缩后的摘要消息不包含完整历史，所以服务端无法准确计算已用预算。客户端通过 `taskBudgetRemaining` 传递这个信息。

### 5.5 compact_boundary 消息

```typescript
// 压缩完成后产出边界消息
yield createSystemMessage('compact_boundary', {
  preCompactTokenCount: result.preCompactTokenCount,
  postCompactTokenCount: result.postCompactTokenCount,
})
```

这个边界消息让 SDK 消费者知道"这里发生了上下文压缩"。UI 可以据此显示一个分隔线。

---

## 6. 三级错误恢复瀑布

### 6.1 prompt_too_long (413) 恢复

```
API 返回 413
  │
  ├─ 第一级: Context Collapse drain
  │  ├─ 条件: CONTEXT_COLLAPSE feature 开启
  │  │       且上一次 transition 不是 collapse_drain_retry
  │  ├─ 操作: recoverFromOverflow() 提交所有待提交的 collapse
  │  └─ 结果:
  │      ├─ committed > 0 → continue（重试 API 调用）
  │      └─ committed = 0 → 进入第二级
  │
  ├─ 第二级: Reactive Compact
  │  ├─ 条件: REACTIVE_COMPACT feature 开启
  │  │       且 hasAttemptedReactiveCompact === false
  │  ├─ 操作: tryReactiveCompact() 紧急全量压缩
  │  └─ 结果:
  │      ├─ 压缩成功 → continue（用压缩后的消息重试）
  │      └─ 压缩失败 → 进入第三级
  │
  └─ 第三级: 放弃
     └─ yield 错误消息给用户
     └─ return { reason: 'prompt_too_long' }
```

### 6.2 为什么 collapse drain 优先

Collapse drain 比 reactive compact 便宜得多：
- Collapse drain：零 API 调用，只是提交已有的摘要
- Reactive compact：一次完整的 API 调用生成新摘要

先尝试便宜的方案，不够再用昂贵的。

### 6.3 max_output_tokens 恢复

```
模型输出被截断
  │
  ├─ 第一级: 升级 Token 上限
  │  ├─ 条件: 当前使用默认 8k 上限
  │  │       且 tengu_otk_slot_v1 feature 开启
  │  ├─ 操作: 设 maxOutputTokensOverride = 64k
  │  └─ 重试同一个请求（不注入任何消息）
  │
  └─ 第二级: 注入续写提示
     ├─ 条件: maxOutputTokensRecoveryCount < 3
     ├─ 操作: 注入 meta message
     │   "Output token limit hit. Resume directly —
     │    no apology, no recap of what you were doing.
     │    Pick up mid-thought if that is where the cut happened.
     │    Break remaining work into smaller pieces."
     └─ 重试（最多 3 次）
```

### 6.4 续写提示的措辞分析

```
"no apology, no recap"
```

为什么要特别说"不要道歉，不要复述"？

因为 LLM 被截断后的**默认行为**就是道歉然后复述之前说的——"对不起，我之前在说到……让我继续"。这会浪费大量 token，而且用户已经看到了之前的输出，不需要复述。

```
"Pick up mid-thought if that is where the cut happened"
```

这告诉模型可以从**句子中间**继续——不需要重新开始一个完整的句子。这最大化了续写的效率。

```
"Break remaining work into smaller pieces"
```

这是一个**策略调整指令**——告诉模型之后的输出要短一些，避免再次被截断。

**一条 meta prompt 就解决了三个问题：避免浪费、保持连贯、预防再犯。**

### 6.5 媒体大小错误恢复

除了 413，还有一种特殊的 prompt_too_long：图片/PDF 太大。

```typescript
const isWithheldMedia = mediaRecoveryEnabled &&
  reactiveCompact?.isWithheldMediaSizeError(lastMessage)
```

媒体错误**跳过 collapse drain**（collapse 不处理图片），直接进入 reactive compact。Reactive compact 的 strip-retry 会移除超大媒体后重试。

如果移除后仍然太大（超大媒体在"保留尾部"中），`hasAttemptedReactiveCompact` 防止无限循环。

---

## 7. 四层之间的协作

### 7.1 执行顺序

```typescript
// query.ts 每次循环迭代
let messagesForQuery = messages

// Layer 1: Snip
messagesForQuery = snip(messagesForQuery)

// Layer 2: Microcompact  
messagesForQuery = microcompact(messagesForQuery)

// Layer 3: Context Collapse
messagesForQuery = contextCollapse.projectView(messagesForQuery)

// Layer 4: AutoCompact（条件触发）
if (tokenCount > threshold) {
  messagesForQuery = autocompact(messagesForQuery)
}

// 发给 API
callModel(messagesForQuery)
```

### 7.2 互补关系

| 层 | 粒度 | 成本 | 保真度 |
|----|------|------|--------|
| Snip | 整个 turn | 零 | 低（整个 turn 消失） |
| Microcompact | tool_result 内容 | 零 | 中（结构保留） |
| Context Collapse | 多个 turn 的范围 | 低 | 中高（LLM 摘要） |
| AutoCompact | 整个会话 | 高 | 最高（完整摘要） |

四层的设计确保了：**能用便宜方法解决的，就不用昂贵方法。**

---

## 8. 总结

上下文窗口管理是 Claude Code 中**最复杂、最关键、也最不被外界注意**的系统。

它不会出现在产品发布会的 demo 中——5 分钟的演示不会触发任何一层压缩。但对于真实用户——那些使用 Claude Code 4 小时完成一个大型重构的工程师——这套系统是他们能够持续工作的基础。

四层递进压缩、三级错误恢复、缓存感知的压缩决策——这些"不性感但必要"的工程，是区分 demo 和产品的分水岭。
