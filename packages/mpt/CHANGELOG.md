# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Unreleased

### Bug Fixes

- Retain the final checkpoint and its pending changes until the database batch succeeds. Failed commits remain readable and can be retried or reverted to the previous root.
- Reject non-empty `put()` writes when a referenced node on the target path is missing, preserving the state root and database instead of writing the new value into an ancestor branch.
- Release the trie write lock when `put()`, `del()`, `commit()` or `revert()` throws, so later mutations can proceed after recovery. Publish this fix in `1.0.2`; the already published `1.0.1` does not contain it.
- Reject an empty Merkle proof when root verification is requested for a non-empty trie. This validation is included in `1.0.2` and is absent from the published `1.0.1`.
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
