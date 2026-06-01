# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Tests

- Update genesis `stateRoot` and block hash expectations to match TRON account model (includes `asset` and `activePermissions` fields in RLP encoding)
- Skip MuirGlacier-dependent tests in `iterator.spec.ts` and `reorg.spec.ts` (hardfork not supported)
- Comment out Ethash uncle validation test in `blockValidation.spec.ts` (depends on removed `@tvmjs/ethash`)

### Chores

- Remove `@tvmjs/ethash` dev dependency; remove `ethash` and `genesis` from TypeScript project references
- Rename package namespace from `@ethereumjs/blockchain` to `@tvmjs/blockchain`; update all internal imports to `@tvmjs/*`
- Bump package version to `1.0.0`
- Lock all dependency versions by removing `^` and `~` prefixes

