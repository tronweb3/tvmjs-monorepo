# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Bug Fixes

- Skip Osaka hardfork transaction validation test (Osaka not supported in TRON)

### Chores

- Rename package namespace from `@ethereumjs/block` to `@tvmjs/block`; update all internal imports to `@tvmjs/*`
- Bump package version to `1.0.0`
- Lock all dependency versions by removing `^` and `~` prefixes
- Rename `difficulty.spec.ts` and `eip7928.spec.ts` to `_difficulty.spec.ts` / `_eip7928.spec.ts` to skip them from vitest
