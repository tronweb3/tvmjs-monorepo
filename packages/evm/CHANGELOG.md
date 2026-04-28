# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Features

- **TRON support**: Add TRC-10 token transfer logic (`_reduceSenderTokenBalance`, `_addToTokenBalance`) to EVM message execution flow for both calls and contract creation; add TRON-specific error messages `CAN_NOT_TRANSFER_TRX_YOURSELF` and `CAN_NOT_TRANSFER_ASSET_YOURSELF`; add TRON precompiles (`fe-validate-multi-sign`, `ff-batch-validate-sign`, `dataWord`) ([0b98d408](https://github.com/tronweb3/tvmjs-monorepo/commit/0b98d4086))
- **TRC-10 token transfer**: Integrate token balance reduction and addition into contract creation flow; add `tokenId`/`tokenValue` fields to `Message` type ([63c75362](https://github.com/tronweb3/tvmjs-monorepo/commit/63c753628))
- **TRON difficulty**: Update difficulty calculation for TRON consensus model ([2eb554e4](https://github.com/tronweb3/tvmjs-monorepo/commit/2eb554e4f))
- **Custom Precompiles API**: Add `PrefixedHexString` support for custom precompile addresses, add `getPrecompile()` function, and export additional precompile types ([f69b0584](https://github.com/tronweb3/tvmjs-monorepo/commit/f69b05846))

### Bug Fixes

- Add insufficient token balance check in `_reduceSenderTokenBalance` to prevent underflow; throw `INSUFFICIENT_TOKEN_BALANCE` error ([003d1426](https://github.com/tronweb3/tvmjs-monorepo/commit/003d14260))
- Disable `KZG_POINT_EVALUATION` precompile (EIP-4844) — not supported by TRON ([db09f2d6](https://github.com/tronweb3/tvmjs-monorepo/commit/db09f2d69))
- Fix precompile address names: correct TRON RIPEMD160 address mapping and blake2f name lookup for address `20009` ([cea5cd24](https://github.com/tronweb3/tvmjs-monorepo/commit/cea5cd24f), [c1a78a20](https://github.com/tronweb3/tvmjs-monorepo/commit/c1a78a204))
- Always use mainnet address prefix (`0x41`) and hardcode `isMainnet` to `true` in precompile address resolution ([b8014fc0](https://github.com/tronweb3/tvmjs-monorepo/commit/b8014fc0b))
- Disable EIP-7480 (EOF data section access) from supported EIPs list ([63b32ef9](https://github.com/tronweb3/tvmjs-monorepo/commit/63b32ef9d))
- Remove duplicate imports introduced during merge conflict resolution ([1f25bdc8](https://github.com/tronweb3/tvmjs-monorepo/commit/1f25bdc89))

### Tests

- Rename EOF/EIP test files with underscore prefix to skip incompatible tests (`eip-5450`, `eof-header-validation`, `eof-runner`) ([15a7739b](https://github.com/tronweb3/tvmjs-monorepo/commit/15a7739bf))

### Chores

- Rename package namespace from `@ethereumjs/evm` to `@tvmjs/evm`; update all internal imports ([c7375e86](https://github.com/tronweb3/tvmjs-monorepo/commit/c7375e86e))
- Bump package version to `1.0.0` ([792f019f](https://github.com/tronweb3/tvmjs-monorepo/commit/792f019fa))
- Lock all dependency versions by removing `^` and `~` prefixes ([96f52e19](https://github.com/tronweb3/tvmjs-monorepo/commit/96f52e194))
- Remove generated docs files ([ad015266](https://github.com/tronweb3/tvmjs-monorepo/commit/ad015266b))


