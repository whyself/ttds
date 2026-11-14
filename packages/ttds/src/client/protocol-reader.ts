import type { ServerRealtimeFrame } from '../shared/protocol.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(field => typeof value[field] === 'string')
}

function numbers(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(field => typeof value[field] === 'number' && Number.isFinite(value[field]))
}

function booleans(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(field => typeof value[field] === 'boolean')
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value)
}

function confirmation(value: unknown): boolean {
  return record(value) && strings(value, ['confirmationId', 'toolName', 'summary'])
    && oneOf(value.mode, ['ui']) && numbers(value, ['createdAtMs'])
}

function config(value: unknown): boolean {
  if (!record(value) || typeof value.provider !== 'string') return false
  const { qwenRealtime: qwen, voice, tools, hooks } = value
  if (!record(qwen) || !record(voice) || !record(tools) || !record(hooks)) return false
  return strings(qwen, ['workspaceId', 'endpointUrl', 'model', 'voice'])
    && booleans(qwen, ['hasApiKey']) && qwen.enableSearch === false && numbers(qwen, ['maxHistoryTurns'])
    && oneOf(qwen.apiKeySource, ['config', 'env', 'none'])
    && oneOf(voice.turnDetection, ['smart_turn_v2', 'smart_turn', 'server_vad', 'push_to_talk'])
    && strings(voice, ['customInstructions', 'mergedInstructions', 'inputDeviceId', 'outputDeviceId'])
    && booleans(voice, ['startMuted'])
    && numbers(voice, ['threshold', 'silenceDurationMs'])
    && booleans(tools, ['enableReadTools', 'enableSearchTool']) && numbers(tools, ['toolTimeoutMs'])
    && oneOf(tools.writeConfirmation, ['auto', 'ui'])
    && numbers(hooks, ['quietGraceMs'])
    && booleans(hooks, ['onTurnSettled', 'onToolApproval', 'onAgentError', 'onShellExitError', 'onSubagentSettled'])
}

function snapshot(value: unknown): boolean {
  if (!record(value)) return false
  return (value.supervisorSessionId === null || typeof value.supervisorSessionId === 'string')
    && (value.statusReason === null || typeof value.statusReason === 'string')
    && oneOf(value.phase, ['idle', 'connecting', 'listening', 'thinking', 'speaking', 'error'])
    && numbers(value, ['connectionEpoch', 'inputAdmissionSeq', 'pendingToolCount'])
    && booleans(value, ['providerReady', 'muted'])
    && Array.isArray(value.pendingConfirmations) && value.pendingConfirmations.every(confirmation)
    && config(value.config)
}

function feed(value: unknown): boolean {
  return record(value) && strings(value, ['id', 'text']) && numbers(value, ['timestampMs'])
    && oneOf(value.kind, ['transcript_user', 'transcript_assistant', 'tool_call', 'hook_event', 'confirmation', 'diagnostic'])
    && (value.detail === undefined || typeof value.detail === 'string')
    && (value.confirmation === undefined || confirmation(value.confirmation))
}

/**
 * Validate untrusted WebSocket JSON before it reaches media resources or React state.
 * @param data - browser WebSocket message data.
 * @returns a complete known server frame; throws when the payload violates the wire protocol.
 */
export function readServerRealtimeFrame(data: unknown): ServerRealtimeFrame {
  if (typeof data !== 'string') throw new Error('ttds: expected a JSON realtime frame')
  const frame: unknown = JSON.parse(data)
  if (!record(frame)) throw new Error('ttds: expected a realtime frame object')
  let valid: boolean
  switch (frame.type) {
    case 'state.snapshot': valid = snapshot(frame.snapshot); break
    case 'audio.delta':
      valid = numbers(frame, ['audioSeq']) && strings(frame, ['responseId', 'pcm24kBase64'])
        && Number.isInteger(frame.audioSeq) && Number(frame.audioSeq) >= 0
      break
    case 'audio.clear': valid = oneOf(frame.reason, ['barge_in', 'interrupted', 'session_closed']); break
    case 'transcript':
      valid = oneOf(frame.role, ['user', 'assistant']) && strings(frame, ['text', 'itemId']) && typeof frame.final === 'boolean'
      break
    case 'feed.item': valid = feed(frame.item); break
    case 'error': valid = strings(frame, ['code', 'message']); break
    case 'pong': valid = numbers(frame, ['timestampMs']); break
    // Network messages are open input; unknown discriminants are rejected before entering the closed union.
    default: valid = false
  }
  if (!valid) throw new Error('ttds: invalid realtime frame')
  return frame as ServerRealtimeFrame
}
