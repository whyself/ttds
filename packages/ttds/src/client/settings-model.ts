import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Field schema consumed by staged settings controls. */
export interface TtdsFieldSpec {
  path: readonly string[]
  kind: 'text' | 'secret' | 'number' | 'boolean'
  min?: number
  max?: number
  integer?: boolean
  values?: readonly string[]
}

/** Fields with their exact Host document paths and editable value constraints. */
export const settingsFields = {
  provider: { path: ['provider'], kind: 'text' },
  apiKey: { path: ['providers', 'qwen-realtime', 'apiKey'], kind: 'secret' },
  workspaceId: { path: ['providers', 'qwen-realtime', 'workspaceId'], kind: 'text' },
  baseUrl: { path: ['providers', 'qwen-realtime', 'baseUrl'], kind: 'text' },
  model: {
    path: ['providers', 'qwen-realtime', 'model'], kind: 'text',
    values: ['qwen-audio-3.1-realtime-flash', 'qwen-audio-3.1-realtime-plus'],
  },
  voice: { path: ['providers', 'qwen-realtime', 'voice'], kind: 'text' },
  maxHistoryTurns: { path: ['providers', 'qwen-realtime', 'maxHistoryTurns'], kind: 'number', min: 5, max: 50, integer: true },
  turnDetection: {
    path: ['voice', 'turnDetection'], kind: 'text',
    values: ['smart_turn_v2', 'smart_turn', 'server_vad', 'push_to_talk'],
  },
  threshold: { path: ['voice', 'threshold'], kind: 'number', min: -1, max: 1 },
  silenceDurationMs: { path: ['voice', 'silenceDurationMs'], kind: 'number', min: 200, max: 2000, integer: true },
  inputDeviceId: { path: ['voice', 'inputDeviceId'], kind: 'text' },
  outputDeviceId: { path: ['voice', 'outputDeviceId'], kind: 'text' },
  startMuted: { path: ['voice', 'startMuted'], kind: 'boolean' },
  customInstructions: { path: ['voice', 'customInstructions'], kind: 'text' },
  enableReadTools: { path: ['tools', 'enableReadTools'], kind: 'boolean' },
  enableSearchTool: { path: ['tools', 'enableSearchTool'], kind: 'boolean' },
  writeConfirmation: { path: ['tools', 'writeConfirmation'], kind: 'text', values: ['auto', 'ui'] },
  toolTimeoutMs: { path: ['tools', 'toolTimeoutMs'], kind: 'number', min: 1000, max: 300000, integer: true },
  quietGraceMs: { path: ['hooks', 'quietGraceMs'], kind: 'number', min: 0, max: 60000, integer: true },
  onTurnSettled: { path: ['hooks', 'onTurnSettled'], kind: 'boolean' },
  onToolApproval: { path: ['hooks', 'onToolApproval'], kind: 'boolean' },
  onAgentError: { path: ['hooks', 'onAgentError'], kind: 'boolean' },
  onShellExitError: { path: ['hooks', 'onShellExitError'], kind: 'boolean' },
  onSubagentSettled: { path: ['hooks', 'onSubagentSettled'], kind: 'boolean' },
} satisfies Record<string, TtdsFieldSpec>

/** Names of fields understood by this staged form. */
export type TtdsSettingsField = keyof typeof settingsFields

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function format(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
}

function parse(spec: TtdsFieldSpec, text: string): string | number | boolean {
  if (spec.kind === 'boolean') return text === 'true'
  if (spec.kind === 'number') return Number(text)
  return text.trim()
}

/** Stages nested path edits and fences their atomic save with the first edit's Host revision. */
export class TtdsSettingsModel {
  /** Revision counter for React subscriptions; contains no credential material. */
  readonly changes = createSnapshotStore(0)
  private readonly edits = new Map<TtdsSettingsField, { text: string; reset: boolean }>()
  private baseline: number | undefined
  private saving = false
  private failed = false

  /**
   * @param form - current host-owned accepted values and mutation action.
   */
  constructor(private form: ConfigPageForm | undefined) {}

  /**
   * Refresh accepted Host state without changing the revision of already staged drafts.
   * @param form - newest page-owner form.
   * @returns nothing.
   */
  accept(form: ConfigPageForm | undefined): void { this.form = form }

  /**
   * Read the draft without exposing stored credentials.
   * @param field - configured field name.
   * @returns draft text, user-layer presence and validation status.
   */
  field(field: TtdsSettingsField): { text: string; overridden: boolean; invalid: boolean } {
    const spec: TtdsFieldSpec = settingsFields[field]
    const edit = this.edits.get(field)
    const text = edit?.text ?? (spec.kind === 'secret' ? '' : format(readPath(this.form?.state.value, spec.path)))
    const invalid = edit !== undefined && !edit.reset && !this.valid(spec, text)
    return {
      text, invalid,
      overridden: edit === undefined
        ? readPath(this.form?.state.user, spec.path) !== undefined
        : !edit.reset,
    }
  }

  /**
   * Read credential presence without returning its content.
   * @returns whether the accepted Host view carries an API key.
   */
  hasCredential(): boolean {
    return Boolean(readPath(this.form?.state.value, settingsFields.apiKey.path))
  }

  /**
   * Stage one input; no Host write happens until save.
   * @param field - editable field.
   * @param text - control's draft value.
   * @returns nothing.
   */
  edit(field: TtdsSettingsField, text: string): void {
    if (this.saving || this.form?.state.writable !== true) return
    if (this.edits.size === 0) this.baseline = this.form.state.revision
    this.edits.set(field, { text, reset: false })
    this.failed = false
    this.publish()
  }

  /**
   * Stage inheritance from the Host composition layer.
   * @param field - field whose user override should be removed.
   * @returns nothing.
   */
  reset(field: TtdsSettingsField): void {
    if (this.saving || this.form?.state.writable !== true) return
    if (this.edits.size === 0) this.baseline = this.form.state.revision
    this.edits.set(field, { text: format(readPath(this.form.state.base, settingsFields[field].path)), reset: true })
    this.publish()
  }

  /**
   * Project availability and save state for the host SettingsForm primitive.
   * @returns shell state; invalid edits block the complete atomic write.
   */
  shell(): SettingsFormShell {
    return {
      available: this.form?.state.status === 'ready',
      writable: this.form?.state.writable === true,
      dirty: this.form?.state.writable === true && this.operations().length > 0,
      invalid: [...this.edits.keys()].some(field => this.field(field).invalid),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /**
   * Save every staged nested path in one revision-fenced mutation; failed writes retain drafts.
   * @returns settlement after Host acceptance or a retained failure.
   */
  async save(): Promise<void> {
    const shell = this.shell()
    if (!shell.available || !shell.writable || !shell.dirty || shell.invalid || shell.saving || this.form === undefined) return
    this.saving = true
    this.failed = false
    this.publish()
    let accepted: boolean
    try {
      accepted = await this.form.mutate(this.operations(), this.baseline)
    } catch (_error) {
      accepted = false
    }
    this.saving = false
    if (accepted) {
      this.edits.clear()
      this.baseline = undefined
    }
    this.failed = !accepted
    this.publish()
  }

  /** Drop drafts and their credential text when the page leaves. */
  discard(): void {
    this.edits.clear()
    this.baseline = undefined
    this.failed = false
    this.publish()
  }

  private operations(): Parameters<ConfigPageForm['mutate']>[0][number][] {
    const ops: Parameters<ConfigPageForm['mutate']>[0][number][] = []
    for (const [field, edit] of this.edits) {
      const spec: TtdsFieldSpec = settingsFields[field]
      if (edit.reset) ops.push({ op: 'unset', path: [...spec.path] })
      else if (spec.kind === 'secret' && edit.text.trim() === '') continue
      else if (spec.kind !== 'secret' && edit.text === format(readPath(this.form?.state.value, spec.path))) continue
      else ops.push({ op: 'set', path: [...spec.path], value: parse(spec, edit.text) })
    }
    return ops
  }

  private valid(spec: TtdsFieldSpec, text: string): boolean {
    if (spec.kind === 'number') {
      const value = Number(text)
      return text.trim() !== '' && Number.isFinite(value) && (!spec.integer || Number.isInteger(value))
        && (spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max)
    }
    if (spec.values !== undefined) return spec.values.includes(text)
    return true
  }

  private publish(): void { this.changes.set(this.changes.getSnapshot() + 1) }
}
