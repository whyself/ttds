import { afterEach, describe, expect, it } from 'vitest'
import { bootBundle, type BootedBundle } from '../../../scripts/test-support/boot-bundle.ts'

let booted: BootedBundle | undefined

afterEach(async () => {
  await booted?.dispose()
  booted = undefined
})

describe('@whyself/ttds real Loader composition', () => {
  it('loads from cordis.patch.yml and disposes cleanly', async () => {
    booted = await bootBundle('packages/ttds')

    const entry = [...booted.ctx.loader.entries()].find(candidate => candidate.options.id === 'ttds')
    expect(entry?.options.name).toBe('@whyself/ttds')

    await booted.dispose()
    booted = undefined
  }, 30_000)
})
