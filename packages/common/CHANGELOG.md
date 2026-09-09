# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Unreleased

## 1.1.0

### Features

- **TRON execution profile identity**: Add `Common.isTron()` for chain-level TRON behavior that must remain active when a TRON preset explicitly selects an earlier hardfork
- **TRON chainId presets**: Add execution-only `TronMainnet`, `TronNile`, and `TronShasta` chain configs plus the `createTronChainIdCommon(network, opts?)` factory; provides the corresponding chainIds 728126428, 3448148188, and 2494104990 while explicitly omitting network discovery data and not claiming to be a complete TRON network configuration
- **TRON hardfork wiring**: Wire `tronHardforksDict` into the TRON execution presets; `Common` resolves per-hardfork config as `customHardforks[name] ?? hardforksDict[name]`
- **TRON Proposal gating**: Add `activatedProposals` option to `BaseOpts`; expose `Common.activatedProposals()` and `Common.isActivatedProposal(id)` for Proposal 95 (`ALLOW_TVM_PRAGUE`) and 96 (`ALLOW_TVM_OSAKA`); IDs are validated, deduplicated, and stored in ascending order. `Common` does not mutate EIPs or params from proposal state; execution consumers can use it for feature gates such as TVM's Proposal 96 / TIP-854 behavior
- **Constructor forwarding**: `createCommonFromGethGenesis` now forwards `activatedProposals` to the underlying `Common` instance

### Bug Fixes

- Restore the Ethereum `Mainnet` preset to the Prague hardfork and keep the TRON hardfork and parameter overlay isolated to the `TronMainnet`, `TronNile`, and `TronShasta` presets
- Preserve the legacy `new Common({ chain: Mainnet, hardfork: 'tron' })` call form by normalizing that exact combination to `TronMainnet` (chainId 728126428); new code should use `TronMainnet` directly
- Add the missing EIP-7939 entry to `tipsDict` so the implemented CLZ opcode can be enabled explicitly with `eips: [7939]`; default hardfork and Proposal 96 activation behavior remain unchanged

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
