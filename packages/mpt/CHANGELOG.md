# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Unreleased

### Bug Fixes

- Keep checkpoint reads and final batch commits coherent with the optional LRU cache so speculative puts and deletions cannot be masked by stale cached values

### Documentation

- Clarify that `verifyMerkleProof()` checks proof self-consistency against the proof-derived root and that callers authenticating against a trusted root must use `verifyMPTWithMerkleProof()`

### Chores

- Update internal `@tvmjs/*` dependencies for the coordinated TVMJS release

## 1.0.0

### Tests

- Rename `genesisState.spec.ts` to `_genesisState.spec.ts` to skip incompatible genesis state test
- Remove `@tvmjs/genesis` dev dependency; comment out mainnet genesis stateRoot test that depended on it

### Chores

- Rename package namespace from `@ethereumjs/mpt` to `@tvmjs/mpt`; update all internal imports to `@tvmjs/*`
- Bump package version to `1.0.0`
- Lock all dependency versions by removing `^` and `~` prefixes

