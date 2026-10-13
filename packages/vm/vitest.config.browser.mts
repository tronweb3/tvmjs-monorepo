import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from '../../config/vitest.config.browser.mts'

export default mergeConfig(
  baseConfig,
  defineConfig({
    define: { global: 'globalThis' },
    test: { include: ['test/api/**/*.spec.ts'] },
    resolve: { alias: { events: 'eventemitter3' } },
  }),
)
