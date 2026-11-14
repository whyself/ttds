import type { ReactNode } from 'react'
import { FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } from '@deepseek-ai/dsh-client-ui-primitives'
import { useTtdsState, voicePhase, type TtdsUiProps } from './ui-state.ts'
import css from './VoiceStage.module.css'

/**
 * Render the whale voice mark and active state dot inside the host sidebar entry.
 * @param props - controller, translator and host-requested icon geometry.
 * @returns sidebar icon aligned with native 16px panel entries.
 */
export function SidebarPanelIcon(props: TtdsUiProps & { size: number; active: boolean }): ReactNode {
  const state = useTtdsState(props.controller)
  const phase = voicePhase(state)
  const sessionActive = state.connection !== 'disconnected' || (state.snapshot?.pendingConfirmations.length ?? 0) > 0
  return (
    <span
      className={css.sidebarIcon}
      data-phase={phase}
      data-active={sessionActive ? 'true' : undefined}
    >
      <svg
        width={props.size}
        height={props.size}
        viewBox={`-1 -3.5 ${FISH_LOGO_VIEWBOX.width + 2} ${FISH_LOGO_VIEWBOX.width + 2}`}
        fill="none"
        aria-hidden="true"
      >
        <path d={FISH_LOGO_PATH} fill="currentColor" />
      </svg>
      {sessionActive && <span className={css.activityDot} aria-label={props.t(`phase.${phase}`)} />}
    </span>
  )
}
