# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Features

- **`tipsDict`**: Introduce TRON-specific EIP dictionary (`tipsDict`) alongside the upstream `eipsDict`, containing a curated subset of EIPs supported by the TRON hardfork model; `Common.setEIPs()` and `paramByEIP()` now reference `tipsDict`
- **EIP-7708 & EIP-7843**: Add EIP-7708 (ETH transfers emit a log) and EIP-7843 (SLOTNUM opcode) entries to `eipsDict`; include both in the `amsterdam` hardfork
- **EIP-7778 & EIP-8024**: Add EIP-7778 (block-level gas accounting without refunds) and EIP-8024 (DUPN/SWAPN/EXCHANGE instructions, replacing EIP-663) to `eipsDict`; add both to `amsterdam` hardfork; remove EIP-663 from `eipsDict` and `EIP-7692` required list
- **Hardfork expansions in `tipsDict`**: Add DAO, Paris, and Cancun hardfork entries to `tronHardforksDict`; add EIPs 663, 3607, 3651, 3860, 4200, 4750, 4788, 4844, 4895, 5450, 6110, 6206, 7002, 7069, 7251, 7480, 7620, 7685, 7692, 7698, 7702, 7843, 7918, 7934, 7951 to `tipsDict`
- **Chain config**: Add DAO, Berlin, Paris, and Cancun fork entries to `Mainnet` chain config in `chains.ts`; fix `chainId` to `1`
- **`StateManagerInterface`**: Add `tokenIdExists(tokenId: number)` token method to interface

### Bug Fixes

- Remove EIP-7480 (EOF data section access) from `tipsDict` — not supported by TRON
- Fix precompile display names to use correct addresses (`0x09`, `0x0a`) instead of incorrect placeholders

### Tests

- Update default hardfork expectations from `Prague` to `Tron` in `chains.spec.ts` and `customChains.spec.ts`
- Skip `getHardforkBy()`, `_calcForkHash()`, MuirGlacier, ArrowGlacier, GrayGlacier, and Amsterdam hardfork tests (not supported in TRON)
- Rename `bpo.spec.ts`, `timestamp.spec.ts` with underscore prefix to exclude from test runs

### Chores

- Rename package namespace from `@ethereumjs/common` to `@tvmjs/common`; update all internal imports
- Bump package version to `1.0.0`
- Lock all dependency versions by removing `^` and `~` prefixes

