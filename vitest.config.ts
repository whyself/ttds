import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'lab/**'],
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] } },
  },
})
