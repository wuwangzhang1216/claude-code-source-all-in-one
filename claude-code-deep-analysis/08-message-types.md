# 08 - 消息类型系统深度分析：被忽视的基础设施

---

## 1. 消息类型全景

### 1.1 七种消息类型

```typescript
type Message =
  | AssistantMessage       // 模型的响应
  | UserMessage            // 用户输入 / tool_result
  | SystemMessage          // 合成消息（压缩边界、错误、进度）
  | ProgressMessage        // 工具执行进度
  | AttachmentMessage      // 动态上下文注入
  | ToolUseSummaryMessage  // 工具调用的延迟摘要
  | TombstoneMessage       // 废弃消息的墓碑标记
```

### 1.2 每种类型的角色

```
用户输入 ──→ UserMessage
                │
                ▼
           API 调用
                │
                ▼
         AssistantMessage ──→ 包含 tool_use blocks
                │
                ▼
         工具执行 ──→ ProgressMessage（实时进度）
                │
                ▼
         UserMessage（tool_result）──→ 回到 API
                │
                ▼
         ToolUseSummaryMessage（异步 Haiku 摘要）
                │
                ▼
         SystemMessage（压缩边界、错误等）
                │
         AttachmentMessage（memory、skills）
                │
         TombstoneMessage（撤回已输出的消息）
```

---

## 2. AssistantMessage：模型的声音

### 2.1 结构

```typescript
type AssistantMessage = {
  type: 'assistant'
  uuid: string              // 唯一标识
  message: {
    content: ContentBlock[]  // text, thinking, tool_use blocks
    usage: Usage             // token 用量
  }
  isApiErrorMessage?: boolean  // 是否是 API 错误消息
}
```

### 2.2 content 的三种 block

```typescript
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: object }
```

一个 AssistantMessage 可能同时包含 thinking（模型的思考过程）、text（给用户的回复）、和 tool_use（工具调用）。这三种 block 的顺序反映了模型的处理流程：先思考，再回复，再调用工具。

### 2.3 isApiErrorMessage 标记

当 API 返回错误时（413、429、500 等），错误被包装成一个 `AssistantMessage`，但设置 `isApiErrorMessage: true`。

这个标记的作用：
1. **UI 层**：用不同的样式渲染错误消息
2. **主循环**：跳过 stop hooks（API 错误不应该触发 stop hooks）
3. **恢复逻辑**：判断是否需要错误恢复

---

## 3. UserMessage：双重身份

### 3.1 用户输入

```typescript
const userInput = createUserMessage({
  content: "请帮我修改 app.ts",
})
```

### 3.2 工具结果

```typescript
const toolResult = createUserMessage({
  content: [{
    type: 'tool_result',
    tool_use_id: 'toolu_123',
    content: '文件内容...',
  }],
  toolUseResult: '文件读取成功',        // UI 显示的摘要
  sourceToolAssistantUUID: 'asst_456',  // 关联的 assistant 消息
})
```

**同一个类型承载两种语义**——这是因为 Anthropic API 的设计：`tool_result` 必须包含在 `user` role 的消息中。Claude Code 通过 `sourceToolAssistantUUID` 字段区分"真正的用户输入"和"工具结果"。

### 3.3 isMeta 标记

```typescript
const metaMessage = createUserMessage({
  content: 'Output token limit hit. Resume directly...',
  isMeta: true,
})
```

`isMeta: true` 表示这是**框架注入的元消息**，不是用户真正输入的。UI 通常不直接显示 meta 消息。

---

## 4. SystemMessage：合成消息的分类学

### 4.1 子类型枚举

SystemMessage 有超过 15 种子类型：

| 子类型 | 用途 |
|--------|------|
| `compact_boundary` | 标记压缩发生的位置 |
| `microcompact_boundary` | 标记 microcompact 位置 |
| `api_error` | API 调用失败 |
| `api_metrics` | Token 用量和缓存命中 |
| `turn_duration` | 计时信息 |
| `informational` | 一般信息 |
| `away_summary` | 会话暂停数据 |
| `scheduled_task_fire` | 定时任务触发 |
| `bridge_status` | 跨机器连接状态 |
| `local_command` | 本地 shell 命令 |
| `memory_saved` | 自动记忆检查点 |
| `stop_hook_summary` | Stop hook 结果 |
| `agents_killed` | 子 agent 终止 |
| `permission_retry` | 权限恢复信号 |

### 4.2 严重级别

```typescript
type Severity = 'info' | 'warning' | 'error'
```

- `info`：正常信息（如 compact_boundary）
- `warning`：需要注意（如模型降级通知）
- `error`：需要用户关注（如 API 持续失败）

---

## 5. TombstoneMessage：追溯性撤回

### 5.1 问题场景

```
时间线:
T1: 模型开始流式输出 → yield AssistantMessage_1（用户看到了）
T2: 模型继续输出 → yield AssistantMessage_2（用户看到了）
T3: 模型出错/降级 → 需要撤回 T1 和 T2 的消息
```

在批处理系统中，这不是问题——你可以在返回前检查错误。但在**流式系统**中，消息已经 yield 给了消费者，用户已经在屏幕上看到了。

### 5.2 Tombstone 解决方案

```typescript
type TombstoneMessage = {
  type: 'tombstone'
  targetUUID: string  // 要撤回的消息的 UUID
}
```

主循环在模型降级时发出 tombstone：

```typescript
// query.ts 模型降级处理
for (const msg of assistantMessages) {
  yield { type: 'tombstone', targetUUID: msg.uuid }
}
```

UI 层收到 tombstone 后：
1. 从显示列表中移除对应 UUID 的消息
2. 可能显示一个"消息已撤回"的提示
3. 用新模型的输出替代

### 5.3 为什么不用其他方案

**方案 A：不流式输出，等完整响应**
- 问题：用户等待时间过长，体验差

**方案 B：流式输出但出错时显示错误**
- 问题：屏幕上残留了半截的旧输出 + 错误信息 + 新输出，混乱

**方案 C：Tombstone（Claude Code 的选择）**
- 优势：UI 可以干净地移除旧输出，替换为新输出
- 代价：需要 UI 层实现 tombstone 处理逻辑

### 5.4 设计原则

> **流式系统的错误恢复，比批处理系统难一个数量级。**

你已经 yield 出去的东西，用户已经看到了，你不能假装它没发生过。Tombstone 是一种"追溯性撤回"机制——它承认过去发生了，但明确告知"请忽略它"。

---

## 6. ProgressMessage：实时反馈

### 6.1 用途

当工具执行时间较长时（如 Bash 命令运行 npm install），ProgressMessage 提供实时反馈：

```typescript
type ProgressMessage = {
  type: 'progress'
  toolUseId: string
  content: string   // 当前进度描述
}
```

### 6.2 与结果消息的分离

在 StreamingToolExecutor 中，进度消息和结果消息是**分开处理**的：

```typescript
// 进度消息：立即 yield，不等排序
if (message.type === 'progress') {
  tool.pendingProgress.push(message)
  // 唤醒 getRemainingResults 的等待
  this.progressAvailableResolve?.()
}

// 结果消息：缓存起来，按顺序 yield
else {
  tool.results.push(message)
}
```

进度消息需要**低延迟**（用户在等待反馈），而结果消息需要**有序**（tool_use/tool_result 配对）。分离处理让两个需求互不干扰。

---

## 7. AttachmentMessage：动态上下文注入

### 7.1 用途

AttachmentMessage 用于在对话中注入额外的上下文：

```typescript
type AttachmentMessage = {
  type: 'attachment'
  attachment: {
    type: 'memory' | 'skill' | 'file' | 'context'
    content: string
  }
}
```

### 7.2 注入时机

```
用户输入 "帮我优化这个函数"
  │
  ├─ Memory 系统查找相关记忆 → AttachmentMessage(memory)
  ├─ Skill 系统匹配激活技能 → AttachmentMessage(skill)
  └─ 这些附件和用户消息一起发给 API
```

附件在消息列表中以特殊标记插入，模型可以看到它们但知道它们不是用户直接输入的。

---

## 8. ToolUseSummaryMessage：异步摘要

### 8.1 生成流程

```
Turn N: 模型调了 3 个工具
  │
  ├─ 工具执行完成
  ├─ 异步启动 Haiku 生成摘要（~1秒）
  └─ 不等待，继续进入 Turn N+1

Turn N+1 开始:
  ├─ await pendingToolUseSummary（上一轮的摘要）
  ├─ 如果已完成 → yield ToolUseSummaryMessage
  └─ 继续本轮逻辑
```

### 8.2 设计权衡

- **不阻塞**：摘要生成和下一轮 API 调用并行
- **可选**：如果 Haiku 调用失败，摘要不影响主流程
- **轻量**：Haiku 是最小的模型，成本极低

---

## 9. 消息工厂和转换

### 9.1 utils/messages.ts 的规模

这是整个代码库中**最大的工具文件**——5512 行。它包含：

- 消息创建工厂函数（`createUserMessage`、`createSystemMessage` 等）
- 消息转换函数（`normalizeMessagesForAPI`）
- 消息查询函数（`getMessagesAfterCompactBoundary`）
- 消息操作函数（`stripSignatureBlocks`）
- 常量定义（`SYNTHETIC_MESSAGES`、`REJECT_MESSAGE`）

### 9.2 normalizeMessagesForAPI

```typescript
function normalizeMessagesForAPI(messages: Message[]): APIMessage[] {
  return messages
    .filter(isAPIRelevant)        // 过滤掉 Progress、Tombstone 等
    .map(toAPIFormat)             // 转换为 API 格式
    .reduce(mergeConsecutive, []) // 合并连续的同类型消息
}
```

API 只接受 `user` 和 `assistant` role 的消息，且不允许连续两个相同 role。`normalizeMessagesForAPI` 负责把 Claude Code 内部的 7 种消息类型转换为 API 能接受的格式。

### 9.3 UUID 稳定性

每个消息在创建时就分配了一个 `uuid`（通过 `crypto.randomUUID()`）。这个 UUID 在消息的整个生命周期中保持不变：

- 创建时分配
- 压缩时保留（摘要消息继承被压缩消息的 UUID）
- Tombstone 通过 UUID 精确定位要撤回的消息
- 日志和分析通过 UUID 追踪消息

---

## 10. SDK 消息类型映射

### 10.1 内部 → SDK 转换

Claude Code 的内部消息类型和暴露给 SDK 消费者的类型不同：

```typescript
// 内部类型
type Message = AssistantMessage | UserMessage | SystemMessage | ...

// SDK 类型
type SDKMessage = {
  type: 'assistant' | 'user' | 'system' | 'compact_boundary' | ...
  content: string | ContentBlock[]
  // 简化的字段
}
```

SDK 类型更简单——它隐藏了内部实现细节（如 `isApiErrorMessage`、`sourceToolAssistantUUID`），只暴露消费者需要的信息。

### 10.2 特殊 SDK 消息

```typescript
type SDKCompactBoundaryMessage = {
  type: 'compact_boundary'
  preCompactTokenCount: number
  postCompactTokenCount: number
}

type SDKPermissionDenial = {
  type: 'permission_denial'
  tool: string
  reason: string
}
```

这些是 SDK 特有的消息类型——内部用 SystemMessage 表示，但对 SDK 消费者暴露为专门的类型，方便处理。

---

## 11. 总结

Claude Code 的消息类型系统看起来"只是定义了一些类型"，但它实际上是整个系统的**数据模型基础**。

7 种消息类型对应了 agent 系统中的 7 种信息流：
- 用户 → 模型（UserMessage）
- 模型 → 用户（AssistantMessage）
- 框架 → 用户（SystemMessage）
- 工具 → 用户（ProgressMessage）
- 上下文 → 模型（AttachmentMessage）
- 摘要 → 用户（ToolUseSummaryMessage）
- 撤回 → UI（TombstoneMessage）

每一种都有其存在的工程理由，缺一不可。
