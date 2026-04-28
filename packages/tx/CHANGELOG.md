# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Features

- **TRC-10 token support**: Add `tokenId` and `tokenValue` fields to all transaction types (Legacy, EIP-1559, EIP-2930, EIP-4844, EIP-7702); expose both fields in `TxData` / `JsonTx` types and include them in serialization via `internal.ts` ([4932e3ce](https://github.com/tronweb3/tvmjs-monorepo/commit/4932e3ce3))

### Tests

- Rename `eip7825.spec.ts`, `t9n.spec.ts`, and `transactionRunner.spec.ts` with underscore prefix to skip incompatible tests ([69bc8350](https://github.com/tronweb3/tvmjs-monorepo/commit/69bc83500))
- Skip EIP-4844 invalid constructor scenario tests (not supported in TRON) ([69bc8350](https://github.com/tronweb3/tvmjs-monorepo/commit/69bc83500))

### Chores

- Rename package namespace from `@ethereumjs/tx` to `@tvmjs/tx`; update all internal imports to `@tvmjs/*` ([c7375e86](https://github.com/tronweb3/tvmjs-monorepo/commit/c7375e86e))
- Bump package version to `1.0.0` ([792f019f](https://github.com/tronweb3/tvmjs-monorepo/commit/792f019fa))
- Lock all dependency versions by removing `^` and `~` prefixes ([96f52e19](https://github.com/tronweb3/tvmjs-monorepo/commit/96f52e194))
- Remove generated docs files ([ad015266](https://github.com/tronweb3/tvmjs-monorepo/commit/ad015266b))


