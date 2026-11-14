import { useEffect, useRef, type ReactNode } from 'react'
import clsx from 'clsx'
import { FISH_LOGO_PATH, FISH_LOGO_VIEWBOX } from '@deepseek-ai/dsh-client-ui-primitives'
import type { VoiceTurnPhase } from '../shared/protocol.ts'
import { acousticState, type AcousticState } from './ui-state.ts'
import css from './VoiceStage.module.css'

interface EnvelopeParams {
  baseLen: number
  deltaSpan: number
  innerPush: number
  speed: number
  mist: number
  mistR: number
  alphaMin: number
  alphaSpan: number
  activeMix: number
}

const TARGET_PARAMS: Record<AcousticState, EnvelopeParams> = {
  off: {
    baseLen: 26,
    deltaSpan: 0,
    innerPush: 0,
    speed: 0,
    mist: 0,
    mistR: 132,
    alphaMin: 0.19,
    alphaSpan: 0.08,
    activeMix: 0,
  },
  standby: {
    baseLen: 28,
    deltaSpan: 24,
    innerPush: 2.5,
    speed: 1.0,
    mist: 0.09,
    mistR: 142,
    alphaMin: 0.34,
    alphaSpan: 0.12,
    activeMix: 1,
  },
  listening: {
    baseLen: 32,
    deltaSpan: 62,
    innerPush: 6.3,
    speed: 2.5,
    mist: 0.13,
    mistR: 156,
    alphaMin: 0.42,
    alphaSpan: 0.32,
    activeMix: 1,
  },
  speaking: {
    baseLen: 36,
    deltaSpan: 110,
    innerPush: 12.0,
    speed: 3.4,
    mist: 0.20,
    mistR: 188,
    alphaMin: 0.44,
    alphaSpan: 0.46,
    activeMix: 1,
  },
}

interface ResolvedTokens {
  primary: string
  muted: string
  rail: string
  fallback: string
}

function readHostTokens(element: HTMLElement): ResolvedTokens {
  const computed = getComputedStyle(element)
  return {
    primary: computed.getPropertyValue('--dsw-alias-state-business-primary').trim(),
    muted: computed.getPropertyValue('--dsw-alias-label-tertiary').trim(),
    rail: computed.getPropertyValue('--dsw-alias-border-l2').trim(),
    fallback: computed.color.trim(),
  }
}

function addMistStops(gradient: CanvasGradient, color: string, mist: number): boolean {
  const peakPct = (mist * 100).toFixed(2)
  const midPct = (mist * 44).toFixed(2)
  try {
    gradient.addColorStop(0, `color-mix(in srgb, ${color} ${peakPct}%, transparent)`)
  } catch (_error) {
    // Non-color-mix 2D canvas runtimes fall back to uniform low-alpha fill.
    return false
  }
  gradient.addColorStop(0.56, `color-mix(in srgb, ${color} ${midPct}%, transparent)`)
  gradient.addColorStop(1, 'transparent')
  return true
}

function drawAcousticCore(
  ctx2d: CanvasRenderingContext2D,
  width: number,
  height: number,
  current: EnvelopeParams,
  wavePhase: number,
  tokens: ResolvedTokens,
  compact: boolean,
): void {
  ctx2d.clearRect(0, 0, width, height)
  const scale = Math.min(width, height) / 600
  if (scale <= 0) return
  const cx = width / 2
  const cy = height / 2
  const activeColor = tokens.primary || tokens.fallback
  const offColor = tokens.muted || tokens.fallback
  const strokeColor = current.activeMix >= 0.5 ? activeColor : offColor
  if (strokeColor === '') return

  if (current.mist > 0.003 && activeColor !== '') {
    const rMist = current.mistR * scale
    const gradient = ctx2d.createRadialGradient(cx, cy, 0, cx, cy, rMist)
    ctx2d.save()
    if (addMistStops(gradient, activeColor, current.mist)) {
      ctx2d.fillStyle = gradient
    } else {
      ctx2d.globalAlpha = current.mist * 0.5
      ctx2d.fillStyle = activeColor
    }
    ctx2d.beginPath()
    ctx2d.arc(cx, cy, rMist, 0, Math.PI * 2)
    ctx2d.fill()
    ctx2d.restore()
  }

  if (!compact) {
    const railColor = tokens.rail || offColor
    if (railColor !== '') {
      ctx2d.save()
      ctx2d.strokeStyle = railColor
      ctx2d.globalAlpha = tokens.rail !== '' ? 1 : 0.16
      ctx2d.lineWidth = Math.max(1, 1.4 * scale)
      ctx2d.beginPath()
      ctx2d.arc(cx, cy, 108 * scale, 0, Math.PI * 2)
      ctx2d.stroke()
      ctx2d.restore()
    }
  }

  const count = compact ? 32 : 72
  const baseRadius = compact ? 140 : 122
  const spanScale = compact ? 0.90 : 1
  ctx2d.save()
  ctx2d.lineCap = 'round'
  ctx2d.strokeStyle = strokeColor
  ctx2d.lineWidth = Math.max(1, (compact ? 19.4 : 2.8) * scale)
  for (let i = 0; i < count; i += 1) {
    const theta = (i / count) * Math.PI * 2 - Math.PI / 2
    const env1 = 0.5 + 0.5 * Math.sin(theta * 2 - wavePhase * 1.15)
    const env2 = 0.5 + 0.5 * Math.sin(theta * 3 + wavePhase * 0.85 + 1.1)
    const env3 = 0.5 + 0.5 * Math.cos(theta * 5 - wavePhase * 1.45 + 0.4)
    const wave = 0.46 * env1 + 0.34 * env2 + 0.20 * env3
    const rInner = (baseRadius + current.innerPush * spanScale * wave) * scale
    const length = (current.baseLen + current.deltaSpan * spanScale * (wave ** 1.22)) * scale
    const rOuter = rInner + length
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    ctx2d.globalAlpha = Math.min(0.92, Math.max(0.12, current.alphaMin + current.alphaSpan * wave))
    ctx2d.beginPath()
    ctx2d.moveTo(cx + cos * rInner, cy + sin * rInner)
    ctx2d.lineTo(cx + cos * rOuter, cy + sin * rOuter)
    ctx2d.stroke()
  }
  ctx2d.restore()
}

function closeEnough(a: EnvelopeParams, b: EnvelopeParams): boolean {
  return Math.abs(a.baseLen - b.baseLen) < 0.08
    && Math.abs(a.deltaSpan - b.deltaSpan) < 0.08
    && Math.abs(a.innerPush - b.innerPush) < 0.05
    && Math.abs(a.speed - b.speed) < 0.02
    && Math.abs(a.mist - b.mist) < 0.003
    && Math.abs(a.activeMix - b.activeMix) < 0.02
}

/**
 * Render the hollow four-state radial acoustic core with a steady centered FishLogo.
 * @param props - current voice phase, mute flag, and optional compact orb geometry.
 * @returns monochrome radial needle canvas and centered brand mark.
 */
export function VoiceRings(props: { phase: VoiceTurnPhase; muted?: boolean; compact?: boolean }): ReactNode {
  const compact = props.compact === true
  const acoustic = acousticState(props.phase, props.muted === true)
  const hostRef = useRef<HTMLSpanElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const targetRef = useRef<AcousticState>(acoustic)
  const wakeRef = useRef<(() => void) | null>(null)
  targetRef.current = acoustic

  useEffect(() => {
    wakeRef.current?.()
  }, [acoustic, compact])

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (host === null || canvas === null) return
    let ctx2d: CanvasRenderingContext2D | null = null
    try {
      ctx2d = canvas.getContext('2d')
    } catch (_error) {
      // Non-canvas test environments skip 2D drawing while preserving semantic attributes.
      ctx2d = null
    }
    if (ctx2d === null) return

    let current: EnvelopeParams = { ...TARGET_PARAMS[targetRef.current] }
    let wavePhase = 0.65
    let lastTime = performance.now()
    let rafId = 0
    let running = false
    let tokens = readHostTokens(host)
    const motionQuery = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    let reducedMotion = motionQuery?.matches === true

    const syncCanvasSize = (): void => {
      const cssSize = compact ? 36 : (host.clientWidth > 0 ? host.clientWidth : 300)
      const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1))
      const pixelSize = Math.round(cssSize * dpr)
      if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
        canvas.width = pixelSize
        canvas.height = pixelSize
      }
    }

    const step = (now: number): void => {
      running = false
      const dt = Math.min(0.064, Math.max(0.001, (now - lastTime) / 1000))
      lastTime = now
      const target = TARGET_PARAMS[targetRef.current]
      if (reducedMotion) {
        current = { ...target }
      } else {
        const blend = 1 - Math.exp(-dt * 6.8)
        current = {
          baseLen: current.baseLen + (target.baseLen - current.baseLen) * blend,
          deltaSpan: current.deltaSpan + (target.deltaSpan - current.deltaSpan) * blend,
          innerPush: current.innerPush + (target.innerPush - current.innerPush) * blend,
          speed: current.speed + (target.speed - current.speed) * blend,
          mist: current.mist + (target.mist - current.mist) * blend,
          mistR: current.mistR + (target.mistR - current.mistR) * blend,
          alphaMin: current.alphaMin + (target.alphaMin - current.alphaMin) * blend,
          alphaSpan: current.alphaSpan + (target.alphaSpan - current.alphaSpan) * blend,
          activeMix: current.activeMix + (target.activeMix - current.activeMix) * blend,
        }
        wavePhase = (wavePhase + dt * current.speed) % (Math.PI * 40)
      }
      syncCanvasSize()
      drawAcousticCore(ctx2d, canvas.width, canvas.height, current, wavePhase, tokens, compact)
      const shouldContinue = !reducedMotion && (current.speed > 0.015 || !closeEnough(current, target))
      if (shouldContinue) {
        running = true
        rafId = window.requestAnimationFrame(step)
      }
    }

    const wake = (): void => {
      tokens = readHostTokens(host)
      if (running) return
      lastTime = performance.now()
      running = true
      rafId = window.requestAnimationFrame(step)
    }
    wakeRef.current = wake
    wake()

    const themeObserver = new MutationObserver(() => { wake() })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'],
    })
    const onResize = (): void => { wake() }
    window.addEventListener('resize', onResize)
    const onMotionChange = (event: MediaQueryListEvent): void => {
      reducedMotion = event.matches
      wake()
    }
    motionQuery?.addEventListener('change', onMotionChange)

    return () => {
      wakeRef.current = null
      if (running) window.cancelAnimationFrame(rafId)
      themeObserver.disconnect()
      window.removeEventListener('resize', onResize)
      motionQuery?.removeEventListener('change', onMotionChange)
    }
  }, [compact])

  return (
    <span
      ref={hostRef}
      className={clsx(css.acousticCore, compact && css.acousticCompact)}
      data-phase={props.phase}
      data-acoustic-state={acoustic}
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className={css.acousticCanvas} />
      <svg
        className={css.centerWhale}
        viewBox={`0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`}
        fill="none"
      >
        <path d={FISH_LOGO_PATH} fill="currentColor" />
      </svg>
    </span>
  )
}
