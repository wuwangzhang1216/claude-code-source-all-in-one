# 05 - 权限系统深度分析：安全不是 checkbox

---

## 1. 权限模式全景

### 1.1 外部模式

用户可以选择的权限模式：

| 模式 | 行为 | 适用场景 |
|------|------|----------|
| `default` | 每个敏感操作弹框确认 | 初次使用、敏感项目 |
| `acceptEdits` | 自动接受文件编辑，其他操作仍需确认 | 日常开发 |
| `plan` | 模型先输出计划，人工审批后执行 | 大规模重构 |
| `bypassPermissions` | 跳过所有权限检查 | 信任环境、CI/CD |
| `dontAsk` | 不弹框，但也不自动允许——直接拒绝 | 自动化脚本 |

### 1.2 内部模式

框架内部使用的模式：

| 模式 | 触发条件 | 行为 |
|------|----------|------|
| `auto` | `TRANSCRIPT_CLASSIFIER` feature 开启 | 分类器自动审批 |
| `bubble` | 子 agent 需要父 agent 决策 | 权限请求向上冒泡 |

`auto` 模式是最有技术含量的——它使用机器学习分类器来自动判断工具调用是否安全。

---

## 2. 权限决策链

### 2.1 完整决策流

`hasPermissionsToUseToolInner()`（permissions.ts:1158-1319）的决策链：

```
Step 1a: Deny 规则检查
  └─ 工具在 deny list 中？ → {behavior: 'deny'}

Step 1b: Ask 规则检查  
  └─ 工具有 ask 规则？ → {behavior: 'ask'}
  └─ 例外：沙箱中的 Bash 自动允许

Step 1c: 工具自身权限检查
  └─ tool.checkPermissions(input, context) 
  └─ 返回 PermissionResult（allow/deny/ask/passthrough）

Step 2a: Bypass 模式处理
  └─ bypassPermissions 或 plan 模式？ → {behavior: 'allow'}

Step 2b: Always-allow 规则检查
  └─ 工具在 allow list 中？ → {behavior: 'allow'}

Step 3: Passthrough → Ask 转换
  └─ tool 返回 passthrough → 转为 {behavior: 'ask'}
```

### 2.2 规则来源层级

权限规则来自多个来源，有优先级：

```
Policy Limits（最高优先级）
  └─ 组织管理员设置的强制规则
  └─ 不可被用户覆盖

Managed Settings
  └─ 远程管理的配置
  └─ 可被 Policy Limits 覆盖

Project Settings（.claude/settings.json）
  └─ 项目级别的规则
  └─ 可被上层覆盖

Global Config（~/.claude/settings.json）
  └─ 用户全局配置
  └─ 最低优先级
```

这种层级结构支持了企业场景：管理员可以通过 Policy Limits 强制禁止某些操作（如 `rm -rf /`），即使用户设了 `bypassPermissions` 也无法绕过。

### 2.3 工具自身权限检查

每个工具可以实现 `checkPermissions` 方法来定义自己的权限逻辑：

```typescript
// 工具定义中
checkPermissions(input: ParsedInput, context: PermissionContext): PermissionResult {
  if (input.command.includes('sudo')) {
    return { type: 'ask', message: '此命令使用了 sudo' }
  }
  if (isReadOnlyCommand(input.command)) {
    return { type: 'allow' }
  }
  return { type: 'passthrough' }  // 交给框架决定
}
```

`passthrough` 是一个关键返回值——它表示"工具自身没有意见，请按照用户的权限模式处理"。这让工具可以只关注自己的领域逻辑，而不需要了解全局的权限配置。

---

## 3. 推测性 Bash 分类器

### 3.1 设计目标

在 `auto` 模式下，用户不希望每个 Bash 命令都弹框确认，但也不想完全跳过安全检查。

解决方案：用一个**快速分类器**在 2 秒内判断命令是否安全。

### 3.2 工作流

```
用户启用 auto 模式
  │
  ├─ 模型输出 Bash 工具调用
  │
  ├─ 框架启动推测性分类（异步）
  │     └─ 分类器分析命令安全性
  │
  ├─ Promise.race([分类器结果, 2秒超时])
  │     ├─ 分类器在 2s 内返回 "safe" → 自动允许
  │     ├─ 分类器在 2s 内返回 "unsafe" → 弹框确认
  │     └─ 2s 超时 → 回退到弹框确认
  │
  └─ 记录分类决策用于分析
```

### 3.3 推测性执行

分类器是"推测性"的——它在权限检查**之前**就开始运行。当 `addTool()` 被调用时（tool_use block 从 API 流中到达），分类器立即开始分析。等到 `canUseTool()` 被调用时，分类结果可能已经准备好了。

```typescript
// 权限检查时
const speculativeResult = peekSpeculativeClassifierCheck(command)
if (speculativeResult && speculativeResult.confidence > threshold) {
  // 分类器已经有结果了，直接使用
  return speculativeResult.decision
}
// 否则等待或弹框
```

这种设计的效果是：对于大多数安全命令（`ls`、`cat`、`git status`），用户感受不到任何权限延迟——分类器在命令从 API 流中到达的那一刻就开始工作，等到需要权限决策时已经完成了。

### 3.4 危险模式检测

分类器的一部分是基于模式匹配的 `dangerousPatterns`：

```typescript
// 典型的危险模式
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,           // rm -rf /
  /chmod\s+777/,              // 开放所有权限
  />\s*\/etc\//,              // 写入系统配置
  /curl.*\|\s*sh/,            // 下载并执行
  /eval\s*\(/,                // eval 执行
  // ...
]
```

这些模式提供了**第一道防线**——即使分类器 API 不可用，这些明显危险的命令也会被拦截。

---

## 4. 权限持久化

### 4.1 "Always Allow" 的传播

当用户点击 "Always Allow" 时，这个决策需要：

1. **立即生效**——当前 turn 中后续的相同工具不再弹框
2. **跨 turn 生效**——后续 turn 中相同工具自动允许
3. **跨 agent 生效**——子 agent 也自动允许

这通过 `AppState` 的共享实现：

```typescript
// 子 agent 的 AppState 路由到根 store
// 用户在子 agent 的弹框中点了 "Always Allow"
// → 更新根 store
// → 父 agent 和所有其他子 agent 立即生效
```

### 4.2 权限规则的写入

"Always Allow" 不仅更新内存状态，还会**持久化**到配置文件：

```
用户点击 "Always Allow for Read"
  → 更新 AppState（内存）
  → 写入 ~/.claude/settings.json（磁盘）
  → 下次启动 Claude Code 时自动加载
```

---

## 5. 沙箱集成

### 5.1 何时使用沙箱

Claude Code 支持在沙箱环境（如 Docker 容器或 macOS sandbox）中执行 Bash 命令。沙箱中的命令有不同的权限策略：

```typescript
// 沙箱中的 Bash 命令
if (shouldUseSandbox()) {
  // 沙箱提供了隔离保证
  // → 可以放宽权限要求
  // → 某些通常需要确认的命令可以自动允许
}
```

### 5.2 沙箱 vs 权限的关系

沙箱和权限系统是**互补**的：

- 权限系统是**意图控制**——"这个操作是否符合用户意图？"
- 沙箱是**影响控制**——"即使操作失控，也不会损害主系统"

在沙箱中，权限系统可以更宽松，因为即使误判（允许了不安全的操作），沙箱限制了爆炸半径。

---

## 6. Shell 规则匹配

### 6.1 路径模式

权限规则可以使用路径模式来限制工具的作用范围：

```json
// .claude/settings.json
{
  "permissions": {
    "allow": [
      "Edit:src/**",          // 允许编辑 src 目录下的文件
      "Bash:npm test",        // 允许运行 npm test
      "Bash:git *"            // 允许所有 git 命令
    ],
    "deny": [
      "Bash:rm -rf *",        // 禁止 rm -rf
      "Edit:/etc/**"          // 禁止编辑系统目录
    ]
  }
}
```

### 6.2 Shell 命令匹配

对于 Bash 工具，规则匹配需要理解 shell 语法：

```
规则: "Bash:npm *"
命令: "npm install express"      → 匹配 ✓
命令: "npm run test && echo ok"  → 匹配 ✓（npm 部分匹配）
命令: "npx create-react-app"     → 不匹配 ✗（npx ≠ npm）
```

`shellRuleMatching.ts` 实现了这种匹配，它需要处理：
- 管道（`|`）
- 链式命令（`&&`、`||`）
- 子 shell（`$()`）
- 引号内的空格
- 环境变量

### 6.3 阴影规则检测

`shadowedRuleDetection.ts` 检测规则冲突——比如一个 allow 规则被一个更高优先级的 deny 规则"遮挡"了：

```
allow: "Bash:npm *"     ← 这条被遮挡了
deny:  "Bash:*"         ← 因为这条禁止了所有 Bash
```

检测到阴影规则时，会发出警告，帮助用户理解为什么某个操作仍然被拒绝。

---

## 7. 与其他系统的对比

### 7.1 VS Code Extension Permissions

VS Code 扩展使用静态声明（`package.json` 中的 `permissions`），在安装时一次性授权。Claude Code 的权限是**动态的、运行时的、可撤回的**。

### 7.2 Docker-based Sandboxing

一些 agent 框架（如 E2B、Open Interpreter）使用 Docker 容器作为唯一的安全手段。Claude Code 的方法是**分层的**——权限系统 + 可选沙箱，提供了更细粒度的控制。

### 7.3 Cursor/Windsurf 的权限

Cursor 的权限模型相对简单——"Accept" 或 "Reject" 编辑。Claude Code 的权限覆盖了更广的范围（文件操作、Bash 命令、网络请求、子 agent），并提供了更多的控制维度（模式、规则、路径模式、分类器）。

---

## 8. 总结

Claude Code 的权限系统体现了一个关键洞察：

> **安全不是一个二元选择（安全/不安全），而是一个多维度的权衡（速度/安全/便利/控制）。**

- `default` 模式：最安全，最慢
- `auto` 模式：平衡安全和速度（分类器 + 超时回退）
- `bypassPermissions` 模式：最快，最不安全

用户可以根据场景选择合适的点。而框架确保了即使在最宽松的模式下，Policy Limits 的强制规则仍然生效——这是企业安全的底线。
