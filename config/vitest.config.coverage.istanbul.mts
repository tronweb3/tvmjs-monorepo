import { defineConfig } from 'vitest/config'

const config = defineConfig({
  test: {
    exclude: ['**/test/**/_*.spec.ts'],
    silent: true,
    testTimeout: 180000,
    coverage: {
      extension: ['.ts'],
      provider: 'istanbul',
      enabled: true,
      all: true,
      include: ['src/**'],
      reportsDirectory: './coverage/istanbul',
      thresholds: {
        statements: 90,
        lines: 90,
      },
    },
  },
})

export default config
