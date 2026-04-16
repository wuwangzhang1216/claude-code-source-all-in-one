import type { LocalCommandCall } from '../../types/command.js'

function parseMode(raw: string): 'on' | 'off' | 'toggle' | null {
  const s = raw.trim().toLowerCase()
  if (s === '' || s === 'toggle') return 'toggle'
  if (s === 'on' || s === 'enable' || s === 'true' || s === '1') return 'on'
  if (s === 'off' || s === 'disable' || s === 'false' || s === '0') return 'off'
  return null
}

export const call: LocalCommandCall = async (args, context) => {
  const parsed = parseMode(args ?? '')
  if (parsed === null) {
    return {
      type: 'text',
      value: `Unknown argument "${args?.trim() ?? ''}". Use /focus, /focus on, or /focus off.`,
    }
  }

  let applied: boolean | null = null
  context.setAppState(prev => {
    const next =
      parsed === 'toggle' ? !prev.isFocusOnly : parsed === 'on'
    applied = next
    if (prev.isFocusOnly === next) return prev
    return { ...prev, isFocusOnly: next }
  })

  return {
    type: 'text',
    value: applied
      ? 'Focus view enabled. The transcript will only show assistant text. Tool calls remain in the full transcript (ctrl+o).'
      : 'Focus view disabled.',
  }
}
