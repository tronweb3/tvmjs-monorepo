# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Bug Fixes

- Fix `hexToBytes()` to correctly strip the `0x` prefix (`hex.slice(2)`) instead of keeping only the prefix (`hex.slice(0, 2)`) — previously caused all `0x`-prefixed hex strings to decode incorrectly ([314d2c63](https://github.com/tronweb3/tvmjs-monorepo/commit/314d2c631))

### Chores

- Rename package namespace from `@ethereumjs/rlp` to `@tvmjs/rlp` ([c7375e86](https://github.com/tronweb3/tvmjs-monorepo/commit/c7375e86e))
- Bump package version to `1.0.0` ([792f019f](https://github.com/tronweb3/tvmjs-monorepo/commit/792f019fa))
- Lock all dependency versions by removing `^` and `~` prefixes ([96f52e19](https://github.com/tronweb3/tvmjs-monorepo/commit/96f52e194))


