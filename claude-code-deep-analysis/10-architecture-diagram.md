# 10 - 全局架构图深度分析：系统全景

---

## 1. 增强版调用关系图

```
用户输入
  │
  ▼
┌─────────────────────────────────────────────────────────────────┐
│ QueryEngine.submitMessage()                                      │
│  ├─ processUserInput()           // 斜杠命令展开、@file 解析      │
│  ├─ buildSystemPrompt()          // 多源合并系统提示              │
│  │   ├─ 基础指令                                                 │
│  │   ├─ CLAUDE.md 规则                                           │
│  │   ├─ Memory 上下文 ←─── startRelevantMemoryPrefetch()        │
│  │   ├─ Skill 上下文                                             │
│  │   └─ MCP 服务器状态                                           │
│  ├─ fileHistoryMakeSnapshot()    // 文件快照（支持 undo）         │
│  ├─ recordTranscript()           // WAL 写入（断点续传）          │
│  └─ query()                      // ← 核心主循环                 │
└────────────────────────────────────│──────────────────────────────┘
                                    │
                                    ▼
┌─ queryLoop() ────────────────────────────────────────────────────┐
│  buildQueryConfig()  // 不可变环境快照                            │
│  while (true) {                                                  │
│    │                                                             │
│    ├─ 四层上下文压缩                                              │
│    │  ├─ snip()                  // Layer 1: 移除低价值 turn     │
│    │  ├─ microcompact()          // Layer 2: 缓存感知精简         │
│    │  ├─ contextCollapse         // Layer 3: 读时投影压缩         │
│    │  │   └─ projectView()       //   回放 collapse 日志         │
│    │  └─ autocompact()           // Layer 4: 全量摘要压缩（条件） │
│    │      └─ compact()           //   fork API 调用生成摘要       │
│    │                                                             │
│    ├─ callModel()                // 流式 API 调用                 │
│    │  └─ for await (stream) {                                    │
│    │      ├─ yield text/thinking → UI                            │
│    │      ├─ collect tool_use blocks                             │
│    │      └─ StreamingToolExecutor.addTool() → 边流边执行         │
│    │  }                                                          │
│    │                                                             │
│    ├─ StreamingToolExecutor.getRemainingResults()                 │
│    │  └─ 等待所有工具完成，按顺序 yield                           │
│    │                                                             │
│    ├─ runTools() / toolOrchestration                              │
│    │  └─ partitionToolCalls()                                    │
│    │      ├─ 并发批次 → runToolsConcurrently()                   │
│    │      │   └─ all() → 最大并发10                               │
│    │      │       └─ runToolUse()                                 │
│    │      │           ├─ canUseTool() → 权限检查                  │
│    │      │           │   ├─ 静态规则匹配                         │
│    │      │           │   ├─ tool.checkPermissions()              │
│    │      │           │   ├─ (auto) 推测性分类器                  │
│    │      │           │   └─ (interactive) 弹框确认               │
│    │      │           └─ tool.fn() → 实际执行                     │
│    │      │               ├─ Read/Grep/Glob (只读)               │
│    │      │               ├─ Edit/Write (文件修改)                │
│    │      │               ├─ Bash (命令执行)                      │
│    │      │               ├─ Agent → runAgent() → query() 递归    │
│    │      │               │   ├─ createSubagentContext()          │
│    │      │               │   ├─ filterToolsForAgent()            │
│    │      │               │   └─ 继承四层压缩/错误恢复/权限       │
│    │      │               └─ MCP 工具 → mcpClient.callTool()     │
│    │      └─ 串行批次 → runToolsSerially()                       │
│    │          └─ (同上，但逐个执行)                                │
│    │                                                             │
│    ├─ 延迟上下文修改器应用                                        │
│    │  └─ queuedContextModifiers → 按声明顺序应用                 │
│    │                                                             │
│    ├─ Post-sampling hooks                                        │
│    │  └─ executePostSamplingHooks()                              │
│    │                                                             │
│    ├─ Stop hooks                                                 │
│    │  └─ handleStopHooks()                                       │
│    │      ├─ blockingErrors → continue (Site 6)                  │
│    │      └─ preventContinuation → return                        │
│    │                                                             │
│    └─ needsFollowUp?                                             │
│        ├─ true  → state={...}; continue                          │
│        │   ├─ 正常工具继续 (Site: next_turn)                     │
│        │   ├─ 模型降级 (Site 1: tombstone + retry)               │
│        │   ├─ Collapse drain (Site 2: 排空)                      │
│        │   ├─ Reactive compact (Site 3: 紧急压缩)                │
│        │   ├─ Max tokens 升级 (Site 4: 8k→64k)                  │
│        │   ├─ Max tokens 恢复 (Site 5: meta message)             │
│        │   ├─ Stop hook 阻断 (Site 6: 重试)                     │
│        │   └─ Token budget 续行 (Site 7: nudge)                  │
│        └─ false → return { reason: 'completed' }                 │
│  }                                                               │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. 数据流图

### 2.1 消息生命周期

```
创建                转换                   传输                消费
───────────────────────────────────────────────────────────────────

UserMessage ──→ normalizeForAPI ──→ API Request ──→ Claude Model
                                                        │
AssistantMessage ←───────────── API Response ←──────────┘
     │
     ├─ yield → UI（可能 clone-before-modify）
     │
     ├─ tool_use blocks → StreamingToolExecutor
     │                          │
     │                    tool.fn() 执行
     │                          │
     │                    tool_result (UserMessage)
     │                          │
     └──────── + ──────────────┘
              │
         放回 messages 数组
              │
         下一轮 → 四层压缩 → API Request → ...
```

### 2.2 上下文流

```
用户消息 + 历史消息
     │
     ├─ + System Prompt（动态组装）
     │    ├─ 基础指令
     │    ├─ CLAUDE.md
     │    ├─ Memory
     │    ├─ Skills
     │    └─ MCP 状态
     │
     ├─ + Attachment Messages
     │    ├─ 相关记忆
     │    └─ 激活技能
     │
     └─ → 四层压缩
          │
          └─ → API 调用
```

---

## 3. 模块依赖图

```
┌─────────────────────────────────────────────────────┐
│                    入口层 (Entrypoints)               │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐ │
│  │ main.tsx  │  │ sdk/     │  │ vscode extension   │ │
│  │ (CLI)     │  │ index.ts │  │                    │ │
│  └────┬──────┘  └────┬─────┘  └────────┬───────────┘ │
└───────┼──────────────┼─────────────────┼─────────────┘
        │              │                 │
        ▼              ▼                 ▼
┌─────────────────────────────────────────────────────┐
│                    核心层 (Core)                      │
│  ┌──────────────┐  ┌─────────┐  ┌────────────────┐  │
│  │ QueryEngine  │  │ query   │  │ Tool           │  │
│  │ .ts          │→ │ .ts     │→ │ .ts            │  │
│  │ (1295行)     │  │(1729行) │  │(792行)         │  │
│  └──────────────┘  └─────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────┘
        │              │                 │
        ▼              ▼                 ▼
┌─────────────────────────────────────────────────────┐
│                   服务层 (Services)                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ compact/ │  │ tools/   │  │ api/     │          │
│  │ (11文件) │  │ (5文件)  │  │ (10文件) │          │
│  └──────────┘  └──────────┘  └──────────┘          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐          │
│  │ mcp/     │  │analytics/│  │ remote   │          │
│  │          │  │          │  │ Settings/│          │
│  └──────────┘  └──────────┘  └──────────┘          │
└─────────────────────────────────────────────────────┘
        │              │                 │
        ▼              ▼                 ▼
┌─────────────────────────────────────────────────────┐
│                   工具层 (Utilities)                  │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ permissions/ │  │ messages │  │ hooks/        │  │
│  │ (1486行+)   │  │ (5512行) │  │ (17文件)      │  │
│  └──────────────┘  └──────────┘  └───────────────┘  │
│  ┌──────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ generators   │  │ session  │  │ forkedAgent   │  │
│  │ .ts          │  │ Storage  │  │ .ts           │  │
│  └──────────────┘  └──────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## 4. 状态管理拓扑

Claude Code 有四种不同作用域的状态：

```
┌─────────────────────────────────────────────┐
│ AppState（全局，共享）                        │
│  ├─ 权限更新（Always Allow 等）              │
│  ├─ 用户偏好                                 │
│  └─ MCP 连接状态                             │
│  作用域: 所有 agent（父 + 子）                │
│  生命周期: 整个会话                           │
└─────────────────────────────────────────────┘
         │
┌────────┴────────────────────────────────────┐
│ ToolUseContext（每 agent，选择性共享）         │
│  ├─ 可用工具列表                              │
│  ├─ 当前模型                                  │
│  ├─ 文件缓存（克隆）                          │
│  ├─ AbortController（独立）                   │
│  └─ 进度追踪                                  │
│  作用域: 单个 agent 实例                       │
│  生命周期: agent 运行期间                      │
└─────────────────────────────────────────────┘
         │
┌────────┴────────────────────────────────────┐
│ State（每迭代，完整替换）                     │
│  ├─ messages                                 │
│  ├─ autoCompactTracking                      │
│  ├─ maxOutputTokensRecoveryCount             │
│  ├─ hasAttemptedReactiveCompact              │
│  ├─ transition                               │
│  └─ ...（共 10 个字段）                       │
│  作用域: queryLoop 的单次迭代                  │
│  生命周期: 一次 continue/return                │
└─────────────────────────────────────────────┘
         │
┌────────┴────────────────────────────────────┐
│ 局部变量（每迭代，循环内）                    │
│  ├─ messagesForQuery（压缩后的消息）          │
│  ├─ assistantMessages（当前轮的响应）          │
│  ├─ toolResults（当前轮的工具结果）            │
│  └─ taskBudgetRemaining（跨压缩边界）         │
│  作用域: while(true) 循环体                   │
│  生命周期: 单次迭代                           │
└─────────────────────────────────────────────┘
```

---

## 5. 并发模型图

```
主线程 (queryLoop)
  │
  ├─ 流式 API 调用────────────────────────────┐
  │  (for await stream)                       │
  │       │                                   │
  │       ├─ StreamingToolExecutor            │
  │       │   ├─ Tool_1 (并发) ───→ 完成      │ 流式输出
  │       │   ├─ Tool_2 (并发) ───→ 完成      │ 同时执行
  │       │   └─ Tool_3 (串行) ──→ 等待 1,2   │ 工具
  │       │                                   │
  │       └─ yield text/thinking → UI ────────┘
  │
  ├─ Fork Agent: AutoCompact
  │   └─ 独立 API 调用生成摘要
  │       └─ 完成后返回压缩结果
  │
  ├─ 后台 Agent (run_in_background)
  │   └─ 独立运行 query() 递归
  │       ├─ 有自己的 AbortController
  │       ├─ 完成后通知父 agent
  │       └─ 可能在 worktree 中运行
  │
  ├─ Haiku 摘要 (异步)
  │   └─ 生成 ToolUseSummaryMessage
  │       └─ 下一轮开始时 await
  │
  └─ Memory Prefetch (异步)
      └─ 查询相关记忆
          └─ 在需要时 poll 结果

Abort 传播:
  用户 Ctrl+C
    └─ AbortController (顶层)
        ├─ siblingAbortController
        │   └─ per-tool AbortControllers
        └─ 子 agent AbortControllers（独立，不级联）
```

---

## 6. Feature Flag 架构

### 6.1 编译时 vs 运行时

```typescript
// 编译时 feature flag（Bun bundler 死代码消除）
if (feature('CONTEXT_COLLAPSE')) {
  // 这个 import 在 feature 关闭时被完全移除
  const contextCollapse = require('./services/contextCollapse/index.js')
}

// 运行时 feature flag（Statsig）
const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_otk_slot_v1', false)
```

### 6.2 为什么用编译时 flag

编译时 feature flag 的优势：
1. **死代码消除**——关闭的 feature 不会出现在最终 bundle 中
2. **零运行时开销**——不需要在运行时检查 flag 值
3. **更小的包体积**——减少了用户需要下载的代码量

代价是：改变 flag 需要重新构建。但对于 Claude Code 这样的 CLI 工具，每次发版都会重新构建，所以这个代价可以接受。

---

## 7. 总结

从全局视角看，Claude Code 的架构可以用三个同心圆来概括：

```
┌─────────────────────────────────────────┐
│ 外圈: 入口和 UI                          │
│  (main.tsx, SDK, VS Code Extension)      │
│  ┌───────────────────────────────────┐   │
│  │ 中圈: 会话管理和编排               │   │
│  │  (QueryEngine, query, Tool)       │   │
│  │  ┌───────────────────────────┐    │   │
│  │  │ 内圈: 基础设施              │    │   │
│  │  │  (压缩、权限、消息、缓存)   │    │   │
│  │  └───────────────────────────┘    │   │
│  └───────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

- **内圈**最复杂（压缩系统、权限系统），但变化最少
- **中圈**是核心逻辑，变化适中
- **外圈**最简单，但变化最频繁（新的入口、新的 UI）

这种分层确保了：**最复杂的代码最稳定，最常变化的代码最简单**。
