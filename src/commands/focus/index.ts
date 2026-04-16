import type { Command } from '../../commands.js'

const focus = {
  type: 'local',
  name: 'focus',
  description:
    'Toggle focus view — hides tool calls and shows only assistant text',
  argumentHint: '[on|off|toggle]',
  supportsNonInteractive: false,
  load: () => import('./focus.js'),
} satisfies Command

export default focus
