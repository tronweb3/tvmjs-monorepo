import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
export default defineConfig({
  test: {
    exclude: ['**/test/**/_*.spec.ts'],
  },
  environments: {
    ssr: {
      resolve: {
        conditions: ['typescript'],
      },
    },
  },
})
