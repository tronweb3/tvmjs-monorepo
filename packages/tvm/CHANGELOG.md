# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Unreleased

## 1.1.0

### Bug Fixes

- Make public `runCall()` failures exception-atomic across initialization, execution, and `afterMessage`: hook errors now revert caller nonce, balance, created accounts, journal, transient storage, and block-level access-list checkpoints, while ordinary TVM execution errors preserve the existing top-level nonce semantics
- Keep Journal checkpoint, commit, and revert bookkeeping aligned when the underlying StateManager operation rejects; retry transient rollback failures without leaking caller state or checkpoint depth
- Preserve EventEmitter registration order, `once()`, and custom listener-context semantics when awaiting hook callbacks, including listeners that throw
- Skip outer checkpoint revert when an inner checkpoint remains active after rollback retries, preserving StateManager stack alignment instead of reverting the wrong layer
- Restore the exact EIP-7928 block access-list snapshot for host hook failures while retaining read-preservation semantics for ordinary EVM frame reverts
- Align `CALLTOKEN` and `TOKENBALANCE` with java-tron by validating only the TRC-10 token ID range, allowing valid but unissued IDs to continue or return zero without requiring `StateManager.tokenIdExists()`
- Bound TRON signature precompile parsing by checking the 0x09/0x0a signature count before extraction and always extracting fixed 65-byte signatures, preventing caller-controlled ABI length words from driving oversized allocations
- Do not apply Ethereum EIP-170 runtime-size limits or EIP-3860 initcode limits and word metering to TRON chain profiles, independently of the selected hardfork; code-deposit energy and other deployment validation remain unchanged
- Serialize all public `runCall()` and `runCode()` executions on a TVM instance so shared transaction, block, state-manager, and journal context cannot be overwritten by overlapping calls; interpreter-driven recursive calls continue through the private entry point
- Validate a depth-0 TRON deployment's `rootTransactionId` before mutating the caller account, so invalid standalone calls cannot leak nonce changes
- Select Ethereum EIP-1014 or TRON CREATE2 address derivation by hardfork instead of applying TRON's `0x41` preimage globally
- Advance the shared TRON internal nonce for depth-0 `SELFDESTRUCT`, matching java-tron's unconditional `increaseNonce()` behavior
- Derive depth-0 TRON contract deployment addresses from the transaction ID and owner address instead of Ethereum's RLP sender/nonce formula; TRON deployments now require `rootTransactionId`
- Do not advance the shared TRON internal nonce when `CALLTOKEN` is rejected for insufficient token balance
- Align TRON `SELFDESTRUCT` new-account gas with java-tron: charge when the beneficiary does not exist regardless of transferred value, do not charge for an existing empty account, and preserve Ethereum EIP-161 behavior on pre-TRON hardforks
- Derive TRON internal CREATE addresses from the root transaction ID and transaction-wide internal nonce; preserve Ethereum CREATE behavior on Ethereum hardfork paths
- Advance the shared TRON internal nonce after CREATE/CREATE2 collisions and on every nested `SELFDESTRUCT` invocation
- Reject non-`Uint8Array` root transaction IDs instead of silently coercing them into invalid execution context
- Return the java-tron-compatible 21-byte TRON address representation from CREATE/CREATE2 stack results while keeping internal account addresses 20 bytes
- Revert the active message checkpoint when an unexpected execution error propagates after checkpoint creation, including a missing TRON `rootTransactionId` reached by internal CREATE; a depth-0 deployment missing the ID is rejected before any state mutation or checkpoint
- Reinitialize transaction-scoped metadata and execution collections for every top-level prebuilt `Message` call, including reused messages
- Honor `runCall({ message, skipBalance })` for top-level prebuilt messages; for caller-supplied messages `skipBalance` is scoped to `depth === 0` so it cannot relax balance checks for nested execution, while messages built by `runCall` keep the previous any-depth behavior
- Keep profiler timers balanced for top-level prebuilt messages and cancel partial profiling sessions when execution throws
- Initialize an independent transaction context for standalone prebuilt messages at `depth > 0` while preserving the outer context for interpreter-driven nested calls
- Align TRON version-0 call and create energy forwarding with java-tron (full available-energy forwarding), while preserving Ethereum EIP-150 forwarding
- Gate TIP-854 strict calldata-shape failures for `0x09` / `0x0a` on TRON Proposal 96 / Osaka and consume the complete forwarded gas on invalid input

### Features

- Add `rootTransactionId` execution context support and propagate the shared TRON internal nonce across nested CALL, CREATE, and CREATE2 operations
- **Compatibility notice:** Without an explicit `Common`, `createTVM()` now uses the execution-only `TronMainnet` configuration (chainId 728126428, hardfork `tron`). Pass `new Common({ chain: Mainnet })` for Ethereum Mainnet rules (chainId 1, currently hardfork `prague`). The legacy explicit `new Common({ chain: Mainnet, hardfork: 'tron' })` form is accepted and normalized to `TronMainnet`; new code should use `TronMainnet` directly

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
