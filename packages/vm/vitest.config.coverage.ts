import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from './vitest.config.ts'

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      coverage: {
        provider: 'v8',
        enabled: true,
        all: true,
        include: ['src/**'],
        reporter: ['text', 'lcov'],
        thresholds: {
          statements: 90,
          lines: 90,
        },
      },
    },
  }),
)
