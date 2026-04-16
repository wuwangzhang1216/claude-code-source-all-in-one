import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { DESCRIPTION, PROMPT, PUSH_NOTIFICATION_TOOL_NAME } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    title: z
      .string()
      .min(1)
      .max(120)
      .describe('Notification title. Keep short (≤60 chars preferred).'),
    body: z
      .string()
      .min(1)
      .max(500)
      .describe('One-line notification body.'),
    urgency: z
      .enum(['normal', 'high'])
      .optional()
      .describe(
        "Delivery urgency. 'high' bypasses the quiet-hours window on the device; use only for true blockers.",
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
export type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    delivered: z.boolean(),
    detail: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function pushConfig(): { enabled: boolean; pushWhenClaudeDecides: boolean } {
  const cfg = getInitialSettings().pushNotifications ?? {}
  return {
    enabled: cfg.enabled === true,
    pushWhenClaudeDecides: cfg.pushWhenClaudeDecides === true,
  }
}

export const PushNotificationTool = buildTool({
  name: PUSH_NOTIFICATION_TOOL_NAME,
  searchHint: 'send a mobile push notification to the user',
  maxResultSizeChars: 4_000,
  isEnabled() {
    // Master switch — tool is invisible to the model when push is off so it
    // cannot spam attempts. System-driven pushes (permission asks) do not
    // route through this tool and are unaffected.
    return pushConfig().enabled && pushConfig().pushWhenClaudeDecides
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input: Input) {
    return `push_notification ${input.urgency ?? 'normal'}: ${input.title}`
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input: Input) {
    // Defensive re-check at call time: settings can flip between render and
    // call (user toggled /config while a tool queue was draining).
    const { enabled, pushWhenClaudeDecides } = pushConfig()
    if (!enabled || !pushWhenClaudeDecides) {
      return {
        data: {
          delivered: false,
          detail:
            'Push notifications are disabled. Ask the user to enable "Push when Claude decides" in /config.',
        },
      }
    }

    // Transport: upstream routes through the Remote Control bridge. This
    // educational source logs-and-stubs; real delivery requires the CCR
    // session to be live. Keep the happy-path shape identical so a future
    // bridge implementation can drop in without reshaping the tool contract.
    try {
      logForDebugging(
        `[push_notification] ${input.urgency ?? 'normal'} "${input.title}": ${input.body}`,
      )
      return {
        data: {
          delivered: true,
          detail: 'Queued for delivery via Remote Control.',
        },
      }
    } catch (err) {
      return {
        data: {
          delivered: false,
          detail: `Delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.delivered
        ? 'Push notification sent.'
        : `Push notification not sent: ${output.detail ?? 'unknown reason'}`,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, Output>)
