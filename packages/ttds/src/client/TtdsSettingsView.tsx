import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  Button,
  DisclosureRow,
  IconChevronDownOutlineRegular,
  IconQuestionOutlineRegular,
  Menu,
  SettingsForm,
  SettingsSecretField,
  SettingsValueField,
  Switch,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { TtdsSettingsModel, settingsFields, type TtdsSettingsField } from './settings-model.ts'
import { useTtdsState, type TtdsUiProps } from './ui-state.ts'
import type { TtdsLocaleKey } from './locales.ts'
import { DEFAULT_QWEN_VOICE, DEFAULT_VOICE_SYSTEM_INSTRUCTIONS } from '../shared/voice-instructions.ts'
import css from './TtdsSettings.module.css'

const PRESET_VOICES = [
  DEFAULT_QWEN_VOICE,
  'chelsie_v3.1',
  'ethan_v3.1',
] as const

const CUSTOM_VOICE_SENTINEL = '__custom_voice__'

interface OptionEntry {
  readonly value: string
  readonly display: string
}

function SelectField(props: {
  id: string
  caption: string
  current: string
  items: readonly OptionEntry[]
  disabled: boolean
  mono?: boolean
  onSelect: (value: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const activeItem = props.items.find(item => item.value === props.current)
  const triggerText = activeItem !== undefined ? activeItem.display : props.current
  return (
    <div className={css.fieldBlock}>
      <span id={`${props.id}-caption`} className={css.fieldCaption}>{props.caption}</span>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        selectedId={props.current}
        minWidthFromAnchor
        items={props.items.map(item => ({ id: item.value, label: item.display }))}
        onSelect={(value) => {
          props.onSelect(value)
          setOpen(false)
        }}
        anchor={(
          <button
            type="button"
            id={props.id}
            className={clsx(css.selectTrigger, props.mono && css.monoValue)}
            aria-labelledby={`${props.id}-caption`}
            aria-expanded={open}
            aria-haspopup="menu"
            disabled={props.disabled}
            onClick={() => { setOpen(!open) }}
          >
            <span className={css.selectValue}>{triggerText}</span>
            <IconChevronDownOutlineRegular size={14} className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}

function CompactSelectRow(props: {
  id: string
  caption: string
  current: string
  items: readonly OptionEntry[]
  disabled: boolean
  onSelect: (value: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const activeItem = props.items.find(item => item.value === props.current)
  const triggerText = activeItem !== undefined ? activeItem.display : props.current
  return (
    <div className={css.permissionRow}>
      <span id={`${props.id}-caption`} className={css.rowTitle}>{props.caption}</span>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        selectedId={props.current}
        compact
        items={props.items.map(item => ({ id: item.value, label: item.display }))}
        onSelect={(value) => {
          props.onSelect(value)
          setOpen(false)
        }}
        anchor={(
          <button
            type="button"
            id={props.id}
            className={css.compactTrigger}
            aria-labelledby={`${props.id}-caption`}
            aria-expanded={open}
            aria-haspopup="menu"
            disabled={props.disabled}
            onClick={() => { setOpen(!open) }}
          >
            <span className={css.selectValue}>{triggerText}</span>
            <IconChevronDownOutlineRegular size={12} className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}

function CompactSwitchRow(props: {
  caption: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}): ReactNode {
  return (
    <div className={css.permissionRow}>
      <span className={css.rowTitle}>{props.caption}</span>
      <Switch
        label={props.caption}
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
      />
    </div>
  )
}

/**
 * Render the host plugin-detail configuration form with one atomic, nested-path save.
 * @param props - page owner form, view mode, controller and translated UI copy.
 * @returns four native settings sections, or summary copy for a summary request.
 */
export function TtdsSettingsView(props: PluginConfigViewProps & TtdsUiProps): ReactNode {
  const { t, controller } = props
  const runtime = useTtdsState(controller)
  const activeForm = props.form ?? controller.getConfigPageForm()
  const modelRef = useRef<TtdsSettingsModel>()
  modelRef.current ??= new TtdsSettingsModel(activeForm)
  const model = modelRef.current
  model.accept(activeForm)
  useSyncExternalStore(listener => model.changes.subscribe(listener), () => model.changes.getSnapshot())

  const [previewPrompt, setPreviewPrompt] = useState(false)
  const [advancedConnOpen, setAdvancedConnOpen] = useState(false)
  const [customVoiceMode, setCustomVoiceMode] = useState(false)
  const [inputDevices, setInputDevices] = useState<readonly MediaDeviceInfo[]>([])
  const [outputDevices, setOutputDevices] = useState<readonly MediaDeviceInfo[]>([])
  const [deviceFailed, setDeviceFailed] = useState(false)

  useEffect(() => {
    let alive = true
    const media = navigator.mediaDevices
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- insecure browser origins omit mediaDevices.
    if (media === undefined) return
    const refresh = (): void => {
      void media.enumerateDevices().then((list) => {
        if (!alive) return
        setInputDevices(list.filter(device => device.kind === 'audioinput'))
        setOutputDevices(list.filter(device => device.kind === 'audiooutput'))
        setDeviceFailed(false)
      }, () => {
        if (alive) setDeviceFailed(true)
      })
    }
    refresh()
    media.addEventListener('devicechange', refresh)
    return () => {
      alive = false
      media.removeEventListener('devicechange', refresh)
    }
  }, [])

  const shell = model.shell()
  const disabled = !shell.writable || shell.saving
  const labels = {
    unavailable: t('settings.unavailable'),
    readOnly: t('settings.readOnly'),
    saveFailed: t('settings.failed'),
    save: t('settings.save'),
    saving: t('settings.saving'),
  }

  const valueField = (
    field: TtdsSettingsField,
    key: TtdsLocaleKey,
    options?: { hint?: TtdsLocaleKey; placeholder?: TtdsLocaleKey; locked?: boolean },
  ): ReactNode => (
    <SettingsValueField
      key={field}
      id={`ttds-${field}`}
      label={t(key)}
      {...model.field(field)}
      disabled={disabled || options?.locked === true}
      numeric={settingsFields[field].kind === 'number'}
      hint={options?.hint === undefined ? '' : t(options.hint)}
      {...(options?.placeholder === undefined ? {} : { placeholder: t(options.placeholder) })}
      overriddenLabel={t('settings.modified')}
      resetLabel={t('settings.reset')}
      invalidLabel={t('settings.invalid')}
      onEdit={(text) => { model.edit(field, text) }}
      onReset={() => { model.reset(field) }}
    />
  )

  if (props.view === 'summary') return <span>{t('app.name')}</span>

  const hasCredential = model.hasCredential()
    || runtime.snapshot?.config.qwenRealtime.hasApiKey === true
    || runtime.hostConfig.hasConfigCredential

  const currentVoice = model.field('voice').text || DEFAULT_QWEN_VOICE
  const isPresetVoice = (PRESET_VOICES as readonly string[]).includes(currentVoice)
  const showCustomVoiceInput = customVoiceMode || !isPresetVoice
  const voiceSelectValue = showCustomVoiceInput ? CUSTOM_VOICE_SENTINEL : currentVoice

  const turnDetectionValue = model.field('turnDetection').text || 'smart_turn_v2'
  const supportsSinkId = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype
  const customInstructionsField = model.field('customInstructions')
  const quietField = model.field('quietGraceMs')
  const defaultInstructionsLabel = t('settings.defaultInstructions')
  const instructionsPlaceholder = t('settings.instructionsPlaceholder')
  const quietCaption = t('settings.quiet')

  return (
    <div className={css.settings}>
      <SettingsForm
        labels={labels}
        state={shell}
        onSave={() => { void model.save() }}
        onDiscard={() => { model.discard() }}
      >
        <fieldset className={css.section} disabled={disabled}>
          <legend className={css.sectionTitle}>{t('settings.service')}</legend>

          <SelectField
            id="ttds-provider"
            caption={t('settings.provider')}
            current={model.field('provider').text || 'qwen-realtime'}
            disabled={disabled}
            items={[{ value: 'qwen-realtime', display: t('settings.qwen') }]}
            onSelect={(value) => { model.edit('provider', value) }}
          />
          <p className={css.providerHint}>{t('settings.providerHint')}</p>

          <div className={css.panel}>
            <div className={css.panelGridTwo}>
              <SettingsSecretField
                id="ttds-apiKey"
                label={t('settings.apiKey')}
                hint={t('settings.secretHint')}
                text={model.field('apiKey').text}
                disabled={disabled}
                configured={hasCredential}
                stateLabel={hasCredential ? t('settings.configured') : t('settings.notConfigured')}
                onEdit={(text) => { model.edit('apiKey', text) }}
              />
              {valueField('workspaceId', 'settings.workspaceId', { placeholder: 'settings.workspacePlaceholder' })}
            </div>

            <div className={css.panelDivider} />

            <div className={css.panelGridTwo}>
              <SelectField
                id="ttds-model"
                caption={t('settings.model')}
                current={model.field('model').text || 'qwen-audio-3.1-realtime-flash'}
                disabled={disabled}
                items={[
                  { value: 'qwen-audio-3.1-realtime-flash', display: t('settings.flash') },
                  { value: 'qwen-audio-3.1-realtime-plus', display: t('settings.plus') },
                ]}
                onSelect={(value) => { model.edit('model', value) }}
              />
              <SelectField
                id="ttds-voice-select"
                caption={t('settings.voice')}
                current={voiceSelectValue}
                disabled={disabled}
                mono={!showCustomVoiceInput}
                items={[
                  { value: DEFAULT_QWEN_VOICE, display: t('settings.voicePresetLonganqian') },
                  { value: 'chelsie_v3.1', display: t('settings.voicePresetChelsie') },
                  { value: 'ethan_v3.1', display: t('settings.voicePresetEthan') },
                  { value: CUSTOM_VOICE_SENTINEL, display: t('settings.voiceCustomOption') },
                ]}
                onSelect={(value) => {
                  if (value === CUSTOM_VOICE_SENTINEL) {
                    setCustomVoiceMode(true)
                  } else {
                    setCustomVoiceMode(false)
                    model.edit('voice', value)
                  }
                }}
              />
            </div>

            {showCustomVoiceInput && (
              <div className={css.subFieldRow}>
                {valueField('voice', 'settings.voiceCustomField')}
              </div>
            )}

            <div className={css.panelDivider} />

            <div className={css.panelGridThree}>
              <SelectField
                id="ttds-turnDetection"
                caption={t('settings.turnDetection')}
                current={turnDetectionValue}
                disabled={disabled}
                items={[
                  { value: 'smart_turn_v2', display: t('settings.smartV2') },
                  { value: 'smart_turn', display: t('settings.smart') },
                  { value: 'server_vad', display: t('settings.vad') },
                  { value: 'push_to_talk', display: t('settings.pushToTalk') },
                ]}
                onSelect={(value) => { model.edit('turnDetection', value) }}
              />
              {valueField('threshold', 'settings.threshold', {
                hint: 'settings.thresholdHint',
                locked: turnDetectionValue === 'push_to_talk',
              })}
              {valueField('maxHistoryTurns', 'settings.history', { hint: 'settings.historyHint' })}
            </div>

            {turnDetectionValue === 'server_vad' && (
              <div className={css.subFieldRow}>
                {valueField('silenceDurationMs', 'settings.silence', { hint: 'settings.silenceHint' })}
              </div>
            )}

            <div className={css.panelDivider} />

            <div className={css.disclosureWrap}>
              <DisclosureRow
                icon={null}
                title={t('settings.advancedConnection')}
                open={advancedConnOpen || model.field('baseUrl').text.trim() !== ''}
                expandable
                expandOnRowClick
                onToggle={() => { setAdvancedConnOpen(!advancedConnOpen) }}
              >
                <div className={css.disclosureContent}>
                  {valueField('baseUrl', 'settings.baseUrl', { placeholder: 'settings.baseUrlPlaceholder' })}
                </div>
              </DisclosureRow>
            </div>
          </div>
        </fieldset>

        <fieldset className={css.section} disabled={disabled}>
          <legend className={css.sectionTitle}>{t('settings.interaction')}</legend>

          <div className={css.gridTwo}>
            <SelectField
              id="ttds-inputDeviceId"
              caption={t('settings.microphone')}
              current={model.field('inputDeviceId').text}
              disabled={disabled}
              items={[
                { value: '', display: t('settings.systemMicrophone') },
                ...inputDevices.map((device, index) => ({
                  value: device.deviceId,
                  display: device.label || t('settings.microphoneFallback', { index: index + 1 }),
                })),
              ]}
              onSelect={(value) => { model.edit('inputDeviceId', value) }}
            />
            <div className={css.speakerCol}>
              <SelectField
                id="ttds-outputDeviceId"
                caption={t('settings.speaker')}
                current={model.field('outputDeviceId').text}
                disabled={disabled || !supportsSinkId}
                items={[
                  { value: '', display: t('settings.systemSpeaker') },
                  ...outputDevices.map((device, index) => ({
                    value: device.deviceId,
                    display: device.label || t('settings.speakerFallback', { index: index + 1 }),
                  })),
                ]}
                onSelect={(value) => { model.edit('outputDeviceId', value) }}
              />
              {!supportsSinkId && (
                <p className={css.subtleNote}>{t('settings.speakerUnsupported')}</p>
              )}
            </div>
          </div>

          {deviceFailed && <p className={css.subtleNote} role="status">{t('settings.microphoneFailed')}</p>}

          <div className={css.lineDivider} />

          <div className={css.switchBannerRow}>
            <div className={css.switchCopy}>
              <span className={css.switchPrimary}>{t('settings.startMuted')}</span>
              <span className={css.switchDesc}>{t('settings.startMutedDesc')}</span>
            </div>
            <Switch
              label={t('settings.startMuted')}
              checked={model.field('startMuted').text === 'true'}
              disabled={disabled}
              onChange={(checked) => { model.edit('startMuted', String(checked)) }}
            />
          </div>

          <div className={css.lineDivider} />

          <div className={css.instructionsBlock}>
            <div className={css.instructionsHeader}>
              <div className={css.instructionsTitleGroup}>
                <label className={css.fieldCaption} htmlFor="ttds-customInstructions">
                  {t('settings.instructions')}
                </label>
                <Tooltip label={defaultInstructionsLabel} side="top">
                  <button
                    type="button"
                    className={css.helpIconButton}
                    aria-label={defaultInstructionsLabel}
                    aria-expanded={previewPrompt}
                    onClick={() => { setPreviewPrompt(!previewPrompt) }}
                  >
                    <IconQuestionOutlineRegular size={13} />
                  </button>
                </Tooltip>
              </div>

              <div className={css.instructionsMeta}>
                {customInstructionsField.overridden && (
                  <>
                    <Tag tone="neutral">{t('settings.modified')}</Tag>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => { model.reset('customInstructions') }}
                    >
                      {t('settings.reset')}
                    </Button>
                  </>
                )}
              </div>
            </div>

            {previewPrompt && (
              <div className={css.promptPreview}>
                <p className={css.promptText}>{DEFAULT_VOICE_SYSTEM_INSTRUCTIONS}</p>
              </div>
            )}

            <textarea
              id="ttds-customInstructions"
              className={css.textarea}
              rows={2}
              placeholder={instructionsPlaceholder}
              aria-describedby="ttds-instructions-hint"
              disabled={disabled}
              value={customInstructionsField.text}
              onChange={(event) => { model.edit('customInstructions', event.target.value) }}
            />
            <p id="ttds-instructions-hint" className={css.hint}>{t('settings.instructionsHint')}</p>
          </div>
        </fieldset>

        <div className={css.dualColumns}>
          <fieldset className={css.columnSection} disabled={disabled}>
            <legend className={css.sectionTitle}>{t('settings.tools')}</legend>

            <div className={css.permissionList}>
              <CompactSwitchRow
                caption={t('settings.readTools')}
                checked={model.field('enableReadTools').text === 'true'}
                disabled={disabled}
                onChange={(checked) => { model.edit('enableReadTools', String(checked)) }}
              />
              <CompactSwitchRow
                caption={t('settings.search')}
                checked={model.field('enableSearchTool').text === 'true'}
                disabled={disabled}
                onChange={(checked) => { model.edit('enableSearchTool', String(checked)) }}
              />
              <CompactSelectRow
                id="ttds-writeConfirmation"
                caption={t('settings.writeConfirmation')}
                current={model.field('writeConfirmation').text || 'ui'}
                disabled={disabled}
                items={[
                  { value: 'ui', display: t('settings.ui') },
                  { value: 'auto', display: t('settings.auto') },
                ]}
                onSelect={(value) => { model.edit('writeConfirmation', value) }}
              />
            </div>
          </fieldset>

          <fieldset className={css.columnSection} disabled={disabled}>
            <legend className={css.sectionTitle}>{t('settings.hooks')}</legend>

            <div className={css.permissionList}>
              <div className={css.permissionRow}>
                <label className={css.rowTitle} htmlFor="ttds-quietGraceMs">
                  {quietCaption}
                </label>
                <input
                  id="ttds-quietGraceMs"
                  type="text"
                  inputMode="numeric"
                  className={clsx(css.compactNumberInput, quietField.invalid && css.compactInputInvalid)}
                  aria-invalid={quietField.invalid || undefined}
                  disabled={disabled}
                  value={quietField.text}
                  onChange={(event) => { model.edit('quietGraceMs', event.target.value) }}
                />
              </div>
              {quietField.invalid && (
                <p className={css.invalidText} role="alert">{t('settings.invalid')}</p>
              )}

              <CompactSwitchRow
                caption={t('settings.onToolApproval')}
                checked={model.field('onToolApproval').text === 'true'}
                disabled={disabled}
                onChange={(checked) => { model.edit('onToolApproval', String(checked)) }}
              />
              <CompactSwitchRow
                caption={t('settings.onTurnSettled')}
                checked={model.field('onTurnSettled').text === 'true'}
                disabled={disabled}
                onChange={(checked) => { model.edit('onTurnSettled', String(checked)) }}
              />
              <CompactSwitchRow
                caption={t('settings.onAgentError')}
                checked={model.field('onAgentError').text === 'true'}
                disabled={disabled}
                onChange={(checked) => { model.edit('onAgentError', String(checked)) }}
              />
              <CompactSwitchRow
                caption={t('settings.onShellExitError')}
                checked={model.field('onShellExitError').text === 'true'}
                disabled={disabled}
                onChange={(checked) => { model.edit('onShellExitError', String(checked)) }}
              />
              <CompactSwitchRow
                caption={t('settings.onSubagentSettled')}
                checked={model.field('onSubagentSettled').text === 'true'}
                disabled={disabled}
                onChange={(checked) => { model.edit('onSubagentSettled', String(checked)) }}
              />
            </div>
          </fieldset>
        </div>
      </SettingsForm>
    </div>
  )
}
