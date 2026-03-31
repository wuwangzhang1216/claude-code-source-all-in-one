# 09 - 不可变 API 消息深度分析：Prompt Caching 的隐藏代价

---

## 1. Prompt Caching 机制详解

### 1.1 什么是 Prompt Caching

Anthropic 的 prompt caching 允许重复使用之前 API 调用中的 input token。机制类似 HTTP 缓存：

```
API 调用 1: [System Prompt] [Message 1] [Message 2]
                    └─────── 全部计算 ─────────┘
                    
API 调用 2: [System Prompt] [Message 1] [Message 2] [Message 3]
                    └─── 缓存命中 ──────┘  └─ 新增 ─┘
                    
API 调用 3: [System Prompt] [Message 1*] [Message 2] [Message 3]
                    └ 命中 ┘ └───── 全部重新计算 ──────────┘
```

**关键规则：缓存匹配是基于字节的前缀匹配。** 一旦消息列表中某个位置的字节发生变化，该位置之后的所有消息都需要重新计算。

### 1.2 三种 Token 类型

| Token 类型 | 含义 | 价格 |
|-----------|------|------|
| `input_tokens` | 未缓存的 input token | 标准价格 |
| `cache_creation_input_tokens` | 首次缓存的 token | 标准价格 × 1.25 |
| `cache_read_input_tokens` | 命中缓存的 token | 标准价格 × 0.1 |

**缓存读取只要标准价格的 10%**。对于一个 100k token 的会话，每轮缓存命中可以省下 90% 的 input 成本。

### 1.3 成本量化

假设一个 4 小时会话：
- 每轮平均 input: 100,000 tokens
- 共 200 轮
- 标准 input 价格: $3/M tokens

**无缓存**:
```
200 轮 × 100,000 tokens × $3/M = $60
```

**有缓存（90% 命中率）**:
```
200 轮 × 10,000 新 tokens × $3/M +
200 轮 × 90,000 缓存 tokens × $0.3/M = $6 + $5.4 = $11.4
```

**节省约 80%**。这就是 prompt caching 的经济意义。

---

## 2. 不可变约束的实现

### 2.1 核心原则

> **API 返回的 AssistantMessage 对象，永远不被修改。**

因为 `assistantMessages` 数组中的消息最终会被放回 `messages` 列表，发给下一轮 API。如果你修改了任何一条消息的任何一个字节，**从该消息开始的所有后续缓存都会失效**。

### 2.2 clone-before-modify 模式

当需要修改消息（比如补充 observable 字段）时：

```typescript
// query.ts 中的 backfillObservableInput 处理
let yieldMessage = message  // 默认直接 yield 原始消息

if (message.type === 'assistant') {
  let clonedContent = undefined

  for (const block of message.message.content) {
    if (block.type === 'tool_use' && tool?.backfillObservableInput) {
      const inputCopy = { ...block.input }
      tool.backfillObservableInput(inputCopy)

      // 关键：只有添加了新字段才克隆
      if (hasNewFields) {
        clonedContent ??= [...message.message.content]
        clonedContent[i] = { ...block, input: inputCopy }
      }
    }
  }

  if (clonedContent) {
    yieldMessage = {
      ...message,
      message: { ...message.message, content: clonedContent }
    }
  }
}

yield yieldMessage  // yield 克隆版本给 UI
// 但 assistantMessages 中的原始 message 不变！
```

### 2.3 惰性克隆

注意 `clonedContent ??= [...]` 的写法——只有在**确定需要修改**时才克隆。这是一个**惰性优化**：

```
场景 A: 工具没有 backfillObservableInput
  → 零克隆，零分配

场景 B: 工具有 backfillObservableInput，但没有新字段
  → 零克隆（inputCopy 被丢弃）

场景 C: 工具有 backfillObservableInput，且有新字段
  → 克隆 content 数组和被修改的 block
```

大多数情况是 A 或 B——不需要克隆。只有 C 需要分配新内存。

### 2.4 结构共享

克隆使用了**结构共享**（structural sharing）：

```typescript
yieldMessage = {
  ...message,                              // 共享 uuid, type 等
  message: {
    ...message.message,                    // 共享 usage 等
    content: clonedContent                 // 新的 content 数组
  }
}
```

只有 `content` 字段是新分配的，其他字段通过展开运算符共享引用。这最大化了内存效率。

---

## 3. messagesForQuery vs messages 的区分

### 3.1 两条消息管线

主循环中维护了两条消息管线：

```
messages (State.messages)
  │
  ├─ 经过四层压缩
  │
  └→ messagesForQuery (局部变量)
       │
       ├─ 发给 API
       │
       └→ assistantMessages (API 返回)
            │
            ├─ yield 给 UI（可能克隆后）
            │
            └→ 放回 messages 的下一轮
```

**`messages`**：原始的、完整的消息历史。跨迭代持久化。
**`messagesForQuery`**：经过压缩的消息。每次迭代重新生成。不回写到 `messages`。

### 3.2 为什么分开

如果只有一条管线（压缩直接修改 messages），会导致：
1. 压缩是不可逆的——一旦压缩了，原始信息就丢失了
2. 下一次迭代可能需要不同的压缩策略（比如上一次 snip 了某个 turn，这次不需要）
3. Snip/Microcompact 的结果不应该持久化——它们是"视图"，不是"事实"

---

## 4. 缓存命中追踪

### 4.1 追踪指标

Claude Code 追踪每次 API 调用的缓存命中情况：

```typescript
// 累计追踪
getTotalCacheCreationInputTokens()  // 总缓存创建 token
getTotalCacheReadInputTokens()      // 总缓存命中 token
getTotalInputTokens()               // 总 input token
```

### 4.2 缓存断裂检测

```typescript
// promptCacheBreakDetection.ts
function detectCacheBreak(
  previousMessages: Message[],
  currentMessages: Message[],
): CacheBreakInfo | null {
  // 逐消息对比，找到第一个不同的位置
  // 如果发现断裂，记录原因和位置
}
```

缓存断裂检测帮助工程师诊断：
- 哪些操作导致了缓存失效
- 失效的范围有多大
- 是否可以优化来避免失效

### 4.3 缓存断裂的常见原因

| 原因 | 影响 | 可避免？ |
|------|------|---------|
| Microcompact 压缩了旧消息 | 该消息之后全部失效 | 是（权衡收益） |
| 消息被修改（如 backfill） | 该消息之后全部失效 | 是（clone-before-modify） |
| AutoCompact 重写了历史 | 全部失效（新前缀） | 否（但减少了总 token） |
| 用户编辑了消息 | 该消息之后全部失效 | 否（用户行为） |

---

## 5. 不可变性在代码库中的体现

### 5.1 消息创建

所有消息通过工厂函数创建，创建后不再修改：

```typescript
// 工厂函数创建
const msg = createUserMessage({ content: '...' })
// msg.uuid 在创建时分配，之后不变

// 错误的做法（Claude Code 中看不到这种代码）：
msg.content = '修改后的内容'  // ❌ 违反不可变性

// 正确的做法：
const newMsg = createUserMessage({ content: '修改后的内容' })  // ✅ 创建新消息
```

### 5.2 消息数组操作

消息数组的操作也遵循不可变性：

```typescript
// ✅ 正确：创建新数组
const newMessages = [...messages, newMessage]

// ❌ 错误：修改原数组
messages.push(newMessage)
```

不过有一个例外：`assistantMessages.length = 0`（在模型降级时清空中间状态）。这是一个**有意的 mutation**，因为此时这些消息已经被 tombstone 标记为废弃，不会再被 API 使用。

### 5.3 工具结果的构建

工具执行完成后，tool_result 是**新创建**的消息，不是修改已有消息：

```typescript
// 工具执行
const result = await tool.fn(input)

// 创建新的 tool_result 消息
const resultMessage = createUserMessage({
  content: [{
    type: 'tool_result',
    tool_use_id: toolUseBlock.id,
    content: result,
  }],
})
```

---

## 6. 与其他系统的对比

### 6.1 OpenAI 的 Prompt Caching

OpenAI 也支持 prompt caching，但机制不同：
- Anthropic：客户端控制缓存边界，需要手动维护不可变性
- OpenAI：服务端自动缓存，客户端不需要特别处理

Claude Code 的不可变性约束是 Anthropic prompt caching 的**客户端代价**——需要更多工程投入，但提供了更细粒度的控制。

### 6.2 Google 的 Context Caching

Google 的 context caching 是显式的——你主动创建一个 "cached content" 对象，后续请求引用它。这比 Anthropic 的隐式缓存更容易理解，但灵活性更低。

---

## 7. 总结

不可变 API 消息不是一个"代码风格"选择——它是一个**成本优化决策**。

```
不可变性约束
  → prompt caching 字节匹配
    → 90% 的 input token 命中缓存
      → 80% 的 input 成本节省
        → 长会话的经济可行性
```

这条因果链揭示了一个重要的工程教训：**系统层面的约束（不可变性）可以带来巨大的运行时收益（成本节省）。**

Claude Code 团队选择在代码层面承受不可变性的复杂性（clone-before-modify、结构共享、双消息管线），换来了用户层面的成本降低和性能提升。这是一个典型的"开发者体验 vs 用户体验"权衡——他们选择了用户。
