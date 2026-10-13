<!-- cspell:ignore SLOTNUM DUPN SWAPN -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
(modification: no type change headlines) and this project adheres to
[Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## Unreleased

### Features

- Default `TronMainnet` to Proposal 65 so direct TVM use applies its current memory-opcode Energy. Add `createCurrentTronMainnetCommon()` with the complete v1.2.0 client settings (proposals 65/96 and CLZ), and retain explicit historical overrides including `activatedProposals: []`.

### Breaking Changes

- Require `ChainConfig.execution: 'tron'`; type historical Ethereum presets as non-executable `EthereumChainData`. Restrict `createCustomCommon()` to `CustomChainConfig` identity/discovery overrides and reject metadata, schedule or options-based chain replacement; supply explicit metadata through a complete configuration.
- Remove `createCommonFromGethGenesis()`, `GethConfigOpts` and `CreateCommonFromGethGenesisOpts`. Keep Geth genesis and allocation parsers as data utilities; migrate configuration consumers and examples without re-enabling Ethereum execution.
- Remove EIP-3860 from the TRON execution profile; explicit activation and parameter queries now throw. Keep group 607 for shared EXP, replay-protection and nonce behavior without EIP-170 code size limits; document the coordinated TVM/Tx/VM option and parameter removal.
- Remove the EIP-7702 metadata entry. Authorization activation and parameter queries remain rejected; document the coordinated transaction, delegation and authorization API removal.
- Remove the EIP-4788 metadata entry. Beacon root activation and parameter queries remain rejected on all TRON presets.
- Remove Blob gas schedules, Blob EIP metadata, KZG configuration and Blob genesis types. Reject removed fields before configuration data is copied or parsed.
- Change `StateManagerInterface.tokenIdExists()` to take an exact `bigint` TRC-10 token ID.
- Disable EIP-2929 access pricing, EIP-3529 refunds and EIP-3651 warming in the TRON profile, including explicit reactivation attempts. Retain EIP-2930 for transaction encoding.
- Restrict Common to the independent TRON execution profile and explicit capability matrix. Reject Ethereum presets, hardfork schedules, unsupported EIPs and the legacy implicit `Mainnet + tron` mapping.
- Remove inherited Ethereum genesis, consensus and fork metadata from TRON presets. Add `TronExecutionChainConfig`, `NetworkChainConfig`, `hasGenesis()` and `hasConsensus()`; missing metadata queries and Ethereum fork-hash operations now throw.

### Fixes

- Default the `TronNile` and `TronShasta` presets to Proposal 65 so memory-opcode Energy matches their current testnet schedules. Historical execution can still pass `activatedProposals: []` explicitly. Shasta's [chain parameters](https://api.shasta.trongrid.io/wallet/getchainparameters) reported `getAllowHigherLimitForMaxCpuTimeOfOneTx = 1` when checked on 2026-10-10.
- Reject inherited and non-enumerable Blob gas fields in `parseGethGenesis()` before copying input properties or invoking their getters.
- Use the TRON profile for both EIP selection and parameter queries, while allowing queries for supported optional EIPs without activating them.
- Reject Geth blob schedules explicitly, including empty schedules and entries named `tron`, instead of reporting a misleading unknown-hardfork error.
- Isolate copied configuration and validate execution compatibility across VM layers, including capabilities, proposals, crypto implementations and active parameters.
- Treat differing genesis metadata as a configuration conflict in `isCompatibleWith()`, so an execution-only `tvmOpts.common` cannot silently replace a supplied network configuration. Consensus and genesis metadata are compared independent of property order.
- Preserve caller parameters when execution packages load defaults with `updateParams(defaults, false)`. Explicitly selecting an already active EIP no longer replaces TRON parameter overrides.
- Document the v1.2.0 configuration and Energy migration.

### Tests and Documentation

- Cover metadata ordering and conflicts, active parameter compatibility on all three TRON networks, and exact allocation parsing in the shared Node/Browser suite. Keep the published `Common.isTron()` API and retained raw Ethereum data tests.
- Align public query documentation and browser examples with the TRON profile; distinguish allocation parsing from state-root calculation. Remove the unused Ethereum bootnode updater that targeted obsolete JSON configuration files.

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
