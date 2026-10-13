import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const config = defineConfig({
  test: {
    exclude: ['**/test/**/_*.spec.ts'],
    browser: {
      enabled: true,
      headless: true,
      fileParallelism: false,
      provider: playwright(),
      instances: [
        {
          browser: 'chromium',
          headless: true,
          isolate: true,
        },
      ],
    },
    maxConcurrency: 1
  },
  resolve: {
    conditions: ['typescript'],
  },
})

export default config
