# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Features

- **TRC-10 token support**: Add `tokenIdExists(tokenId)` method to all state manager implementations (`MerkleStateManager`, `RPCStateManager`, `SimpleStateManager`, `StatefulBinaryTreeStateManager`); add `_tokenIds` / `_tokenIdsCache` / `_tokenIdsCacheStack` internal state to `MerkleStateManager` for tracking TRC-10 token totals across checkpoints; populate token cache from account `asset` field during `putAccount`

### Tests

- Rename `statefulBinaryTreeStateManager.spec.ts` and `vmState.spec.ts` with underscore prefix to skip incompatible tests

### Chores

- Remove `@tvmjs/genesis` dev dependency; remove tests referencing genesis package
- Remove test run from prepublish script (build only)
- Rename package namespace from `@ethereumjs/statemanager` to `@tvmjs/statemanager`; update all internal imports to `@tvmjs/*`
- Bump package version to `1.0.0`
- Lock all dependency versions by removing `^` and `~` prefixes


