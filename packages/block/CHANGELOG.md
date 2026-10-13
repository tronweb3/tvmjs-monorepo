# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Unreleased

### Breaking Changes

- Remove London activation-block fee/gas-limit special cases and the protected `_validateDAOExtraData()` hook. Preserve ordinary base-fee arithmetic, header defaults and gas-limit validation; PoW/Clique public tools remain available with explicit metadata.
- Reject serialized headers missing the required `baseFeePerGas` field at every height, instead of silently filling it from object-constructor defaults. Complete TRON header serialization and hashes are unchanged.
- Reject EIP-7702 type `0x04` and authorization fields through block object, RPC, RLP and payload inputs, including already-instantiated transactions passed to the Block constructor.
- Remove EIP-4788 Beacon root fields from headers, public types, serialization and RPC/payload mappings. Reject both field spellings, including explicitly empty values, while preserving ordinary TRON block hashes and Beacon payload data conversion.
- Remove Blob header fields, fee helpers and transaction validation. Reject retired fields before RPC/payload mapping and reject old extended RLP headers without changing ordinary TRON field order.
- Default execution blocks to `TronMainnet`. Do not require inherited Ethereum consensus metadata for execution headers, and reject uncle headers when using execution-only presets.

### Fixes

- Recompute the transaction trie root on every validation so changes to a Block's transaction list or serialized transaction contents cannot reuse a stale root and bypass header/body consistency checks.
- Recompute the withdrawals trie root on every validation to avoid stale roots in the retained EIP-4895 validator. Withdrawals remain unavailable in TRON execution profiles.
- Preserve large decimal RPC difficulty values with direct bigint conversion.
- Reject inactive RLP block-body extensions instead of silently dropping withdrawals or other trailing fields.
- Reject RPC transaction-hash arrays with an actionable message requiring full transaction objects; header-only decoding remains available.

### Tests

- Migrate retained Node and Browser suites to TRON configuration, preserving base-fee, serialization, signed Token JSON/RPC round trips, and explicit PoW/Clique/PoS tool coverage.
- Replace retired Ethereum activation tests with capability and input rejection checks. Keep standalone withdrawal/request vectors; retire the external multi-Hardfork difficulty runner and excluded BAL activation test. Official Ethereum vectors remain unexecuted.
- Migrate runnable examples and document the separation between execution blocks and retained data/consensus tools.

### Chores

- Update internal `@tvmjs/*` dependencies for the coordinated TVMJS release

## 1.0.0

### Bug Fixes

- Skip Osaka hardfork transaction validation test (Osaka not supported in TRON)

### Chores

- Rename package namespace from `@ethereumjs/block` to `@tvmjs/block`; update all internal imports to `@tvmjs/*`
- Bump package version to `1.0.0`
- Lock all dependency versions by removing `^` and `~` prefixes
- Rename `difficulty.spec.ts` and `eip7928.spec.ts` to `_difficulty.spec.ts` / `_eip7928.spec.ts` to skip them from vitest
