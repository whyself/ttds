import { createElement, useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TtdsClientController, type TtdsClientOptions } from './controller.ts'
import { VoiceStagePage } from './VoiceStagePage.tsx'
import { FloatingVoiceOrb } from './FloatingVoiceOrb.tsx'
import { SidebarPanelIcon } from './SidebarPanelIcon.tsx'
import { TtdsSettingsView } from './TtdsSettingsView.tsx'
import { useTtdsState, type TtdsUiProps } from './ui-state.ts'
import { NS, zh, en } from './locales.ts'

export { TtdsAudioEngine, encodePcm16, resolveAudioEngineOptions } from './audio-engine.ts'
export type { AudioEngineOptions, VoiceAudioAdapter } from './audio-engine.ts'
export { TtdsClientController, resolveClientOptions } from './controller.ts'
export type { HostVoicePreferences, TtdsClientOptions, TtdsClientState, RealtimeSocket } from './controller.ts'
export { SidebarPanelIcon } from './SidebarPanelIcon.tsx'
export { VoiceRings } from './VoiceRings.tsx'
export { VoiceStagePage } from './VoiceStagePage.tsx'
export { FloatingVoiceOrb } from './FloatingVoiceOrb.tsx'
export { TtdsSettingsView } from './TtdsSettingsView.tsx'
export { acousticState, useTtdsState, voicePhase } from './ui-state.ts'
export type { AcousticState, TtdsUiProps } from './ui-state.ts'
export { NS, zh, en } from './locales.ts'
export type { TtdsLocaleKey } from './locales.ts'

/** Only the slots and locale services are required in an isolated client host. */
export const inject = ['slots', 'locale']

/**
 * Render the credential readiness badge next to the bundle version in plugin details.
 * @param props - plugin detail subject, shared controller, and translator.
 * @returns configured or unconfigured tag for `@whyself/ttds`, or null for other entries.
 */
export function TtdsDetailBadge(props: TtdsUiProps & { subject: PluginsSubject }): ReactNode {
  const state = useTtdsState(props.controller)
  if (props.subject.kind !== 'bundle' || props.subject.pkg.name !== '@whyself/ttds') return null
  const configured = state.snapshot?.config.qwenRealtime.hasApiKey ?? state.hostConfig.hasConfigCredential
  return createElement(Tag, { tone: 'neutral' }, props.t(configured ? 'settings.configured' : 'settings.notConfigured'))
}

/**
 * Register the client controller and five native UI contributions in this plugin's lifetime.
 * @param ctx - client plugin context owning every registration and media resource.
 * @param options - optional deterministic browser dependencies for integration tests.
 * @returns the instance shared by this plugin's slot contributions.
 */
export function apply(ctx: Context, options?: TtdsClientOptions): TtdsClientController {
  const controller = new TtdsClientController(ctx, options)
  ctx.effect(() => () => controller.dispose())
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const panel = createSnapshotStore<PanelInfo>({ activePanelId: null })
  ctx.inject(['layout'], (scope) => {
    const layout = scope.layout
    const update = (): void => { panel.set(layout.panelInfo.getSnapshot()) }
    update()
    scope.effect(() => layout.panelInfo.subscribe(update))
    scope.effect(() => () => { panel.set({ activePanelId: null }) })
  })
  const Overlay = (props: TtdsUiProps): ReactNode => {
    const active = useSyncExternalStore(listener => panel.subscribe(listener), () => panel.getSnapshot())
    return createElement(FloatingVoiceOrb, { ...props, activePanelId: active.activePanelId })
  }
  const injected = (): { controller: TtdsClientController } => ({ controller })
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'ttds', locale: NS, inject: injected,
  }, VoiceStagePage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'ttds', locale: NS, label: () => ctx.locale.bind(NS)('app.name'), inject: injected,
  }, SidebarPanelIcon))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'ttds.floating-pill', locale: NS, inject: injected,
  }, Overlay))
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config', key: '@whyself/ttds', locale: NS, inject: injected,
  }, TtdsSettingsView))
  ctx.slots.inject('plugins.detail.badge', () => ctx.slots.register({
    name: 'plugins.detail.badge', id: 'ttds.credential-badge', locale: NS, inject: injected,
  }, TtdsDetailBadge))
  return controller
}
