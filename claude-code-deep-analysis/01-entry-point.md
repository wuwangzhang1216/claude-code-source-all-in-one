# 01 - 入口流程深度分析：从用户敲下回车到 Agent 启动

---

## 1. 启动阶段：main.tsx 的并行预取

### 1.1 Side-effect-first 模式

`main.tsx` 的前几行不是 import，而是**副作用调用**：

```typescript
// main.tsx 顶部（极度简化）
startMdmRawRead()           // 预读 MDM 配置
startKeychainPrefetch()     // 预取 keychain 凭据
profileCheckpoint('main_tsx_entry')  // 性能采样点
```

这些调用在任何 import 之前执行。为什么？

因为 Node.js（或 Bun）的模块加载是**同步的**。当你 `import` 一个模块时，所有依赖链上的模块代码都会同步执行。在 Claude Code 这样的大型应用中，模块加载可能需要几百毫秒。

通过在 import 之前启动 I/O 操作（keychain 读取、MDM 配置），这些异步操作可以和模块加载**并行执行**。等到真正需要这些数据时（比如构建 API 请求），它们通常已经就绪了。

### 1.2 Profile Checkpoint

`profileCheckpoint` 不是普通的日志，而是一个**性能采样系统**的一部分：

```
main_tsx_entry → imports_done → repl_ready → first_api_call
```

每个 checkpoint 记录时间戳，允许团队追踪冷启动性能的每个阶段。这是面向用户体验的工程——用户每次打开 Claude Code 都会经历冷启动，哪怕优化 100ms 都有意义。

---

## 2. QueryEngine：会话的管家

### 2.1 类的职责

`QueryEngine` 是整个 Claude Code 的会话管理层。它不负责具体的 AI 逻辑（那是 `query()` 的事），而是负责"围绕 AI 逻辑的一切"：

```typescript
// QueryEngine.ts:184
export class QueryEngine {
  // 核心方法
  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown>
}
```

### 2.2 submitMessage 的六个阶段

`submitMessage` 是一个 async generator，内部按顺序执行六个阶段：

```
Stage 1: processUserInput()     → 斜杠命令展开
Stage 2: System Prompt 组装     → 多源合并
Stage 3: File History Snapshot  → 拍快照用于 undo
Stage 4: Transcript Recording   → 断点续传
Stage 5: query()                → 核心 agent 循环
Stage 6: Post-turn Cleanup      → 成本累计、状态更新
```

### 2.3 Stage 1: processUserInput() — 斜杠命令展开

当用户输入 `/compact` 或 `/help` 时，这些斜杠命令不会直接发给模型，而是在 `processUserInput()` 中被拦截和处理：

```
用户输入: "/compact 压缩上下文"
  → processUserInput() 识别 /compact 命令
  → 执行 compact 逻辑
  → 返回结果（不进入 query 循环）
```

对于非命令输入，`processUserInput()` 还会做一些预处理：
- 解析 `@file` 引用，将文件内容内联
- 处理图片附件
- 展开环境变量

### 2.4 Stage 2: System Prompt 组装

Claude Code 的 system prompt 不是一个静态字符串，而是从**多个来源动态组装**的：

```
System Prompt = 
  基础指令（role, capabilities）
  + 用户自定义规则（CLAUDE.md）
  + 项目上下文（git info, cwd）
  + 工具描述（动态生成）
  + Memory 上下文（相关记忆）
  + Skill 上下文（激活的技能）
  + MCP 服务器状态
```

这种动态组装确保了：
1. 不同项目有不同的上下文（通过 CLAUDE.md）
2. 工具集可以动态变化（MCP 服务器可以在运行时添加/移除）
3. 相关记忆按需注入（不是每次都加载所有记忆）

### 2.5 Stage 3: File History Snapshot

```typescript
// 每个 turn 开始时拍快照
const snapshot = fileHistoryMakeSnapshot(modifiedFiles)
```

这个快照记录了**当前 turn 开始时所有已修改文件的内容**。当用户对 Claude Code 的修改不满意时，可以通过 `/undo` 回退到这个快照。

关键设计决策：
- 快照在**调 API 之前**拍——确保即使 API 调用中途崩溃，快照也是完整的
- 快照是**增量的**——只记录已修改的文件，不做全仓库快照
- 快照存在**内存中**——不写磁盘，避免 I/O 开销

### 2.6 Stage 4: Transcript Recording — 断点续传的基础

```typescript
// 在调 API 之前就记录用户消息
recordTranscript(userMessage)
```

这个设计是 Claude Code 工程成熟度的体现。传统做法是在 API 响应后才记录对话历史。但如果 API 调用中途崩溃了呢？

Claude Code 的做法是：**先写日志，再调 API**。这样即使进程被 kill、网络中断、API 500，下次启动时都能从 transcript 中恢复。

这本质上是数据库系统中 **Write-Ahead Log (WAL)** 的思想在 agent 系统中的应用。

### 2.7 Stage 5: query() — 核心循环

这是整个链路的核心，已在 02-main-loop.md 中详细分析。这里只关注 QueryEngine 如何消费 query() 的输出：

```typescript
for await (const message of query({
  messages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool: wrappedCanUseTool,
  toolUseContext: processUserInputContext,
  fallbackModel,
  querySource: 'sdk',
  maxTurns,
  taskBudget,
})) {
  // 1. 记录到 transcript
  recordTranscript(message)
  
  // 2. 转换为 SDK 消息格式
  const sdkMessage = toSDKMessage(message)
  
  // 3. yield 给外层消费者
  yield sdkMessage
}
```

注意 `wrappedCanUseTool`——QueryEngine 会**包装**权限检查函数，注入额外的逻辑（比如 UI 确认对话框的集成）。

### 2.8 Stage 6: Post-turn Cleanup

turn 结束后，QueryEngine 执行清理工作：

```typescript
// 累计 token 用量
accumulateUsage(response.usage)

// 更新成本
updateCost(response.usage)

// 刷新 session storage
flushSessionStorage()
```

---

## 3. 成本追踪系统

### 3.1 跨 Turn 累计

Claude Code 在整个会话期间追踪 token 使用和美元成本：

```
Turn 1: input=1000, output=500, cost=$0.03
Turn 2: input=1500, output=800, cost=$0.05
Turn 3: input=2000, output=1200, cost=$0.08
────────────────────────────────────────────
累计:   input=4500, output=2500, cost=$0.16
```

这些数据通过 `getTotalCost()` 暴露给 UI，让用户随时知道当前会话的花费。

### 3.2 Prompt Caching 感知

成本计算不是简单的 `tokens × price`，而是区分了：

- `cache_creation_input_tokens`——首次创建缓存的 token（按正常价计费）
- `cache_read_input_tokens`——命中缓存的 token（按 10% 价格计费）
- 普通 `input_tokens`——未缓存的 token

这意味着 Claude Code 的成本追踪是**缓存感知的**——它知道你因为 prompt caching 省了多少钱。

---

## 4. AbortController 的传播

### 4.1 取消链

用户在 Claude Code 中按 Ctrl+C，触发的是一条 AbortController 链：

```
用户按 Ctrl+C
  → REPL 层 abort
    → QueryEngine 的 abortController.abort()
      → query() 循环检测到 abort signal
        → StreamingToolExecutor 的 siblingAbortController.abort()
          → 每个正在执行的工具收到 abort
            → Bash 进程被 kill
            → 子 agent 被终止
```

这条链确保了**从 UI 到最底层的进程**都能优雅地终止。

### 4.2 中断语义

`AbortController.signal.reason` 区分了不同类型的中断：

| reason | 含义 | 工具行为 |
|--------|------|---------|
| `undefined` | 用户按 Ctrl+C | 所有工具停止 |
| `'interrupt'` | 用户输入了新消息 | 只停止 `cancel` 类工具 |

`'interrupt'` 是一个微妙的场景：用户在工具执行过程中输入了新消息。这时候 Claude Code 不会粗暴地杀掉所有工具，而是只停止那些声明了 `interruptBehavior: 'cancel'` 的工具。比如一个正在写文件的工具不应该被打断（可能导致文件损坏），但一个正在搜索的工具可以被安全取消。

---

## 5. SDK 入口 vs CLI 入口

Claude Code 有两个入口路径：

```
CLI 入口:
  main.tsx → launchRepl() → React/Ink UI → QueryEngine

SDK 入口:
  entrypoints/sdk/index.ts → QueryEngine（无 UI）
```

SDK 入口跳过了所有 UI 相关的逻辑（React、Ink、终端渲染），直接暴露 `QueryEngine` 的 async generator 接口。这让第三方应用可以嵌入 Claude Code 的 agent 能力，而不需要终端 UI。

两个入口共享同一个 `query()` 核心——这是"核心逻辑与 UI 分离"这一设计原则的典型实践。

---

## 6. 总结：入口设计的工程智慧

Claude Code 的入口设计体现了几个关键原则：

1. **并行优先**——启动阶段的 I/O 操作与模块加载并行
2. **先写后做**——WAL 思想在 agent 系统中的应用
3. **快照隔离**——文件快照支持 undo，给用户安全感
4. **优雅终止**——AbortController 链确保从 UI 到进程的完整取消
5. **核心与 UI 分离**——CLI 和 SDK 共享同一个 agent 核心

这些设计不"性感"——它们不会出现在产品发布会上。但它们是 Claude Code 能在长时间会话中保持稳定的基础。
