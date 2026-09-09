# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Unreleased

### Bug Fixes

- Keep checkpoint reads and final batch commits coherent with the optional LRU cache so speculative puts and deletions cannot be masked by stale cached values

### Chores

- Update internal `@tvmjs/*` dependencies for the coordinated TVMJS release

## 1.0.0

### Chores

- Rename package namespace from `@ethereumjs/binarytree` to `@tvmjs/binarytree`; update all internal imports from `@ethereumjs/util` / `@ethereumjs/rlp` to `@tvmjs/util` / `@tvmjs/rlp`
- Bump package version to `1.0.0`
- Lock all dependency versions by removing `^` and `~` prefixes (`@noble/hashes`, `debug`, `@types/debug`)

