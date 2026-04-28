# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Bug Fixes

- Skip Osaka hardfork transaction validation test (Osaka not supported in TRON) ([d9f48a4b](https://github.com/tronweb3/tvmjs-monorepo/commit/d9f48a4b5))

### Chores

- Rename package namespace from `@ethereumjs/block` to `@tvmjs/block`; update all internal imports to `@tvmjs/*` ([c7375e86](https://github.com/tronweb3/tvmjs-monorepo/commit/c7375e86e))
- Bump package version to `1.0.0` ([792f019f](https://github.com/tronweb3/tvmjs-monorepo/commit/792f019fa))
- Lock all dependency versions by removing `^` and `~` prefixes ([96f52e19](https://github.com/tronweb3/tvmjs-monorepo/commit/96f52e194))
- Rename `difficulty.spec.ts` and `eip7928.spec.ts` to `_difficulty.spec.ts` / `_eip7928.spec.ts` to skip them from vitest ([d9f48a4b](https://github.com/tronweb3/tvmjs-monorepo/commit/d9f48a4b5))
- Remove generated docs files ([ad015266](https://github.com/tronweb3/tvmjs-monorepo/commit/ad015266b))

