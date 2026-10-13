# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Unreleased

### Bug Fixes

- Retain the final checkpoint and its pending changes until the database batch succeeds. Failed commits remain readable and can be retried or reverted to the previous root.
- Serialize `put()` and `del()` through node and root persistence so concurrent writes on one tree cannot lose successful updates. Share the lock with `commit()` and `revert()`, check checkpoint availability under the lock, and always release it on errors.
- Clear child references and update ancestor hashes when deleting a stem's last value, including nested branches, so deleted values cannot remain reachable
- Collapse branches left with a single stem after deletion, so the state root equals the root of a tree built from the remaining stems only
- Accept non-existence proofs that end at an internal node or at an empty root in `verifyBinaryProof()` instead of throwing a `TypeError`
- Persist the root after every `put()`/`del()` when `useRootPersistence` is enabled, and read the persisted root back with the key encoding used for writing
- Keep checkpoint reads and final batch commits coherent with the optional LRU cache so speculative puts and deletions cannot be masked by stale cached values

### Chores

- Update internal `@tvmjs/*` dependencies for the coordinated TVMJS release

## 1.0.0

### Chores

- Rename package namespace from `@ethereumjs/binarytree` to `@tvmjs/binarytree`; update all internal imports from `@ethereumjs/util` / `@ethereumjs/rlp` to `@tvmjs/util` / `@tvmjs/rlp`
- Bump package version to `1.0.0`
- Lock all dependency versions by removing `^` and `~` prefixes (`@noble/hashes`, `debug`, `@types/debug`)
