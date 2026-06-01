# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Features

- **TRON support**: Add TRC-10 token transfer logic (`_reduceSenderTokenBalance`, `_addToTokenBalance`) to TVM message execution flow for both calls and contract creation; add TRON-specific error messages `CAN_NOT_TRANSFER_TRX_YOURSELF` and `CAN_NOT_TRANSFER_ASSET_YOURSELF`; add TRON precompiles (`fe-validate-multi-sign`, `ff-batch-validate-sign`, `dataWord`)
- **TRC-10 token transfer**: Integrate token balance reduction and addition into contract creation flow; add `tokenId`/`tokenValue` fields to `Message` type
- **TRON difficulty**: Update difficulty calculation for TRON consensus model
- **Custom Precompiles API**: Add `PrefixedHexString` support for custom precompile addresses, add `getPrecompile()` function, and export additional precompile types

### Bug Fixes

- Add insufficient token balance check in `_reduceSenderTokenBalance` to prevent underflow; throw `INSUFFICIENT_TOKEN_BALANCE` error
- Disable `KZG_POINT_EVALUATION` precompile (EIP-4844) — not supported by TRON
- Fix precompile address names: correct TRON RIPEMD160 address mapping and blake2f name lookup for address `20009`
- Always use mainnet address prefix (`0x41`) and hardcode `isMainnet` to `true` in precompile address resolution
- Disable EIP-7480 (EOF data section access) from supported EIPs list
- Remove duplicate imports introduced during merge conflict resolution

### Tests

- Rename EOF/EIP test files with underscore prefix to skip incompatible tests (`eip-5450`, `eof-header-validation`, `eof-runner`)

### Chores

- Rename package namespace from `@ethereumjs/tvm` to `@tvmjs/tvm`; update all internal imports
- Bump package version to `1.0.0`
- Lock all dependency versions by removing `^` and `~` prefixes


