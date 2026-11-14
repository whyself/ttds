import { useSyncExternalStore } from 'react'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { TtdsClientController, TtdsClientState } from './controller.ts'
import type { TtdsLocaleKey } from './locales.ts'
import type { VoiceTurnPhase } from '../shared/protocol.ts'
import { assertNever } from '../shared/assert-never.ts'

/** Four-state monochrome acoustic visual mode shared by the stage core and floating orb. */
export type AcousticState = 'off' | 'standby' | 'listening' | 'speaking'

/** Controller and localized copy injected into each TTDS slot component. */
export interface TtdsUiProps {
  controller: TtdsClientController
  t: Translate<TtdsLocaleKey>
}

/**
 * Subscribe to the controller with React's external-store protocol.
 * @param controller - plugin-owned controller which outlives every panel.
 * @returns current immutable client snapshot.
 */
export function useTtdsState(controller: TtdsClientController): TtdsClientState {
  return useSyncExternalStore(
    listener => controller.state.subscribe(listener),
    () => controller.state.getSnapshot(),
    () => controller.state.getSnapshot(),
  )
}

/**
 * Resolve local connection status over the last accepted server phase.
 * @param state - current client snapshot.
 * @returns phase shared by stage, navigation indicator and floating rings.
 */
export function voicePhase(state: TtdsClientState): VoiceTurnPhase {
  if (state.connection === 'error') return 'error'
  if (state.connection === 'connecting') return 'connecting'
  return state.snapshot?.phase ?? 'idle'
}

/**
 * Project protocol turn phases and microphone mute state onto the four-state acoustic envelope.
 * @param phase - resolved turn phase.
 * @param muted - whether microphone capture is currently muted.
 * @returns target acoustic visualization state.
 */
export function acousticState(phase: VoiceTurnPhase, muted: boolean): AcousticState {
  switch (phase) {
    case 'idle':
    case 'error':
      return 'off'
    case 'connecting':
    case 'thinking':
      return 'standby'
    case 'listening':
      return muted ? 'standby' : 'listening'
    case 'speaking':
      return 'speaking'
    default:
      return assertNever(phase)
  }
}
