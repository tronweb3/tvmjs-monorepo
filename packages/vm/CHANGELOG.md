# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Features

- **TRON TVM test suite**: Add initial TVM integration tests including `AllowTvmCompatibleTvmTest` (RIPEMD160, Blake2f, gasPrice, chainId), `AllowTvmLondonTest` (baseFee), `BatchSendTest` (token transfer), `BatchValidateSignContractTest`, `ChargeTest` (energy overflow), `Create2Test`, `ExtCodeHashTest`, and `ValidateMultiSignContractTest`
- **TRC-10 token support in `runTx()`**: Add token balance validation via `state.tokenIdExists()` before executing token transfers; throw `No asset!` when token ID does not exist

### Bug Fixes

- Add `await` before `state.tokenIdExists()` call in `runTx()` — missing `await` caused token existence check to always return a Promise (truthy)
- Exclude TVM tests from browser test suite due to Node.js-only `solc` dependency

### Tests

- Add `ReviewFindings.spec.ts` for tracking audit finding verifications
- Add `ChargeTest` overflow test and `memory-level` dev dependency
- Skip EIP-4399 (PREVRANDAO) test — not supported in TRON
- Skip EIP-7480 dependent tests in t8ntool

### Chores

- Remove `@tvmjs/ethash` dev dependency
- Replace `@ethereumjs/*` namespace with `@tvmjs/*` across all sources
- Upgrade `tronweb` to `6.3.0`
- Bump package version to `1.0.0`
- Lock all dependency versions by removing `^` and `~` prefixes


