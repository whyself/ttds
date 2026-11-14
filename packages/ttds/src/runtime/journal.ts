import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SupervisorJournalRecord } from '../shared/index.ts'

/**
 * Remove configured secrets and recognizable credentials from text before persistence or client delivery.
 * @param text - untrusted text.
 * @param secrets - resolved credentials that must never leave the Host.
 * @returns sanitized text.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret !== '') result = result.replaceAll(secret, '[redacted]')
  }
  return result.replace(/\bsk-[a-zA-Z0-9_-]+/g, '[redacted]').replace(/Bearer\s+[^\s"'\\,;]+/gi, 'Bearer [redacted]')
}

function sanitize(value: unknown, secrets: readonly string[], key = ''): unknown {
  if (/api.?key|authorization|secret|token|audio|pcm|base64/i.test(key)) return '[redacted]'
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[redacted]'
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map((item: unknown) => sanitize(item, secrets))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitize(item, secrets, name)]))
  }
  return value
}

function journalPath(storageDir: string, supervisorSessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(supervisorSessionId)) throw new Error('ttds: invalid supervisor session identifier')
  return join(storageDir, `${supervisorSessionId}.jsonl`)
}

/**
 * Ordered durable text projection of one supervisor session; failed writes reject every subsequent flush.
 */
export class SupervisorSessionJournal {
  private tail: Promise<void> = Promise.resolve()
  private seq = 0
  private readonly path: string

  /**
   * Create an append-only journal for a newly allocated session identifier.
   * @param storageDir - configured persistence directory.
   * @param supervisorSessionId - unique filesystem-safe session identifier.
   * @param secrets - credentials removed even when embedded in arbitrary payload strings.
   */
  constructor(
    private readonly storageDir: string,
    private readonly supervisorSessionId: string,
    private readonly secrets: readonly string[] = [],
  ) {
    this.path = journalPath(storageDir, supervisorSessionId)
  }

  /**
   * Append one record in invocation order, resolving only after the filesystem accepts the line.
   * @param kind - model-visible record category.
   * @param payload - structured text facts; audio and credential fields are removed.
   * @returns completion of this record's write.
   */
  append(kind: SupervisorJournalRecord['kind'], payload: Readonly<Record<string, unknown>>): Promise<void> {
    const record: SupervisorJournalRecord = {
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
      supervisorSessionId: this.supervisorSessionId,
      kind,
      payload,
    }
    const line = `${JSON.stringify(sanitize(record, this.secrets))}\n`
    this.tail = this.tail.then(async () => {
      await mkdir(this.storageDir, { recursive: true })
      await appendFile(this.path, line, 'utf8')
    })
    return this.tail
  }

  /**
   * Wait for all preceding writes, propagating persistence failures.
   * @returns completion of all queued records.
   */
  flush(): Promise<void> {
    return this.tail
  }

  /**
   * Read a journal in persisted sequence order; a missing session has no records.
   * @param storageDir - configured persistence directory.
   * @param supervisorSessionId - filesystem-safe session identifier.
   * @returns validated journal records.
   */
  static async readRecords(storageDir: string, supervisorSessionId: string): Promise<readonly SupervisorJournalRecord[]> {
    let text: string
    try {
      text = await readFile(journalPath(storageDir, supervisorSessionId), 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    return text.split('\n').filter(line => line !== '').map((line, index) => {
      const value: unknown = JSON.parse(line)
      if (typeof value !== 'object' || value === null
        || !('seq' in value) || value.seq !== index + 1
        || !('supervisorSessionId' in value) || value.supervisorSessionId !== supervisorSessionId
        || !('timestamp' in value) || typeof value.timestamp !== 'string'
        || !('kind' in value) || typeof value.kind !== 'string'
        || !('payload' in value) || typeof value.payload !== 'object' || value.payload === null) {
        throw new Error('ttds: invalid supervisor journal record')
      }
      const kinds: readonly string[] = [
        'session.started', 'session.rotated', 'session.ended', 'user.transcript', 'user.text',
        'assistant.transcript', 'tool.call', 'tool.confirmation', 'tool.output', 'hook.injected', 'error',
      ]
      if (!kinds.includes(value.kind)) throw new Error('ttds: invalid supervisor journal record category')
      return value as SupervisorJournalRecord
    })
  }

  /**
   * Read validated records from the most recent persisted journals in `storageDir`.
   * @param storageDir - configured persistence directory.
   * @param options - optional excluded session id and maximum session file count.
   * @returns chronologically ordered records across recent valid journals.
   */
  static async readRecentHistory(
    storageDir: string,
    options: { readonly excludeSessionId?: string; readonly maxSessions?: number } = {},
  ): Promise<readonly SupervisorJournalRecord[]> {
    let entries: string[]
    try {
      entries = await readdir(storageDir)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    const maxSessions = Math.max(0, options.maxSessions ?? 5)
    if (maxSessions === 0) return []
    const files: { readonly id: string; readonly mtimeMs: number }[] = []
    for (const fileName of entries) {
      if (!fileName.endsWith('.jsonl')) continue
      const id = fileName.slice(0, -'.jsonl'.length)
      if (id === '' || id === options.excludeSessionId || !/^[A-Za-z0-9_-]+$/.test(id)) continue
      try {
        const info = await stat(join(storageDir, fileName))
        files.push({ id, mtimeMs: info.mtimeMs })
      } catch {
        // Ignore files removed or inaccessible concurrently during directory inspection.
      }
    }
    if (files.length === 0) return []
    const recent = [...files]
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxSessions)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    const groups: { readonly records: readonly SupervisorJournalRecord[]; readonly sortTime: number; readonly order: number }[] = []
    for (const [index, entry] of recent.entries()) {
      let records: readonly SupervisorJournalRecord[]
      try {
        records = await SupervisorSessionJournal.readRecords(storageDir, entry.id)
      } catch {
        // Skip corrupt or partially written historical journals so a new voice session can still start.
        continue
      }
      if (records.length === 0) continue
      const firstTs = Date.parse(records[0]?.timestamp ?? '')
      groups.push({
        records,
        sortTime: Number.isNaN(firstTs) ? entry.mtimeMs : firstTs,
        order: index,
      })
    }
    groups.sort((a, b) => (a.sortTime === b.sortTime ? a.order - b.order : a.sortTime - b.sortTime))
    return groups.flatMap(group => group.records)
  }
}
