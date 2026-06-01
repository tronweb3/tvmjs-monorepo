# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

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


