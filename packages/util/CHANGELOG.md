# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Unreleased

### Bug Fixes

- Allow host-level execution failures to restore an exact block access-list checkpoint, including internal balance/code net-zero tracking, without preserving data from the rejected attempt
- Restore `generateAddress2()` to Ethereum EIP-1014's `0xff` derivation and add a separate `generateTronAddress2()` helper using TRON's `0x41` hash preimage. Code upgrading from 1.0.0 that called `generateAddress2()` directly for TRON addresses must migrate to `generateTronAddress2()`
- Reject non-`Uint8Array` inputs in TRON address output helpers instead of silently coercing them into valid-looking incorrect addresses, and validate Base58 input type and length before decoding
- Add java-tron-compatible top-level contract address derivation from the transaction ID and 21-byte TRON owner address

### Features

- Add `generateTronCreateAddress(rootTransactionId, nonce)` for java-tron-compatible internal CREATE address derivation while preserving Ethereum `generateAddress()` behavior
- Add TRON address format conversion utilities: `toTronHexAddress`, `fromTronHexAddress` (0x41-prefixed hex), `toTronBase58Address`, `fromTronBase58Address`, `isValidTronBase58Address` (Base58Check with checksum); vectors cross-validated against TronWeb 6.3.0
- Add `bs58` dependency for Base58Check encoding

## 1.0.0

### Features

- **TRON Account model**: Extend `Account` class with `asset` (TRC-10 token balances, `{ [tokenId]: bigint }`) and `activePermissions` (`Permission[]`) fields; add `Key` and `Permission` interfaces; include both fields in RLP serialization/deserialization
- **TRON CREATE2 address**: Change `generateAddress2()` prefix from `0xff` to `0x41` to match TRON's CREATE2 address derivation
- **`account.isEmpty()` token awareness**: Update `isEmpty()` to return `false` when account has non-zero TRC-10 token balances

### Bug Fixes

- Fix `account.isEmpty()` typo: `_nonce === null` → `_nonce !== null`, preventing nonce from being ignored in emptiness check
- Fix import in `bal.ts`: update `@ethereumjs/rlp` to `@tvmjs/rlp`

### Tests

- Update account serialization test to include `asset` and `activePermissions` fields
- Update EIP-1014 CREATE2 test vectors to reflect TRON's `0x41` prefix address derivation

### Chores

- Rename package namespace from `@ethereumjs/util` to `@tvmjs/util`
- Bump package version to `1.0.0`
- Lock all dependency versions by removing `^` and `~` prefixes
