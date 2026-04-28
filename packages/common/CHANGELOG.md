# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## 1.0.0

### Features

- **`tipsDict`**: Introduce TRON-specific EIP dictionary (`tipsDict`) alongside the upstream `eipsDict`, containing a curated subset of EIPs supported by the TRON hardfork model; `Common.setEIPs()` and `paramByEIP()` now reference `tipsDict` ([2baf447f](https://github.com/tronweb3/tvmjs-monorepo/commit/2baf447ff))
- **EIP-7708 & EIP-7843**: Add EIP-7708 (ETH transfers emit a log) and EIP-7843 (SLOTNUM opcode) entries to `eipsDict`; include both in the `amsterdam` hardfork ([1f6fa3d2](https://github.com/tronweb3/tvmjs-monorepo/commit/1f6fa3d23))
- **EIP-7778 & EIP-8024**: Add EIP-7778 (block-level gas accounting without refunds) and EIP-8024 (DUPN/SWAPN/EXCHANGE instructions, replacing EIP-663) to `eipsDict`; add both to `amsterdam` hardfork; remove EIP-663 from `eipsDict` and `EIP-7692` required list ([2b56e74e](https://github.com/tronweb3/tvmjs-monorepo/commit/2b56e74ef))
- **Hardfork expansions in `tipsDict`**: Add DAO, Paris, and Cancun hardfork entries to `tronHardforksDict`; add EIPs 663, 3607, 3651, 3860, 4200, 4750, 4788, 4844, 4895, 5450, 6110, 6206, 7002, 7069, 7251, 7480, 7620, 7685, 7692, 7698, 7702, 7843, 7918, 7934, 7951 to `tipsDict` ([d9f48a4b](https://github.com/tronweb3/tvmjs-monorepo/commit/d9f48a4b5), [68d384502](https://github.com/tronweb3/tvmjs-monorepo/commit/68d384502), [15a7739b](https://github.com/tronweb3/tvmjs-monorepo/commit/15a7739bf))
- **Chain config**: Add DAO, Berlin, Paris, and Cancun fork entries to `Mainnet` chain config in `chains.ts`; fix `chainId` to `1` ([d9f48a4b](https://github.com/tronweb3/tvmjs-monorepo/commit/d9f48a4b5))
- **`StateManagerInterface`**: Add `tokenIdExists(tokenId: number)` token method to interface ([4932e3ce](https://github.com/tronweb3/tvmjs-monorepo/commit/4932e3ce3))

### Bug Fixes

- Remove EIP-7480 (EOF data section access) from `tipsDict` — not supported by TRON ([75ba94b3](https://github.com/tronweb3/tvmjs-monorepo/commit/75ba94b3b))
- Fix precompile display names to use correct addresses (`0x09`, `0x0a`) instead of incorrect placeholders ([75ba94b3](https://github.com/tronweb3/tvmjs-monorepo/commit/75ba94b3b))

### Tests

- Update default hardfork expectations from `Prague` to `Tron` in `chains.spec.ts` and `customChains.spec.ts` ([d63807972](https://github.com/tronweb3/tvmjs-monorepo/commit/d638079725))
- Skip `getHardforkBy()`, `_calcForkHash()`, MuirGlacier, ArrowGlacier, GrayGlacier, and Amsterdam hardfork tests (not supported in TRON) ([d63807972](https://github.com/tronweb3/tvmjs-monorepo/commit/d638079725))
- Rename `bpo.spec.ts`, `timestamp.spec.ts` with underscore prefix to exclude from test runs ([d63807972](https://github.com/tronweb3/tvmjs-monorepo/commit/d638079725))

### Chores

- Rename package namespace from `@ethereumjs/common` to `@tvmjs/common`; update all internal imports ([c7375e86](https://github.com/tronweb3/tvmjs-monorepo/commit/c7375e86e))
- Bump package version to `1.0.0` ([792f019f](https://github.com/tronweb3/tvmjs-monorepo/commit/792f019fa))
- Lock all dependency versions by removing `^` and `~` prefixes ([96f52e19](https://github.com/tronweb3/tvmjs-monorepo/commit/96f52e194))
- Remove generated docs files ([ad015266](https://github.com/tronweb3/tvmjs-monorepo/commit/ad015266b))

