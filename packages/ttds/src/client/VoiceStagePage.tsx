import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button,
  IconCheckOutlineMedium,
  IconFlatListOutlineRegular,
  IconMicrophoneOutlineMedium,
  IconPauseOutlineMedium,
  IconSendOutlineMedium,
  IconSettingsOutlineRegular,
  IconStopFillMedium,
  Tooltip,
  observeComposition,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { VoiceFeedItem, VoiceFeedItemKind } from '../shared/protocol.ts'
import { assertNever } from '../shared/assert-never.ts'
import { useTtdsState, voicePhase, type TtdsUiProps } from './ui-state.ts'
import { VoiceRings } from './VoiceRings.tsx'
import css from './VoiceStage.module.css'

function MicMutedIcon(): ReactNode {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
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

function feedDotClass(kind: VoiceFeedItemKind): string | undefined {
  switch (kind) {
    case 'transcript_user':
      return undefined
    case 'transcript_assistant':
    case 'tool_call':
      return css.dotPrimary
    case 'hook_event':
    case 'confirmation':
      return css.dotWarn
    case 'diagnostic':
      return css.dotMuted
    default:
      return assertNever(kind)
  }
}

function FeedEntryRow(props: { item: VoiceFeedItem }): ReactNode {
  const { item } = props
  const dot = feedDotClass(item.kind)
  const isMono = item.kind === 'tool_call'
  return (
    <div className={css.feedItem} data-kind={item.kind}>
      <div className={css.feedLead}>
        {dot !== undefined ? <span className={clsx(css.feedDot, dot)} aria-hidden="true" /> : <span className={css.feedDotSpacer} aria-hidden="true" />}
        <span
          className={clsx(
            css.feedText,
            isMono && css.feedMono,
            item.kind === 'transcript_assistant' && css.feedPrimaryText,
            item.kind === 'transcript_user' && css.feedUserText,
          )}
        >
          {item.text}
        </span>
      </div>
      {item.detail !== undefined && item.detail !== '' && (
        <p className={css.feedDetail}>{item.detail}</p>
      )}
    </div>
  )
}

/**
 * Render the minimalist global voice stage without owning network or media lifetime.
 * @param props - plugin-owned controller and namespace translator.
 * @returns the hollow 4-state whale core, borderless fading event stream, confirmations, and pure-icon dock.
 */
export function VoiceStagePage(props: TtdsUiProps): ReactNode {
  const { controller, t } = props
  const state = useTtdsState(controller)
  const phase = voicePhase(state)
  const connected = state.connection !== 'disconnected'
  const [text, setText] = useState('')
  const [feedOpen, setFeedOpen] = useState(true)
  const guard = useRef<ReturnType<typeof observeComposition>>()
  const feedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const observer = observeComposition(document)
    guard.current = observer
    return () => {
      observer.dispose()
      guard.current = undefined
    }
  }, [])

  useEffect(() => {
    const el = feedRef.current
    if (el === null) return
    const reduced = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [state.feed, feedOpen])

  const send = (): void => {
    if (controller.sendText(text)) setText('')
  }

  const turnDetection = state.snapshot?.config.voice.turnDetection ?? state.hostConfig.turnDetection
  const needsSetup = state.snapshot !== null
    ? !state.snapshot.providerReady
    : (state.hostConfigReady && !state.hostConfig.hasConfigCredential)

  let latestTranscript: VoiceFeedItem | undefined
  for (let i = state.feed.length - 1; i >= 0; i -= 1) {
    const candidate = state.feed[i]
    if (candidate !== undefined && (candidate.kind === 'transcript_assistant' || candidate.kind === 'transcript_user')) {
      latestTranscript = candidate
      break
    }
  }

  const uiConfirmations = state.snapshot?.pendingConfirmations ?? []
  const feedToggleLabel = feedOpen ? t('action.feedHide') : t('action.feedShow')
  const settingsLabel = t('action.settings')
  const micButtonLabel = !connected
    ? t('action.start')
    : state.muted ? t('action.unmute') : t('action.mute')
  const stopLabel = t('action.stop')
  const interruptLabel = t('action.interrupt')
  const commitLabel = t('settings.commit')
  const sendLabel = t('action.send')
  const inputPlaceholder = t('stage.input')

  return (
    <main className={css.stage} aria-label={t('app.name')}>
      <header className={css.topBar}>
        <div className={css.topActions}>
          <Tooltip label={feedToggleLabel} side="bottom">
            <button
              type="button"
              className={clsx(css.topIconButton, feedOpen && css.topIconActive)}
              aria-label={feedToggleLabel}
              aria-pressed={feedOpen}
              onClick={() => { setFeedOpen(!feedOpen) }}
            >
              <IconFlatListOutlineRegular size={16} />
            </button>
          </Tooltip>
          <Tooltip label={settingsLabel} side="bottom">
            <button
              type="button"
              className={css.topIconButton}
              aria-label={settingsLabel}
              onClick={() => { controller.openPluginSettings() }}
            >
              <IconSettingsOutlineRegular size={16} />
            </button>
          </Tooltip>
        </div>
      </header>

      <div className={css.stageBody}>
        <div className={css.centerColumn}>
          <VoiceRings phase={phase} muted={state.muted} />
          <div className={css.captionStack}>
            {latestTranscript !== undefined && (
              <p className={css.liveCaption}>{latestTranscript.text}</p>
            )}
            <p className={css.phaseStatus} role="status">
              {uiConfirmations.length > 0 ? t('phase.confirming') : t(`phase.${phase}`)}
            </p>
            {needsSetup && (
              <button
                type="button"
                className={css.setupPill}
                onClick={() => { controller.openPluginSettings() }}
              >
                <span>{t('stage.setup')}</span>
              </button>
            )}
            {state.error !== null && (
              <p className={css.errorBanner} role="alert">{state.error}</p>
            )}
          </div>
        </div>

        {feedOpen && (
          <aside className={css.streamAside}>
            <div ref={feedRef} className={css.feed} role="log" aria-label={t('stage.feed')}>
              {state.feed.length === 0 && (
                <p className={css.empty}>{t('stage.empty')}</p>
              )}
              {state.feed.map(item => (
                <FeedEntryRow key={item.id} item={item} />
              ))}
            </div>
          </aside>
        )}
      </div>

      <footer className={css.bottomArea}>
        {uiConfirmations.length > 0 && (
          <div className={css.confirmations}>
            {uiConfirmations.map(item => (
              <div className={css.confirmation} key={item.confirmationId}>
                <span className={css.summary}>{item.summary}</span>
                <div className={css.confirmationActions}>
                  <Button size="sm" onClick={() => { controller.respondConfirmation(item.confirmationId, true) }}>
                    {t('action.allow')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { controller.respondConfirmation(item.confirmationId, false) }}>
                    {t('action.cancel')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className={css.dock}>
          <Tooltip label={micButtonLabel} side="top">
            <button
              type="button"
              className={clsx(
                css.micButton,
                (!connected || !state.muted) ? css.micPrimary : css.micMuted,
              )}
              aria-label={micButtonLabel}
              aria-pressed={connected ? !state.muted : undefined}
              onClick={() => {
                if (!connected) controller.start()
                else controller.toggleMute()
              }}
            >
              {connected && state.muted ? <MicMutedIcon /> : <IconMicrophoneOutlineMedium size={16} />}
            </button>
          </Tooltip>

          <div className={css.dockInputPill}>
            <input
              type="text"
              className={css.dockInput}
              value={text}
              placeholder={inputPlaceholder}
              aria-label={inputPlaceholder}
              onChange={(event) => { setText(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !guard.current?.guards(event.nativeEvent)) {
                  event.preventDefault()
                  send()
                }
              }}
            />
            {text.trim() !== '' && (
              <button
                type="button"
                className={css.sendIconButton}
                aria-label={sendLabel}
                onClick={send}
              >
                <IconSendOutlineMedium size={13} />
              </button>
            )}
          </div>

          {connected && phase === 'speaking' && (
            <Tooltip label={interruptLabel} side="top">
              <button
                type="button"
                className={css.auxCircleButton}
                aria-label={interruptLabel}
                onClick={() => { controller.interrupt() }}
              >
                <IconPauseOutlineMedium size={15} />
              </button>
            </Tooltip>
          )}

          {connected && turnDetection === 'push_to_talk' && !state.muted && (
            <Tooltip label={commitLabel} side="top">
              <button
                type="button"
                className={css.auxCircleButton}
                aria-label={commitLabel}
                onClick={() => { controller.commitAudio() }}
              >
                <IconCheckOutlineMedium size={15} />
              </button>
            </Tooltip>
          )}

          {connected && (
            <Tooltip label={stopLabel} side="top">
              <button
                type="button"
                className={css.hangupButton}
                aria-label={stopLabel}
                onClick={() => { void controller.stop() }}
              >
                <IconStopFillMedium size={13} />
              </button>
            </Tooltip>
          )}
        </div>
      </footer>
    </main>
  )
}
