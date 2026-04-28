# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Features

- **TRON TVM test suite**: Add initial TVM integration tests including `AllowTvmCompatibleEvmTest` (RIPEMD160, Blake2f, gasPrice, chainId), `AllowTvmLondonTest` (baseFee), `BatchSendTest` (token transfer), `BatchValidateSignContractTest`, `ChargeTest` (energy overflow), `Create2Test`, `ExtCodeHashTest`, and `ValidateMultiSignContractTest` ([dd8558daa](https://github.com/tronweb3/tvmjs-monorepo/commit/dd8558daa))
- **TRC-10 token support in `runTx()`**: Add token balance validation via `state.tokenIdExists()` before executing token transfers; throw `No asset!` when token ID does not exist ([7676d09cd](https://github.com/tronweb3/tvmjs-monorepo/commit/7676d09cd))

### Bug Fixes

- Add `await` before `state.tokenIdExists()` call in `runTx()` — missing `await` caused token existence check to always return a Promise (truthy) ([451220b3](https://github.com/tronweb3/tvmjs-monorepo/commit/451220b33))
- Exclude TVM tests from browser test suite due to Node.js-only `solc` dependency ([c4b75406](https://github.com/tronweb3/tvmjs-monorepo/commit/c4b75406f))

### Tests

- Add `ReviewFindings.spec.ts` for tracking audit finding verifications ([ee62b943](https://github.com/tronweb3/tvmjs-monorepo/commit/ee62b943a))
- Add `ChargeTest` overflow test and `memory-level` dev dependency ([6df687d24](https://github.com/tronweb3/tvmjs-monorepo/commit/6df687d24))
- Skip EIP-4399 (PREVRANDAO) test — not supported in TRON ([7f35a537](https://github.com/tronweb3/tvmjs-monorepo/commit/7f35a5373))
- Skip EIP-7480 dependent tests in t8ntool ([f6d0657f](https://github.com/tronweb3/tvmjs-monorepo/commit/f6d0657f1))

### Chores

- Remove `@tvmjs/ethash` dev dependency ([88d776ee](https://github.com/tronweb3/tvmjs-monorepo/commit/88d776ee5))
- Replace `@ethereumjs/*` namespace with `@tvmjs/*` across all sources ([c7375e86](https://github.com/tronweb3/tvmjs-monorepo/commit/c7375e86e))
- Upgrade `tronweb` to `6.3.0` ([01e9ea5a](https://github.com/tronweb3/tvmjs-monorepo/commit/01e9ea5a8))
- Bump package version to `1.0.0` ([792f019f](https://github.com/tronweb3/tvmjs-monorepo/commit/792f019fa))
- Lock all dependency versions by removing `^` and `~` prefixes ([96f52e19](https://github.com/tronweb3/tvmjs-monorepo/commit/96f52e194))
- Remove generated docs files ([ad015266](https://github.com/tronweb3/tvmjs-monorepo/commit/ad015266b))


