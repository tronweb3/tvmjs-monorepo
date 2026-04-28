# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Features

- **TRC-10 token support**: Add `tokenIdExists(tokenId)` method to all state manager implementations (`MerkleStateManager`, `RPCStateManager`, `SimpleStateManager`, `StatefulBinaryTreeStateManager`); add `_tokenIds` / `_tokenIdsCache` / `_tokenIdsCacheStack` internal state to `MerkleStateManager` for tracking TRC-10 token totals across checkpoints; populate token cache from account `asset` field during `putAccount` ([4932e3ce](https://github.com/tronweb3/tvmjs-monorepo/commit/4932e3ce3))

### Tests

- Rename `statefulBinaryTreeStateManager.spec.ts` and `vmState.spec.ts` with underscore prefix to skip incompatible tests ([c76fba20](https://github.com/tronweb3/tvmjs-monorepo/commit/c76fba205))

### Chores

- Remove `@tvmjs/genesis` dev dependency; remove tests referencing genesis package ([c0da711a](https://github.com/tronweb3/tvmjs-monorepo/commit/c0da711ab))
- Remove test run from prepublish script (build only) ([59860bea](https://github.com/tronweb3/tvmjs-monorepo/commit/59860bea3))
- Rename package namespace from `@ethereumjs/statemanager` to `@tvmjs/statemanager`; update all internal imports to `@tvmjs/*` ([c7375e86](https://github.com/tronweb3/tvmjs-monorepo/commit/c7375e86e))
- Bump package version to `1.0.0` ([792f019f](https://github.com/tronweb3/tvmjs-monorepo/commit/792f019fa))
- Lock all dependency versions by removing `^` and `~` prefixes ([96f52e19](https://github.com/tronweb3/tvmjs-monorepo/commit/96f52e194))
- Remove generated docs files ([ad015266](https://github.com/tronweb3/tvmjs-monorepo/commit/ad015266b))


