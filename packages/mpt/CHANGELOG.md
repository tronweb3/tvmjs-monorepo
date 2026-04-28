# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Tests

- Rename `genesisState.spec.ts` to `_genesisState.spec.ts` to skip incompatible genesis state test
- Remove `@tvmjs/genesis` dev dependency; comment out mainnet genesis stateRoot test that depended on it

### Chores

- Rename package namespace from `@ethereumjs/mpt` to `@tvmjs/mpt`; update all internal imports to `@tvmjs/*`
- Bump package version to `1.0.0`
- Lock all dependency versions by removing `^` and `~` prefixes


