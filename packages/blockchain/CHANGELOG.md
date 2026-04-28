# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Tests

- Update genesis `stateRoot` and block hash expectations to match TRON account model (includes `asset` and `activePermissions` fields in RLP encoding) ([eed949c3](https://github.com/tronweb3/tvmjs-monorepo/commit/eed949c32))
- Skip MuirGlacier-dependent tests in `iterator.spec.ts` and `reorg.spec.ts` (hardfork not supported) ([eed949c3](https://github.com/tronweb3/tvmjs-monorepo/commit/eed949c32))
- Comment out Ethash uncle validation test in `blockValidation.spec.ts` (depends on removed `@tvmjs/ethash`) ([88d776ee](https://github.com/tronweb3/tvmjs-monorepo/commit/88d776ee5))

### Chores

- Remove `@tvmjs/ethash` dev dependency; remove `ethash` and `genesis` from TypeScript project references ([88d776ee](https://github.com/tronweb3/tvmjs-monorepo/commit/88d776ee5), [e09b854c](https://github.com/tronweb3/tvmjs-monorepo/commit/e09b854ce))
- Rename package namespace from `@ethereumjs/blockchain` to `@tvmjs/blockchain`; update all internal imports to `@tvmjs/*` ([c7375e86](https://github.com/tronweb3/tvmjs-monorepo/commit/c7375e86e))
- Bump package version to `1.0.0` ([792f019f](https://github.com/tronweb3/tvmjs-monorepo/commit/792f019fa))
- Lock all dependency versions by removing `^` and `~` prefixes ([96f52e19](https://github.com/tronweb3/tvmjs-monorepo/commit/96f52e194))
- Remove generated docs files ([ad015266](https://github.com/tronweb3/tvmjs-monorepo/commit/ad015266b))

