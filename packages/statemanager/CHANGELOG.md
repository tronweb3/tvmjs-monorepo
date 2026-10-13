# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Unreleased

### Features

- Give `RPCStateManager` a checkpoint-aware local TRC-10 registry seeded by `putAccount()`, so exact Token transfers can run from explicitly supplied replay state. Allow callers to supplement it with a snapshot-aware `tokenIdExists` resolver, preserved across shallow copies and block-tag changes; require explicit local Token balances because `eth_getProof` does not provide them.

### Breaking Changes

- Change `tokenIdExists()` to take an exact `bigint` TRC-10 token ID and track the MerkleStateManager token registry by `bigint`. Custom `StateManagerInterface` implementations must update the signature.
- Default MerkleStateManager and RPCStateManager configuration to `TronMainnet`, matching VM/TVM and transaction defaults. Supply Common explicitly for other TRON networks.

### Fixes

- Invalidate an account's cached storage trie when deleting it and keep storage trie cache keys consistent, so recreating the account cannot read or persist slots from its previous incarnation.
- Preserve account, code and storage rollback history across cache flushes and state-root reads. Restore pending writes on nested reverts so rejected blocks cannot leave cached state from discarded execution.
- Flush StatefulBinaryTreeStateManager account, code and storage changes directly to the binary tree so committed updates and account deletions survive cache clearing. Keep storage read-cache values RLP-encoded for subsequent reads.
- Implement SimpleStateManager's local TRC-10 registry using exact IDs from account assets, with nested checkpoint rollback and independent shallow copies. Normal Token transfers through `runTx()` no longer fail with an unimplemented-method error.
- Preserve MerkleStateManager Token registrations in shallow copies. Copy the registry and trie root from before the outermost open checkpoint, excluding uncommitted registrations and keeping subsequent writes isolated.

- Preserve RPCStateManager network, optional EIPs, custom crypto and `earliest` block tags across shallow copies while keeping caches independent.
- Commit RPC account, code and storage caches together so an outer revert also restores changes committed in an inner checkpoint.
- Clear the RPC original storage cache when changing the block tag or clearing caches, preventing reads from a previous snapshot.
- Make RPCBlockChain satisfy the TVM blockchain interface while explicitly rejecting block writes, removing the need for unsafe casts in read-only execution examples.
- Keep TRC-10 token registrations made inside nested checkpoints revertible. Only the outermost commit makes them permanent, so an enclosing revert no longer leaves `tokenIdExists()` reporting a discarded account's token.
- Copy SimpleStateManager TRC-10 balance maps across checkpoints and shallow copies so reverted, failed and independently copied executions cannot leak token transfers.
- Bind EIP-1186 account proofs to the StateManager state root and storage proofs to the authenticated account storage root; reject storage proofs for nonexistent accounts

### Chores

- Migrate RPC execution tests to TRON configurations and enable the same offline RPC, storage dump and proof tests in Node and Browser. Replace unavailable Binary Tree activation tests with TRON profile rejection coverage and preserve fixed data vectors.
- Clarify RPC provider requirements, state-root and Token limitations, and the retained standalone Binary Tree implementation in examples and documentation.
- Update internal `@tvmjs/*` dependencies for the coordinated TVMJS release

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
