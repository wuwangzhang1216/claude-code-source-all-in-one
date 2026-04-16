export const PUSH_NOTIFICATION_TOOL_NAME = 'push_notification'

export const DESCRIPTION =
  'Send a push notification to the user’s mobile device via Remote Control. Use sparingly — users only want pings for things that genuinely need their attention (long task complete, permission needed, question blocking progress).'

export const PROMPT = `Send a push notification to the user's phone via the linked Remote Control session.

When to use:
- A long-running task has finished and the user is likely not watching the terminal.
- You are blocked on a permission decision the user must make.
- You have a clarifying question that blocks all further progress.

When NOT to use:
- Every turn, or as a status update. Users will disable the tool.
- To confirm trivial successes ("read the file") — only use when the user stepped away.

Requirements:
- The session must be linked to Remote Control (mobile/web).
- The user must have enabled "Push when Claude decides" in /config. If it is off, the tool is unavailable and you should not attempt to call it repeatedly.

Parameters:
- title: short, ≤60 chars, e.g. "Build finished"
- body: one-line summary, ≤140 chars, e.g. "All tests pass. Ready to merge."
- urgency: "normal" (default) or "high" — use "high" only when waiting on the user blocks everything.
`
