# TVMJS Monorepo

A TypeScript implementation of the **TRON Virtual Machine (TVM)**, forked from the [EthereumJS monorepo](https://github.com/ethereumjs/ethereumjs-monorepo) and extended with TRON-specific protocol behavior.

> **Note**: This project is a derivative work of EthereumJS, which is licensed under the [Mozilla Public License 2.0 (MPL-2.0)](https://mozilla.org/MPL/2.0/). All original EthereumJS source files retain their MPL-2.0 license. See the [License](#license) section for details.

## Overview

TVMJS is a monorepo of modular packages that together implement the full TRON execution environment in JavaScript/TypeScript. Built on top of the battle-tested EthereumJS foundation, it adds support for TRON-specific opcodes, TRC-10 token transfers, precompiled contracts, multi-signature validation, and the TRON account model.

## Packages

| Package | Description |
|---------|-------------|
| [`@tvmjs/tvm`](./packages/tvm) | Core TVM bytecode interpreter with TRON-specific opcodes and precompiles |
| [`@tvmjs/vm`](./packages/vm) | Execution context: runs transactions and blocks, manages state transitions |
| [`@tvmjs/tx`](./packages/tx) | Transaction types including TRC-10 token transfer fields |
| [`@tvmjs/common`](./packages/common) | Chain/hardfork configuration shared across packages |
| [`@tvmjs/statemanager`](./packages/statemanager) | Account and storage state management |
| [`@tvmjs/blockchain`](./packages/blockchain) | Blockchain data structure and block management |
| [`@tvmjs/block`](./packages/block) | Block and block header types |
| [`@tvmjs/mpt`](./packages/mpt) | Merkle Patricia Trie implementation |
| [`@tvmjs/binarytree`](./packages/binarytree) | Binary tree data structure |
| [`@tvmjs/rlp`](./packages/rlp) | RLP encoding/decoding |
| [`@tvmjs/util`](./packages/util) | Shared utilities, account types, and address helpers |

## TRON-Specific Features

### Custom Opcodes

| Opcode | Code | Description |
|--------|------|-------------|
| `CALLTOKEN` | 0xd0 | Call contract with TRC-10 token transfer |
| `TOKENBALANCE` | 0xd1 | Query TRC-10 token balance of an address |
| `CALLTOKENVALUE` | 0xd2 | Get token value attached to current call |
| `CALLTOKENID` | 0xd3 | Get token ID attached to current call |
| `ISCONTRACT` | 0xd4 | Check if an address is a contract |

### Precompiled Contracts

| Address | Name | Description |
|---------|------|-------------|
| 0x09 | BatchValidateSign | Batch signature validation |
| 0x0a | ValidateMultiSign | Multi-signature permission validation |
| 0x03 | RIPEMD-160 | TRON-specific RIPEMD-160 hash(Double hash) |
| 0x20003 | RIPEMD-160 | TVM-specific RIPEMD-160 hash |
| 0x20009 | BLAKE2F | TVM-specific BLAKE2F compression |

### Account Model Extensions

- **TRC-10 asset tracking**: per-account token balances stored alongside TRX balance
- **Multi-signature permissions**: Owner / Active / Witness permission types with threshold-based validation
- **TRON address generation**: `CREATE2` uses `0x41` prefix instead of `0xff`

### Energy Model

TRON uses an **energy** model (analogous to Ethereum's gas) with TRON-specific parameters:

- `stackLimit`: 64 (vs Ethereum's 1024)
- Custom energy costs for all TRON-specific opcodes
- Contract deployment cost: `200 * code.length + base`

## Getting Started

### Prerequisites

- Node.js >= 20
- npm >= 10

### Install

```shell
npx playwright install chromium
npm install
```

### Build all packages

```shell
npm run build --workspaces
```

### Run tests

```shell
# Run all tests except packages/vm
npm test

# Run tests for the vm package
cd packages/vm && npm run test:API && npm run test:browser

# Run TRON-specific tests
npx vitest run packages/vm/test/api/tvm/
```

## Development

See [DEVELOPER.md](./DEVELOPER.md) for a full guide covering workspace structure, linting, testing, and documentation generation.

### Common commands

```shell
npm run lint          # Lint all packages
npm run lint:fix      # Auto-fix lint issues
npm run build --workspaces  # Build everything
npm run clean         # Remove build artifacts
```

## Architecture

```
packages/vm          <- top-level execution context
  |-- packages/tvm    <- bytecode interpreter (opcodes, energy, precompiles)
  |     \-- packages/statemanager  <- account/storage state
  |           \-- packages/mpt     <- Merkle Patricia Trie
  |-- packages/tx     <- transaction types (with tokenId/tokenValue)
  |-- packages/block  <- block / block header
  |-- packages/blockchain <- chain management
  \-- packages/common <- shared chain config
```

## Upstream

This project is forked from [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo). We gratefully acknowledge the EthereumJS team for building and maintaining the original implementation.

Key differences from upstream:

- TRON energy model replaces Ethereum gas model
- 5 new opcodes for TRC-10 token operations
- TRON-specific precompiled contracts
- Account model extended with asset balances and multi-sig permissions
- `CREATE2` address derivation uses TRON's `0x41` prefix

## License

The original EthereumJS codebase is licensed under the [Mozilla Public License 2.0 (MPL-2.0)](https://mozilla.org/MPL/2.0/). As a derivative work, all files originating from EthereumJS retain the MPL-2.0 license. See individual package `LICENSE` files for details.

TRON-specific modifications and additions are also distributed under the [MPL-2.0](https://mozilla.org/MPL/2.0/) license.
