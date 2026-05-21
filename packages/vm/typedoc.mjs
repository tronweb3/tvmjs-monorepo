export default {
  extends: '../../config/typedoc.mjs',
  entryPoints: ['src'],
  out: 'docs',
  exclude: ['test/**/*.ts', 'src/bloom/*.ts', 'src/tvm/**', 'src/state/cache.ts'],
}
