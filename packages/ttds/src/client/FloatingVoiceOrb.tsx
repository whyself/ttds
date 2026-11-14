import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button,
  IconMicrophoneOutlineMedium,
  IconRightUpOutlineMedium,
  IconStopFillMedium,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { VoiceRings } from './VoiceRings.tsx'
import { useTtdsState, voicePhase, type TtdsUiProps } from './ui-state.ts'
import css from './FloatingVoiceOrb.module.css'

type DockedEdge = 'left' | 'right' | 'top' | null

interface Position {
  x: number
  y: number
  docked: DockedEdge
}

const ORB_SIZE = 44
const CAPSULE_WIDTH = 162
const DOCK_THRESHOLD = 28

function readTopClearance(): number {
  const raw = getComputedStyle(document.body).getPropertyValue('--dsh-frame-overlay-top')
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function clampPosition(position: Position, width: number): Position {
  const topClearance = readTopClearance()
  const minMargin = 8
  const minTop = Math.max(minMargin, topClearance + minMargin)
  const maxRight = Math.max(minMargin, window.innerWidth - width - minMargin)
  const maxBottom = Math.max(minTop, window.innerHeight - ORB_SIZE - minMargin)

  if (position.docked === 'left') {
    return {
      x: 0,
      y: Math.max(minTop, Math.min(maxBottom, position.y)),
      docked: 'left',
    }
  }
  if (position.docked === 'right') {
    return {
      x: Math.max(0, window.innerWidth - ORB_SIZE),
      y: Math.max(minTop, Math.min(maxBottom, position.y)),
      docked: 'right',
    }
  }
  if (position.docked === 'top') {
    return {
      x: Math.max(minMargin, Math.min(Math.max(minMargin, window.innerWidth - ORB_SIZE - minMargin), position.x)),
      y: topClearance,
      docked: 'top',
    }
  }
  return {
    x: Math.max(minMargin, Math.min(maxRight, position.x)),
    y: Math.max(minTop, Math.min(maxBottom, position.y)),
    docked: null,
  }
}

function OrbMutedMicIcon(): ReactNode {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6 3.5a2 2 0 1 1 4 0v3.8a2 2 0 0 1-.26.99M4.2 7.4a3.8 3.8 0 0 0 6.32 2.83M8 11.2v2.3M5.8 13.5h4.4M2.5 2.5l11 11"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Render the cross-session morphing acoustic capsule (162x44) and edge-tucked orb (44x44).
 * @param props - shared controller, translator and current global main-panel identity.
 * @returns floating voice companion outside the main voice stage while a session is active.
 */
export function FloatingVoiceOrb(props: TtdsUiProps & { activePanelId: string | null }): ReactNode {
  const { controller, t } = props
  const state = useTtdsState(controller)
  const [expanded, setExpanded] = useState(false)
  const [position, setPosition] = useState<Position>(() => ({
    x: Math.max(8, window.innerWidth - 68),
    y: Math.max(8, window.innerHeight - 104),
    docked: null,
  }))
  const drag = useRef<{ pointer: number; x: number; y: number; origin: Position; moved: boolean }>()
  const suppressClickUntil = useRef(0)
  const width = expanded ? CAPSULE_WIDTH : ORB_SIZE

  useEffect(() => {
    const resize = (): void => {
      setPosition(previous => clampPosition(previous, expanded ? CAPSULE_WIDTH : ORB_SIZE))
    }
    resize()
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize) }
  }, [expanded])

  if (props.activePanelId === 'ttds' || state.connection === 'disconnected') return null

  const move = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = drag.current
    if (current === undefined || current.pointer !== event.pointerId) return
    const dx = event.clientX - current.x
    const dy = event.clientY - current.y
    current.moved ||= Math.abs(dx) + Math.abs(dy) > 4
    if (current.moved) {
      setPosition(clampPosition({
        x: current.origin.x + dx,
        y: current.origin.y + dy,
        docked: null,
      }, width))
    }
  }

  const release = (event: PointerEvent<HTMLButtonElement>, cancelled: boolean): void => {
    const current = drag.current
    if (current === undefined || current.pointer !== event.pointerId) return
    drag.current = undefined
    suppressClickUntil.current = current.moved && !cancelled ? Date.now() + 120 : 0
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!current.moved || cancelled) return
    const rawX = current.origin.x + event.clientX - current.x
    const rawY = current.origin.y + event.clientY - current.y
    const topClearance = readTopClearance()
    let side: DockedEdge = null
    if (rawX <= DOCK_THRESHOLD) side = 'left'
    else if (window.innerWidth - rawX - width <= DOCK_THRESHOLD) side = 'right'
    else if (rawY - topClearance <= DOCK_THRESHOLD) side = 'top'
    if (side !== null) setExpanded(false)
    setPosition(clampPosition(
      { x: rawX, y: rawY, docked: side },
      side === null ? width : ORB_SIZE,
    ))
  }

  const phase = voicePhase(state)
  const headConfirmation = state.snapshot?.pendingConfirmations[0]
  const bubbleAbove = position.y > window.innerHeight * 0.62
  const bubbleAlignRight = position.x > window.innerWidth * 0.5
  const style = { '--ttds-x': `${position.x}px`, '--ttds-y': `${position.y}px` } as CSSProperties
  const handleLabel = expanded ? t('action.collapse') : t('action.expand')
  const muteLabel = state.muted ? t('action.unmute') : t('action.mute')
  const returnLabel = t('action.return')
  const stopLabel = t('action.stop')

  return (
    <aside
      className={clsx(css.orbContainer, expanded && css.expanded)}
      style={style}
      data-docked={headConfirmation === undefined ? (position.docked ?? undefined) : undefined}
      aria-label={t('app.name')}
    >
      <div className={clsx(css.pillSurface, expanded && css.pillExpanded)}>
        <button
          type="button"
          className={css.handle}
          aria-label={handleLabel}
          aria-expanded={expanded}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            suppressClickUntil.current = 0
            drag.current = {
              pointer: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              origin: position,
              moved: false,
            }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={move}
          onPointerUp={(event) => { release(event, false) }}
          onPointerCancel={(event) => { release(event, true) }}
          onClick={() => {
            if (Date.now() < suppressClickUntil.current) {
              suppressClickUntil.current = 0
              return
            }
            const nextExpanded = !expanded
            setExpanded(nextExpanded)
            setPosition(previous => clampPosition(
              { ...previous, docked: null },
              nextExpanded ? CAPSULE_WIDTH : ORB_SIZE,
            ))
          }}
        >
          <VoiceRings phase={phase} muted={state.muted} compact />
        </button>

        {expanded && (
          <div className={css.actions}>
            <Tooltip label={muteLabel} side="bottom">
              <button
                type="button"
                className={clsx(css.iconAction, state.muted && css.iconActionMuted)}
                aria-label={muteLabel}
                aria-pressed={!state.muted}
                onClick={() => { controller.toggleMute() }}
              >
                {state.muted ? <OrbMutedMicIcon /> : <IconMicrophoneOutlineMedium size={14} />}
              </button>
            </Tooltip>

            <Tooltip label={returnLabel} side="bottom">
              <button
                type="button"
                className={css.iconAction}
                aria-label={returnLabel}
                onClick={() => { controller.openVoiceStage() }}
              >
                <IconRightUpOutlineMedium size={14} />
              </button>
            </Tooltip>

            <Tooltip label={stopLabel} side="bottom">
              <button
                type="button"
                className={css.hangupAction}
                aria-label={stopLabel}
                onClick={() => { void controller.stop() }}
              >
                <IconStopFillMedium size={12} />
              </button>
            </Tooltip>
          </div>
        )}
      </div>

      {headConfirmation !== undefined && (
        <div
          className={clsx(
            css.confirmPopover,
            bubbleAbove ? css.popoverAbove : css.popoverBelow,
            bubbleAlignRight ? css.popoverRight : css.popoverLeft,
          )}
        >
          <p className={css.confirmText}>{headConfirmation.summary}</p>
          <div className={css.confirmButtons}>
            <Button size="sm" onClick={() => { controller.respondConfirmation(headConfirmation.confirmationId, true) }}>
              {t('action.allow')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { controller.respondConfirmation(headConfirmation.confirmationId, false) }}>
              {t('action.cancel')}
            </Button>
          </div>
        </div>
      )}
    </aside>
  )
}
