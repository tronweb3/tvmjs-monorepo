# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Unreleased

## 1.1.0

### Bug Fixes

- Revert the complete block checkpoint when request accumulation, state-root generation, generated-field construction, or pre-commit validation fails after transaction execution
- Preserve 1.0.x simulator compatibility without reverting TRON address derivation: `runTx()` now uses the signed TVMJS transaction hash as a deterministic simulation ID when a TRON deployment or internal CREATE has no explicit `rootTransactionId`
- Add `TronTransactionIdPolicy` with a default `fallback-to-tx-hash` mode and an opt-in `require-explicit` mode for real-chain replay and consistency testing; explicit IDs always take precedence
- Forward the transaction ID policy through `runBlock()` and block builders while keeping fallback resolution centralized in `runTx()`
- Validate the transaction ID policy at `runTx()`, `runBlock()`, and block-builder public boundaries before hooks, checkpoints, hardfork changes, state cleanup, or block access-list replacement
- Forward `rootTransactionId` for both java-tron-compatible top-level contract deployment and internal CREATE address derivation; `runBlock()` accepts transaction-indexed `rootTransactionIds`, and block builders accept an ID per added transaction
- Keep VM and TVM `Common`, `StateManager`, and exposed blockchain instances consistent when supplied through a custom TVM or `tvmOpts`
- Reject EIP-155 and typed transactions whose chainId does not match the VM while preserving support for unprotected legacy transactions. Transactions executed by the default TRON VM must be constructed with the same `Common`, for example `createLegacyTx(data, { common: vm.common })`
- Align TRON version-0 CALL/CREATE energy forwarding with java-tron and apply TIP-854 invalid-calldata failures only when the TRON Proposal 96 / Osaka gate is active
- Preserve EventEmitter registration order, `once()`, and custom listener-context semantics for VM block and transaction events, including listeners that throw

### Features

- Add an optional `rootTransactionId` to `RunTxOpts` and forward it to TVM for java-tron-compatible internal CREATE address derivation
- **Compatibility notice:** Without an explicit `Common`, `createVM()` now uses the execution-only `TronMainnet` configuration (chainId 728126428, hardfork `tron`). Pass `new Common({ chain: Mainnet })` for Ethereum Mainnet rules (chainId 1, currently hardfork `prague`). The legacy explicit `new Common({ chain: Mainnet, hardfork: 'tron' })` form is accepted and normalized to `TronMainnet`; new code should use `TronMainnet` directly. Chain-bound transactions must use the VM's normalized `Common`; unprotected legacy transactions remain accepted because they do not encode a chainId

### Documentation

- Document that the TVMJS transaction hash fallback is not a java-tron transaction ID and add migration examples for simulation and real-chain replay

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
