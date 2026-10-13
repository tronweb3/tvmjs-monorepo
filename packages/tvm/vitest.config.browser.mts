import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from '../../config/vitest.config.browser.mts'

export default mergeConfig(
  baseConfig,
  defineConfig({
    optimizeDeps: { include: ['mcl-wasm'] },
    test: {
      exclude: [...configDefaults.exclude, 'test/eips/_*.spec.ts', 'test/precompiles/_*.spec.ts'],
    },
  }),
)
