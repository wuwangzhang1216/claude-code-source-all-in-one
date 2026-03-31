# Claude Code 源码深度分析系列

> 基于 [Claude Code Agent Flow 逆向分析](../claude-code-agent-flow-analysis.md) 一文，对其中每个章节进行深度拆解。每篇文章都包含源码级的代码分析、设计模式剖析、以及与业界其他方案的横向对比。

## 目录

| # | 主题 | 文件 | 关键词 |
|---|------|------|--------|
| 00 | [核心结论深度分析](00-core-conclusion.md) | `query.ts` | while(true) vs DAG, async generator, ReAct |
| 01 | [入口流程深度分析](01-entry-point.md) | `QueryEngine.ts`, `main.tsx` | 启动优化, 断点续传, 成本追踪 |
| 02 | [主循环深度分析](02-main-loop.md) | `query.ts` | State, 7个continue site, 类型安全 |
| 03 | [流式处理深度分析](03-streaming.md) | `StreamingToolExecutor.ts` | 并发控制, sibling abort, 进度流 |
| 04 | [工具编排深度分析](04-tool-orchestration.md) | `toolOrchestration.ts` | partitionToolCalls, 延迟上下文修改器 |
| 05 | [权限系统深度分析](05-permission-system.md) | `permissions.ts` | 4种模式, 推测性分类器, 规则匹配 |
| 06 | [子Agent深度分析](06-sub-agent.md) | `runAgent.ts` | 递归query(), worktree, 后台agent |
| 07 | [上下文窗口管理深度分析](07-context-window.md) | `services/compact/` | 四层压缩, 三级错误恢复 |
| 08 | [消息类型系统深度分析](08-message-types.md) | `utils/messages.ts` | 7种类型, TombstoneMessage |
| 09 | [不可变API消息深度分析](09-immutable-api-messages.md) | `query.ts` | prompt caching, clone-before-modify |
| 10 | [全局架构图深度分析](10-architecture-diagram.md) | 全局 | 调用图, 数据流, 并发模型 |
| 11 | [设计哲学深度分析](11-design-philosophy.md) | 全局 | 循环vs图, 递归vs编排, 模型决策 |

## 阅读建议

- **快速了解**: 先读 00（核心结论）和 11（设计哲学），把握整体脉络
- **深入理解**: 按顺序从 01 读到 09，跟着代码走一遍完整流程
- **架构视角**: 10（架构图）适合需要全局视野的读者

## 关键源文件索引

| 文件 | 行数 | 核心职责 |
|------|------|----------|
| `query.ts` | 1729 | Agent 主循环，所有恢复逻辑 |
| `QueryEngine.ts` | 1295 | 会话管理，入口编排 |
| `StreamingToolExecutor.ts` | 530 | 流式工具并发执行 |
| `toolOrchestration.ts` | 188 | 工具批次分区与编排 |
| `toolExecution.ts` | 1745 | 单工具执行、权限检查 |
| `permissions.ts` | 1486 | 权限决策链 |
| `runAgent.ts` | 973 | 子Agent 递归调用 |
| `utils/messages.ts` | 5512 | 消息工厂与转换 |
| `services/compact/` | ~11文件 | 四层上下文压缩 |
