# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Tests

- Rename `genesisState.spec.ts` to `_genesisState.spec.ts` to skip incompatible genesis state test ([ab031a43](https://github.com/tronweb3/tvmjs-monorepo/commit/ab031a436))
- Remove `@tvmjs/genesis` dev dependency; comment out mainnet genesis stateRoot test that depended on it ([c0da711a](https://github.com/tronweb3/tvmjs-monorepo/commit/c0da711ab))

### Chores

- Rename package namespace from `@ethereumjs/mpt` to `@tvmjs/mpt`; update all internal imports to `@tvmjs/*` ([c7375e86](https://github.com/tronweb3/tvmjs-monorepo/commit/c7375e86e))
- Bump package version to `1.0.0` ([792f019f](https://github.com/tronweb3/tvmjs-monorepo/commit/792f019fa))
- Lock all dependency versions by removing `^` and `~` prefixes ([96f52e19](https://github.com/tronweb3/tvmjs-monorepo/commit/96f52e194))
- Remove generated docs files ([ad015266](https://github.com/tronweb3/tvmjs-monorepo/commit/ad015266b))


