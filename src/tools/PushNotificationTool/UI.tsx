import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { Input, Output } from './PushNotificationTool.js'

export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  const title = input.title?.trim() ?? ''
  const urgency = input.urgency ?? 'normal'
  return title ? `${title}${urgency === 'high' ? ' (high)' : ''}` : ''
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  return (
    <MessageResponse>
      <Text>
        {output.delivered ? 'Push sent' : 'Push suppressed'}
        {output.detail ? <Text dimColor> — {output.detail}</Text> : null}
      </Text>
    </MessageResponse>
  )
}
