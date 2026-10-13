# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Unreleased

- Add an experimental java-tron RPC Client PoC that loads blocks, transactions, accounts,
  balances, code and storage for local read-only TVM execution, compares the result with
  `triggerconstantcontract`, and reports snapshot consistency and Energy differences.

- Verify 71 measured java-tron execution cases through signed local transactions with both StateManagers. Compare execution Energy and state separately from transaction-envelope overhead, and correct storage-transition expectations for zero slots already written in the transaction.

### Breaking Changes

- Reject the removed `tvmOpts.allowUnlimitedContractSize` and `tvmOpts.allowUnlimitedInitCodeSize` options before initialization. Remove EIP-3860 deployment test assumptions and cover VM/TVM consistency for large deployments, exact code deposit Energy, failure receipts and state rollback across all three TRON networks and retained transaction types.
- Remove EIP-7702 authorization processing, authority nonce/code updates, authorization refunds and the delegated-sender exception. Reject retired transaction contexts before events/checkpoints in transaction, block and builder entry points; retain ordinary execution, sender-code validation and rollback.
- Remove EIP-4788 Beacon root initialization, ring-buffer writes and `historicalRootsLength`. Reject retired header fields in `runTx()`, `runBlock()` and block builders before events, checkpoints or state-root changes.
- Remove Blob fees, receipt metadata and block-builder options. Reject type `0x03` and `allowNoBlobs` before state checkpoints; `generateTxReceipt()` now takes four arguments.
- Remove transaction prewarming and use the TVM's TRON Energy schedule. Access lists remain diagnostic metadata; transaction envelope overhead remains separate from execution Energy.
- Use TRON-only configuration throughout VM execution and block construction. Execution presets no longer imply Ethereum consensus or block rewards.
- Reject conflicting Common settings across VM and TVM initialization, including parameter overrides that would otherwise be discarded.

### Fixes

- Cover signed TRC-10 transfers with SimpleStateManager and copied MerkleStateManager instances on all three TRON presets, including exact high IDs, unknown-ID rejection, failed execution rollback and subsequent transactions.

- Migrate the remaining VM API suites to TRON, including transaction fees and receipts, block rollback, code prefix validation, transient storage, account creation and full-width CHAINID results. Replace retired Ethereum activation tests with explicit rejection and no-side-effect regressions.
- Run the VM API suite from the package's default `test` command. Share the complete API suite with Chromium and use pinned TRON Solidity fixtures instead of downloading and compiling contracts during tests.
- Retire Ethereum state/blockchain FORKS runners, execution-spec fixture runners and their submodule, t8n/retesteth filling tools, and the Ethereum block benchmark. Remove their commands and unused development dependencies; Ethereum official execution vectors are not part of the TRON regression results. Keep local fixed vectors and their source attribution where still used.
- Preserve execution trace regressions outside the retired filling tools and report memory size in bytes (32 per word).
- Remove DAO balance migration and London activation-block builder defaults. Builders derive fees from the parent, retain explicit overrides and inherit the parent gas limit; historical Ethereum heights do not change TRON account balances.
- Replace EIP-1283/2200/2929/3529/3651 pricing tests with TRON storage-transition, zero-refund, repeated-access, coinbase, nested-revert and Energy-boundary regressions. Preserve 17 storage transition sequences and ordinary signed transaction fee validation.
- Migrate custom-state and Clique sealing regressions to explicit TRON configuration; preserve genesis/consensus compatibility checks after removal of Common's metadata overrides and Geth constructor.
- Validate transaction TRC-10 token existence and the sender balance by exact token ID instead of a `Number` conversion.
- Verify equal execution Energy and state changes through VM and direct TVM calls, including CALLTOKEN rollback and empty-recipient handling across transactions.
- Match the pinned java-tron ChargeTest deployment cost without an extra memory/copy base fee.
- Remove the redundant TRON hardfork guard from transaction ID fallback selection. Move transaction ID policy regressions into a standalone TRON suite covering hash fallback, explicit IDs and strict mode.
- Keep equivalent VM/TVM configurations on one shared Common without mutating caller options.
- Migrate local transaction, block and contract examples; retire Ethereum Mainnet, Goerli and Blob execution examples.

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
