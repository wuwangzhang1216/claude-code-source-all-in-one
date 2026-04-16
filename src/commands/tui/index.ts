import type { Command } from '../../commands.js'

const tui = {
  type: 'local',
  name: 'tui',
  description:
    'Switch terminal UI rendering mode (default or fullscreen alt-screen)',
  argumentHint: '[default|fullscreen]',
  supportsNonInteractive: false,
  load: () => import('./tui.js'),
} satisfies Command

export default tui
