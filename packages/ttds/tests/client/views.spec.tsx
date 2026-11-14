// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PluginsSubject } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ConfigForm, ConfigFormSnapshot, ConfigForms, SettingsDescribeFace, SettingsMirrorSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { TtdsClientController } from '../../src/client/controller.ts'
import { VoiceStagePage } from '../../src/client/VoiceStagePage.tsx'
import { FloatingVoiceOrb } from '../../src/client/FloatingVoiceOrb.tsx'
import { TtdsSettingsView } from '../../src/client/TtdsSettingsView.tsx'
import { TtdsDetailBadge } from '../../src/client/index.ts'
import { TtdsSettingsModel } from '../../src/client/settings-model.ts'
import { DEFAULT_VOICE_SYSTEM_INSTRUCTIONS } from '../../src/shared/voice-instructions.ts'
import { resolveTtdsConfig, toClientSafeConfigView } from '../../src/shared/config.ts'
import { clientFixture, formFixture, snapshot, t } from './fixture.ts'

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = () => {}
  HTMLElement.prototype.setPointerCapture = () => {}
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.releasePointerCapture = () => {}
  vi.stubGlobal('PointerEvent', MouseEvent)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('native voice surfaces', () => {
  it('renders 4-state hollow whale acoustic core, borderless feed, confirmations and IME-safe dock input', async () => {
    const fixture = clientFixture()
    fixture.controller.start()
    fixture.socket.open()
    const view = render(<VoiceStagePage controller={fixture.controller} t={t} />)
    const expectedAcoustic = {
      idle: 'off',
      listening: 'listening',
      thinking: 'standby',
      speaking: 'speaking',
    } as const
    for (const phase of ['idle', 'listening', 'thinking', 'speaking'] as const) {
      act(() => { fixture.socket.receive({ type: 'state.snapshot', snapshot: snapshot({ phase }) }) })
      const core = view.container.querySelector(`[data-phase="${phase}"]`)
      expect(core).not.toBeNull()
      expect(core?.getAttribute('data-acoustic-state')).toBe(expectedAcoustic[phase])
      expect(screen.getByRole('status').textContent).toBe(t(`phase.${phase}`))
    }
    expect(view.container.querySelector('canvas')).not.toBeNull()
    expect(view.container.querySelector('svg path')).not.toBeNull()
    act(() => {
      fixture.socket.receive({
        type: 'feed.item', item: { id: 'tool', kind: 'tool_call', text: 'dsh_search', timestampMs: 1 },
      })
      fixture.socket.receive({ type: 'state.snapshot', snapshot: snapshot({
        pendingConfirmations: [{
          confirmationId: 'confirm-1', toolName: 'dsh_send_prompt', summary: '发送任务', mode: 'ui', createdAtMs: 1,
        }],
      }) })
    })
    expect(screen.getByRole('log').textContent).toContain('dsh_search')
    fireEvent.click(screen.getByRole('button', { name: t('action.feedHide') }))
    expect(screen.queryByRole('log')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('action.feedShow') }))
    expect(screen.getByRole('log').textContent).toContain('dsh_search')
    const scrollCalls: ScrollToOptions[] = []
    const feedEl = screen.getByRole('log')
    feedEl.scrollTo = ((options: ScrollToOptions) => { scrollCalls.push(options) }) as typeof feedEl.scrollTo
    act(() => {
      fixture.socket.receive({
        type: 'feed.item', item: { id: 'tool-2', kind: 'tool_call', text: 'dsh_list_sessions', timestampMs: 2 },
      })
    })
    expect(scrollCalls.length).toBeGreaterThanOrEqual(1)
    expect(scrollCalls.at(-1)?.behavior).toBe('smooth')
    fireEvent.click(screen.getByRole('button', { name: t('action.allow') }))
    expect(fixture.socket.sent).toContainEqual({
      type: 'confirmation.respond', confirmationId: 'confirm-1', approved: true,
    })
    const input = screen.getByRole('textbox', { name: t('stage.input') })
    fireEvent.change(input, { target: { value: '检查当前会话' } })
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(fixture.socket.sent.some(frame => frame.type === 'input.text')).toBe(false)
    fireEvent.compositionEnd(input)
    fireEvent.keyUp(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(fixture.socket.sent).toContainEqual({ type: 'input.text', text: '检查当前会话' })
    expect((input as HTMLInputElement).value).toBe('')
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('hides on the voice panel and supports capsule morphing, left/right/top edge docking, confirmations and resize', async () => {
    const fixture = clientFixture()
    const view = render(<FloatingVoiceOrb controller={fixture.controller} t={t} activePanelId={null} />)
    expect(screen.queryByRole('complementary')).toBeNull()
    act(() => { fixture.controller.start(); fixture.socket.open() })
    const collapsed = screen.getByRole('button', { name: t('action.expand') })
    fireEvent.click(collapsed)
    expect(screen.getByRole('button', { name: t('action.return') })).not.toBeNull()
    expect(screen.getByRole('button', { name: t('action.stop') })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('action.collapse') }))
    const handle = screen.getByRole('button', { name: t('action.expand') })
    fireEvent.pointerDown(handle, { button: 0, clientX: window.innerWidth - 68, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 12, clientY: 200, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 12, clientY: 200, pointerId: 1 })
    expect(screen.getByRole('complementary').getAttribute('data-docked')).toBe('left')
    fireEvent.pointerDown(handle, { button: 0, clientX: 12, clientY: 200, pointerId: 2 })
    fireEvent.pointerMove(handle, { clientX: window.innerWidth - 4, clientY: 220, pointerId: 2 })
    fireEvent.pointerUp(handle, { clientX: window.innerWidth - 4, clientY: 220, pointerId: 2 })
    expect(screen.getByRole('complementary').getAttribute('data-docked')).toBe('right')
    fireEvent.pointerDown(handle, { button: 0, clientX: window.innerWidth - 4, clientY: window.innerHeight - 84, pointerId: 3 })
    fireEvent.pointerMove(handle, { clientX: 260, clientY: 10, pointerId: 3 })
    fireEvent.pointerUp(handle, { clientX: 260, clientY: 10, pointerId: 3 })
    expect(screen.getByRole('complementary').getAttribute('data-docked')).toBe('top')
    fireEvent(window, new Event('resize'))
    expect(screen.getByRole('complementary').getAttribute('data-docked')).toBe('top')
    act(() => {
      fixture.socket.receive({
        type: 'state.snapshot',
        snapshot: snapshot({
          pendingConfirmations: [{
            confirmationId: 'orb-confirm-1',
            toolName: 'dsh_resolve_tool_approval',
            summary: '批准 Bash 执行',
            mode: 'ui',
            createdAtMs: 2,
          }],
        }),
      })
    })
    expect(screen.getByRole('complementary').getAttribute('data-docked')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('action.allow') }))
    expect(fixture.socket.sent).toContainEqual({
      type: 'confirmation.respond',
      confirmationId: 'orb-confirm-1',
      approved: true,
    })
    act(() => {
      fixture.socket.receive({ type: 'state.snapshot', snapshot: snapshot({ pendingConfirmations: [] }) })
    })
    expect(screen.getByRole('complementary').getAttribute('data-docked')).toBe('top')
    view.rerender(<FloatingVoiceOrb controller={fixture.controller} t={t} activePanelId="ttds" />)
    expect(screen.queryByRole('complementary')).toBeNull()
    view.rerender(<FloatingVoiceOrb controller={fixture.controller} t={t} activePanelId={null} />)
    expect(screen.getByRole('complementary')).not.toBeNull()
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('renders credential badge only for the @whyself/ttds bundle subject', async () => {
    const fixture = clientFixture()
    const ownSubject = { kind: 'bundle', pkg: { name: '@whyself/ttds' } } as PluginsSubject
    const otherSubject = { kind: 'bundle', pkg: { name: '@other/plugin' } } as PluginsSubject
    const other = render(<TtdsDetailBadge controller={fixture.controller} t={t} subject={otherSubject} />)
    expect(other.container.textContent).toBe('')
    other.unmount()

    const badge = render(<TtdsDetailBadge controller={fixture.controller} t={t} subject={ownSubject} />)
    expect(badge.container.textContent).toBe(t('settings.notConfigured'))
    act(() => {
      fixture.controller.start()
      fixture.socket.open()
      const readyConfig = toClientSafeConfigView(resolveTtdsConfig({
        providers: { 'qwen-realtime': { apiKey: 'sk-ready' } },
      }, {}))
      fixture.socket.receive({ type: 'state.snapshot', snapshot: snapshot({ config: readyConfig }) })
    })
    expect(badge.container.textContent).toBe(t('settings.configured'))
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })
})

describe('plugin settings drafts', () => {
  it('stages four sections and sends exact nested paths together only when saved', async () => {
    const fixture = clientFixture()
    const { form, writes } = formFixture()
    render(<TtdsSettingsView view="page" form={form} controller={fixture.controller} t={t} />)
    for (const key of ['settings.service', 'settings.interaction', 'settings.tools', 'settings.hooks'] as const) {
      expect(screen.getByRole('group', { name: t(key) })).not.toBeNull()
    }
    fireEvent.click(screen.getByRole('button', { name: t('settings.model') }))
    fireEvent.click(screen.getByRole('menuitem', { name: t('settings.plus') }))
    fireEvent.click(screen.getByRole('switch', { name: t('settings.startMuted') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('settings.instructions') }), { target: { value: '请简短回答' } })
    fireEvent.click(screen.getByRole('switch', { name: t('settings.search') }))
    fireEvent.change(screen.getByRole('textbox', { name: t('settings.quiet') }), { target: { value: '6500' } })
    expect(writes).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: t('settings.save') }))
    await waitFor(() => { expect(writes).toHaveLength(1) })
    expect(writes[0]).toEqual({
      revision: 12,
      ops: [
        { op: 'set', path: ['providers', 'qwen-realtime', 'model'], value: 'qwen-audio-3.1-realtime-plus' },
        { op: 'set', path: ['voice', 'startMuted'], value: true },
        { op: 'set', path: ['voice', 'customInstructions'], value: '请简短回答' },
        { op: 'set', path: ['tools', 'enableSearchTool'], value: false },
        { op: 'set', path: ['hooks', 'quietGraceMs'], value: 6500 },
      ],
    })
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('never echoes stored keys and previews the actual built-in instructions', async () => {
    const fixture = clientFixture()
    const { form } = formFixture()
    const provider = { ...form.state.value, providers: { 'qwen-realtime': { apiKey: 'secret-never-echo' } } }
    render(<TtdsSettingsView view="page" form={{ ...form, state: { ...form.state, value: provider } }}
      controller={fixture.controller} t={t} />)
    expect(screen.getByLabelText<HTMLInputElement>(t('settings.apiKey')).value).toBe('')
    expect(screen.queryByText('secret-never-echo')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('settings.defaultInstructions') }))
    expect(screen.getByText(DEFAULT_VOICE_SYSTEM_INSTRUCTIONS)).not.toBeNull()
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('validates numeric ranges and fences drafts against the revision at the first edit', async () => {
    const { form, writes } = formFixture()
    const model = new TtdsSettingsModel(form)
    model.edit('maxHistoryTurns', '51')
    expect(model.shell().invalid).toBe(true)
    await model.save()
    expect(writes).toHaveLength(0)
    model.edit('maxHistoryTurns', '15')
    model.accept({ ...form, state: { ...form.state, revision: 19 } })
    await model.save()
    expect(writes[0]?.revision).toBe(12)
    expect(writes[0]?.ops).toEqual([{ op: 'set', path: ['providers', 'qwen-realtime', 'maxHistoryTurns'], value: 15 }])
  })

  it('retains rejected edits and discards drafts without a write on page exit', async () => {
    const { form } = formFixture()
    const model = new TtdsSettingsModel({ ...form, mutate: () => Promise.resolve(false) })
    model.edit('threshold', '-0.25')
    await model.save()
    expect(model.shell().failed).toBe(true)
    expect(model.field('threshold').text).toBe('-0.25')
    model.discard()
    expect(model.shell().dirty).toBe(false)
    expect(model.field('threshold').text).toBe('0.5')
  })

  it('resolves host configForms and redacted secrets when props.form is omitted', async () => {
    const fixture = clientFixture()
    const resolved = resolveTtdsConfig({}, {})
    const { apiKey: _stripped, ...qwenWithoutKey } = resolved.providers['qwen-realtime']
    const redactedValue: Record<string, unknown> = {
      ...resolved,
      providers: { 'qwen-realtime': qwenWithoutKey },
    }
    const formSnap: ConfigFormSnapshot<Record<string, unknown>> = {
      status: 'ready',
      value: redactedValue,
      base: redactedValue,
      user: {},
      writable: true,
      revision: 7,
    }
    const mirrorSnap: SettingsMirrorSnapshot = {
      status: 'ready',
      error: null,
      view: {
        writable: true,
        hasDocument: true,
        namespaces: [{
          ns: 'ttds',
          autoGenerate: false,
          schema: {},
          value: redactedValue,
          revision: 7,
          applies: 'live',
          secrets: [{ path: ['providers', 'qwen-realtime', 'apiKey'], set: true }],
        }],
      },
    }
    const writes: { ops: Parameters<ConfigForm<Record<string, unknown>>['mutate']>[0]; revision: number | undefined }[] = []
    const form: ConfigForm<Record<string, unknown>> = {
      getSnapshot: () => formSnap,
      subscribe: () => () => {},
      mutate: (ops, revision) => { writes.push({ ops, revision }); return Promise.resolve(true) },
      set: () => Promise.resolve(true),
      unset: () => Promise.resolve(true),
    }
    const describe: SettingsDescribeFace = {
      getSnapshot: () => mirrorSnap,
      subscribe: () => () => {},
      ensure: () => Promise.resolve(),
      acceptView: () => {},
    }
    const configForms: Pick<ConfigForms, 'get' | 'describe'> = {
      get: () => form as never,
      describe: () => describe,
    }
    fixture.ctx.provide('configForms', configForms as ConfigForms)
    const hostController = new TtdsClientController(fixture.ctx, fixture.options)
    render(<TtdsSettingsView view="page" controller={hostController} t={t} />)
    const badge = render(<TtdsDetailBadge
      controller={hostController}
      t={t}
      subject={{ kind: 'bundle', pkg: { name: '@whyself/ttds' } } as PluginsSubject}
    />)
    await waitFor(() => { expect(badge.container.textContent).toBe(t('settings.configured')) })
    expect(screen.queryByText(t('settings.unavailable'))).toBeNull()
    expect(screen.getByRole('group', { name: t('settings.service') })).not.toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: t('settings.startMuted') }))
    fireEvent.click(screen.getByRole('button', { name: t('settings.save') }))
    await waitFor(() => { expect(writes).toHaveLength(1) })
    expect(writes[0]).toEqual({
      revision: 7,
      ops: [{ op: 'set', path: ['voice', 'startMuted'], value: true }],
    })
    await hostController.dispose()
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })

  it('offers only ui and auto confirmation modes and tracks the latest revision across consecutive saves', async () => {
    const fixture = clientFixture()
    const { form, writes } = formFixture()
    let revision = 12
    let currentValue = { ...(form.state.value as Record<string, unknown>) }
    const reactiveForm = {
      get state() {
        return { status: 'ready' as const, value: currentValue, base: form.state.base, user: {}, writable: true, revision }
      },
      mutate: (ops: Parameters<typeof form.mutate>[0], expectedRevision: number | undefined) => {
        writes.push({ ops, revision: expectedRevision })
        for (const op of ops) {
          if (op.op === 'set' && op.path[0] === 'tools' && op.path[1] === 'writeConfirmation') {
            currentValue = {
              ...currentValue,
              tools: { ...(currentValue.tools as Record<string, unknown>), writeConfirmation: op.value },
            }
          }
        }
        revision += 1
        return Promise.resolve(true)
      },
    }
    render(<TtdsSettingsView view="page" form={reactiveForm} controller={fixture.controller} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: t('settings.writeConfirmation') }))
    const items = screen.getAllByRole('menuitem').map(el => el.textContent)
    expect(items).toEqual([t('settings.ui'), t('settings.auto')])
    fireEvent.click(screen.getByRole('menuitem', { name: t('settings.auto') }))
    fireEvent.click(screen.getByRole('button', { name: t('settings.save') }))
    await waitFor(() => { expect(writes).toHaveLength(1) })
    expect(writes[0]).toEqual({ revision: 12, ops: [{ op: 'set', path: ['tools', 'writeConfirmation'], value: 'auto' }] })

    fireEvent.click(screen.getByRole('button', { name: t('settings.writeConfirmation') }))
    fireEvent.click(screen.getByRole('menuitem', { name: t('settings.ui') }))
    fireEvent.click(screen.getByRole('button', { name: t('settings.save') }))
    await waitFor(() => { expect(writes).toHaveLength(2) })
    expect(writes[1]).toEqual({ revision: 13, ops: [{ op: 'set', path: ['tools', 'writeConfirmation'], value: 'ui' }] })
    await fixture.controller.dispose()
    await fixture.ctx.fiber.dispose()
  })
})
