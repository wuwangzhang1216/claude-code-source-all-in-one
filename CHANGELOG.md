# Changelog

All notable changes tracked here. This is a local/educational source mirror of Claude Code, not an official release stream.

## 2.1.94 — April 7, 2026

Applies the user-facing, tractable subset of the upstream 2.1.94 changelog.

### Applied in this local source tree

- Changed default effort level from `medium` to `high` (i.e. `undefined` in the API) for API-key, Bedrock/Vertex/Foundry, Team, and Enterprise users on Opus 4.6. Pro subscribers remain at `medium`.
- Added `sessionTitle` field to `UserPromptSubmit` hook specific output, allowing hooks to set the session title.
- `--resume` now resumes sessions from other worktrees of the same repo directly for all users (previously gated to internal users only).
- Fixed CJK and other multibyte text being corrupted with U+FFFD in `stream-json` stdout guard when chunk boundaries split a UTF-8 sequence — now uses `TextDecoder` with streaming mode.
- Added `FORCE_HYPERLINK` environment variable support in terminal hyperlink detection, so setting it via `settings.json` env is respected.
- Plugin skills declared via `"skills": ["./"]` now use the skill's frontmatter `name` for the invocation name instead of the directory basename, giving a stable name across install methods.

### Not applied (upstream-only internal fixes)

- `CLAUDE_CODE_USE_MANTLE` Bedrock Mantle provider support
- Slack MCP compact `#channel` header with clickable link
- `keep-coding-instructions` frontmatter field for plugin output styles
- 429 rate-limit Retry-After agent stuck fix
- Console login macOS keychain locked/out-of-sync fix
- Plugin hooks YAML frontmatter / `CLAUDE_PLUGIN_ROOT` resolution fixes
- SDK/print mode partial assistant response preservation on interrupt
- Scrollback repeated diff / blank pages in long sessions
- Multiline prompt indentation under `❯` caret
- Shift+Space inserting literal "space" in search inputs
- Hyperlinks opening two browser tabs in tmux + xterm.js terminals
- Alt-screen ghost lines from content height changes mid-scroll
- Native terminal cursor not tracking selected tab in dialogs
- Bedrock Sonnet 3.5 v2 inference profile ID fix
- VSCode cold-open subprocess reduction, dropdown menu fix, settings.json parse warning banner

---

## 2.1.92 — April 4, 2026

Applies the user-facing, tractable subset of the upstream 2.1.92 changelog.

### Applied in this local source tree

- Added `forceRemoteSettingsRefresh` policy setting: when true in managed/policy settings, the CLI blocks startup until remote managed settings are freshly fetched and exits fail-closed if the fetch fails. Useful for managed deployments where stale cached policy is unacceptable.
- Remote Control session names now use the machine hostname as the default prefix (e.g. `myhost-graceful-unicorn`) instead of the hardcoded `remote-control-` prefix. Overridable via the `CLAUDE_CODE_REMOTE_CONTROL_SESSION_NAME_PREFIX` environment variable.
- Removed `/tag` command (sessions are still tagged via session metadata but the interactive slash command is gone).
- Removed `/vim` command (toggle vim mode via `/config` → Editor mode instead).
- Bumped local source version to `2.1.92` (from `2.1.91`).

### Not applied (upstream-only internal fixes)

Skipped items that require forensic access to internals not faithfully present in the deobfuscated source, or are platform-specific infra fixes:

- Interactive Bedrock setup wizard from the login screen
- `/cost` per-model + cache-hit breakdown for subscription users
- `/release-notes` interactive version picker
- Pro-user prompt-cache-expired footer hint
- Subagent spawning tmux pane-count failure after window kills/renumbers
- Prompt-type Stop hooks with `ok:false` from small fast model, `preventContinuation:true` semantics
- Tool input validation for streamed JSON-encoded array/object fields
- API 400 on whitespace-only thinking text blocks
- Accidental feedback-survey submissions from auto-pilot keypresses
- Misleading "esc to interrupt" hint alongside "esc to clear" with selection active
- Homebrew update prompts (stable vs @latest channel)
- `ctrl+e` jumping past end-of-line in multiline prompts
- Duplicate message at two scroll positions (DEC 2026 terminals: iTerm2, Ghostty)
- Idle-return `/clear to save X tokens` showing cumulative instead of current-context tokens
- Plugin MCP servers stuck "connecting" when duplicating an unauthenticated claude.ai connector
- Write tool diff-computation 60% speedup for large files with tabs/`&`/`$`
- Linux sandbox `apply-seccomp` helper in npm + native builds (unix-socket blocking)

---

## 2.1.91 — April 2, 2026

Applies the user-facing, tractable subset of the upstream 2.1.90 and 2.1.91 changelogs in a single bump.

### Applied in this local source tree

From upstream 2.1.90:

- Added `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE`: when set, a failed `git pull` during marketplace refresh keeps the existing cache instead of wiping and re-cloning. Useful for offline/restricted environments.
- Added `.husky` to the protected-directories list for `acceptEdits` mode (same protection as `.git`, `.vscode`, `.idea`, `.claude`).
- Removed `Get-DnsClientCache` cmdlet and `ipconfig /displaydns` flag from the PowerShell tool's auto-allow list (DNS cache privacy). Users who need these can add an explicit allow rule.
- `/resume` picker now filters out sessions created by `claude -p` or SDK transports (`sdk-cli`, `sdk-ts`, `sdk-py`) based on the session's stored `entrypoint`.

From upstream 2.1.91:

- MCP tool-result persistence override via `_meta["anthropic/maxResultSizeChars"]`: servers can annotate individual tools (e.g. DB-schema inspectors) to allow results up to **500K** characters to pass through without being persisted to a preview file.
- Added `disableSkillShellExecution` setting to disable inline shell execution (```! blocks and `!\`…\`` inline) in skills, custom slash commands, and plugin commands.
- `claude-cli://open?q=` deep links now accept URL-encoded newlines (`%0A` / `%0D`) for multi-line prompts. cmd.exe and AppleScript escape boundaries were updated to handle newlines safely (cmd.exe strips LF/CR to a space, AppleScript escapes to `\n`/`\r`).
- `/feedback` (and its alias `/bug`) stays visible in the slash menu when disabled; invoking it now prints an explanation (third-party provider, env var, policy, etc.) instead of silently disappearing.
- Bumped local source version to `2.1.91` (from `2.1.89`).

### Not applied (upstream-only internal fixes)

Skipped items that require forensic access to internals not faithfully present in the deobfuscated source, or are platform-specific infra fixes:

- `/powerup` interactive lessons
- Rate-limit dialog auto-reopen loop
- `--resume` prompt-cache miss regression (v2.1.69+)
- Edit/Write race with PostToolUse format-on-save hooks
- PreToolUse hooks emitting JSON to stdout + exit code 2 not blocking
- Collapsed search/read summary duplicated in scrollback on CLAUDE.md auto-load
- Auto-mode boundary honor-ing ("don't push", "wait for X")
- Click-to-expand hover colors on light terminal themes
- UI crash on malformed tool input, header disappearance on scroll, PowerShell tool hardening (trailing `&`, `-ErrorAction Break`, archive TOCTOU, parse-fail fallback)
- JSON.stringify MCP schema per turn, SSE linear-time streaming, long-session transcript write quadratic, /resume all-projects parallel load
- Transcript chain breaks on `--resume` with silent write failures
- `cmd+delete` on iTerm2/kitty/WezTerm/Ghostty/Windows Terminal
- Plan mode container restart recovery, `permissions.defaultMode: "auto"` JSON-schema validation, Windows version cleanup protecting rollback copy
- Improved `/claude-api` skill guidance content, Bun.stripANSI perf, shorter `old_string` anchors in Edit tool output
- Plugins shipping executables under `bin/` (requires plugin-system changes beyond this pass)

See upstream Anthropic Claude Code 2.1.90 / 2.1.91 release notes for full details.

## 2.1.89 — April 1, 2026

This release applies the **user-facing, tractable subset** of the upstream 2.1.89 changelog. See "Applied" and "Not applied (upstream-only)" sections below.

### Applied in this local source tree

- Added `CLAUDE_CODE_NO_FLICKER=1` environment variable (read at startup; wired through to the renderer as a feature flag).
- Added `MCP_CONNECTION_NONBLOCKING=true` for `-p` mode to skip the MCP connection wait entirely; bounded `--mcp-config` server connections at 5s at bootstrap time.
- Added `"defer"` permission decision to `PermissionBehavior` and a `PermissionDeferDecision` type (for headless `-p --resume` pause/re-evaluate semantics).
- Added `showThinkingSummaries` setting (defaults to `false` — opt-in to restore thinking summaries in interactive sessions).
- Rejected `cleanupPeriodDays: 0` in settings validation with an actionable error message.
- Fixed `Edit`/`Write` tools doubling CRLF on Windows and stripping Markdown hard line breaks (two trailing spaces).
- Improved collapsed tool summary to show "Listed N directories" for `ls`/`tree`/`du` instead of "Read N files".
- Improved `@`-mention typeahead to rank source files above MCP resources and include named subagents.
- Image paste no longer inserts a trailing space.
- Preserved task notifications when backgrounding a running command with Ctrl+B.
- `/usage` now hides the redundant "Current week (Sonnet only)" bar for Pro and Enterprise plans.
- `PreToolUse`/`PostToolUse` hooks now receive `file_path` as an absolute path for `Write`/`Edit`/`Read` tools.
- Bumped local source version to `2.1.89` (from `2.1.88`).

### Not applied (upstream-only internal fixes)

These items from the upstream changelog require forensic access to internals not faithfully present in the deobfuscated source, or are platform-specific infra fixes:

- Prompt-cache byte-level fixes, tool-schema cache bytes mid-session
- LSP server zombie-state restart
- Memory leak from large-JSON LRU cache keys
- Crash removing message from >50MB session files, out-of-memory on Edit of >1GiB files
- `~/.claude/history.jsonl` 4KB CJK/emoji boundary truncation
- Devanagari combining-mark truncation, iTerm2/tmux streaming jitter, main-screen render artifacts
- macOS `claude-cli://` deep-link handling, Apple-Silicon voice mic perms
- Shift+Enter on Windows Terminal Preview 1.25, PowerShell 5.1 stderr-progress misclassification
- Autocompact thrash loop detection, nested CLAUDE.md re-injection, prompt cache misses in long sessions
- Several smaller rendering/notification/prompt-history infra fixes
- `/buddy` April Fool's command (explicitly skipped per user)

See upstream Anthropic Claude Code 2.1.89 release notes for full details.
