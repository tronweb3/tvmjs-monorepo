# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Features

- **TRON Account model**: Extend `Account` class with `asset` (TRC-10 token balances, `{ [tokenId]: bigint }`) and `activePermissions` (`Permission[]`) fields; add `Key` and `Permission` interfaces; include both fields in RLP serialization/deserialization ([0b98d408](https://github.com/tronweb3/tvmjs-monorepo/commit/0b98d4086))
- **TRON CREATE2 address**: Change `generateAddress2()` prefix from `0xff` to `0x41` to match TRON's CREATE2 address derivation ([ca1d44bb](https://github.com/tronweb3/tvmjs-monorepo/commit/ca1d44bb5))
- **`account.isEmpty()` token awareness**: Update `isEmpty()` to return `false` when account has non-zero TRC-10 token balances ([bb7c34c6](https://github.com/tronweb3/tvmjs-monorepo/commit/bb7c34c6c))

### Bug Fixes

- Fix `account.isEmpty()` typo: `_nonce === null` → `_nonce !== null`, preventing nonce from being ignored in emptiness check ([451220b3](https://github.com/tronweb3/tvmjs-monorepo/commit/451220b33), [de9e4195](https://github.com/tronweb3/tvmjs-monorepo/commit/de9e41953))
- Fix import in `bal.ts`: update `@ethereumjs/rlp` to `@tvmjs/rlp` ([78cb0ffc](https://github.com/tronweb3/tvmjs-monorepo/commit/78cb0ffc1))

### Tests

- Update account serialization test to include `asset` and `activePermissions` fields ([98c8e0f9](https://github.com/tronweb3/tvmjs-monorepo/commit/98c8e0f99))
- Update EIP-1014 CREATE2 test vectors to reflect TRON's `0x41` prefix address derivation ([98c8e0f9](https://github.com/tronweb3/tvmjs-monorepo/commit/98c8e0f99))

### Chores

- Rename package namespace from `@ethereumjs/util` to `@tvmjs/util` ([c7375e86](https://github.com/tronweb3/tvmjs-monorepo/commit/c7375e86e))
- Bump package version to `1.0.0` ([792f019f](https://github.com/tronweb3/tvmjs-monorepo/commit/792f019fa))
- Lock all dependency versions by removing `^` and `~` prefixes ([96f52e19](https://github.com/tronweb3/tvmjs-monorepo/commit/96f52e194))
- Remove generated docs files ([ad015266](https://github.com/tronweb3/tvmjs-monorepo/commit/ad015266b))


