import type { LocalCommandCall } from '../../types/command.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

type TuiMode = 'default' | 'fullscreen'

function parseMode(raw: string): TuiMode | null {
  const s = raw.trim().toLowerCase()
  if (s === '' || s === 'toggle') return null
  if (s === 'full' || s === 'fullscreen' || s === 'on') return 'fullscreen'
  if (s === 'default' || s === 'off' || s === 'normal') return 'default'
  return null
}

export const call: LocalCommandCall = async args => {
  const current = (getInitialSettings().tui as TuiMode | undefined) ?? 'default'
  const raw = (args ?? '').trim()
  const parsed = raw ? parseMode(raw) : null

  // No arg → report current mode. Unknown arg → show usage.
  if (!raw) {
    return {
      type: 'text',
      value: `TUI mode: ${current}. Use /tui fullscreen for flicker-free rendering, /tui default to revert.`,
    }
  }
  if (parsed === null) {
    return {
      type: 'text',
      value: `Unknown TUI mode "${raw}". Expected "default" or "fullscreen".`,
    }
  }
  if (parsed === current) {
    return {
      type: 'text',
      value: `TUI mode already "${parsed}".`,
    }
  }
  // Persist in userSettings so the change survives restarts. The
  // isFullscreenEnvEnabled() reader picks this up on next render; env var
  // still wins if explicitly set (see fullscreen.ts).
  updateSettingsForSource('userSettings', { tui: parsed })
  return {
    type: 'text',
    value:
      parsed === 'fullscreen'
        ? 'TUI switched to fullscreen. New messages will render in alt-screen mode on the next redraw.'
        : 'TUI switched to default. Scrollback is back under the terminal\'s control.',
  }
}
