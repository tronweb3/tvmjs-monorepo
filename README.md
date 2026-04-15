# TVM-JS

A TypeScript implementation of the **TRON Virtual Machine (TVM)**, adapted from the [EthereumJS monorepo](https://github.com/ethereumjs/ethereumjs-monorepo) to support TRON-specific protocol behavior.

## Overview

TVM-JS is a monorepo of modular packages that together implement the full TRON execution environment in JavaScript/TypeScript. It supports TRON-specific opcodes, TRC-10 token transfers, precompiles, and account model extensions on top of the EthereumJS foundation.

## Packages

| Package | Description |
|---------|-------------|
| [`evm`](./packages/evm) | Core EVM/TVM bytecode interpreter with TRON-specific opcodes and precompiles |
| [`vm`](./packages/vm) | Execution context: runs transactions and blocks, manages state transitions |
| [`tx`](./packages/tx) | Transaction types including TRON TRC-10 token transfers |
| [`common`](./packages/common) | Chain/hardfork configuration shared across packages |
| [`statemanager`](./packages/statemanager) | Account and storage state management |
| [`blockchain`](./packages/blockchain) | Blockchain data structure and block management |
| [`block`](./packages/block) | Block and block header types |
| [`mpt`](./packages/mpt) | Merkle Patricia Trie implementation |
| [`binarytree`](./packages/binarytree) | Binary tree data structure |
| [`rlp`](./packages/rlp) | RLP encoding/decoding |
| [`util`](./packages/util) | Shared utilities |

## TRON-Specific Features

- **Custom opcodes**: `CALLTOKEN` (0xd0), `TOKENBALANCE` (0xd1), `CALLTOKENVALUE` (0xd2), `CALLTOKENID` (0xd3), `ISCONTRACT` (0xd4)
- **TRC-10 token support**: native token transfers via `tokenId` and `tokenValue` transaction fields
- **TRON precompiles**: `BatchValidateSign` (0x09), `ValidateMultiSign` (0x0a), and TRON-adjusted RIPEMD-160 (0x20003) / BLAKE2F (0x20009)
- **Account asset model**: per-account TRC-10 token balances tracked alongside TRX
- **TRON address generation**: TRON-compatible `CREATE2` address derivation
- **Adjusted difficulty**: TRON consensus-compatible difficulty parameters

## Getting Started

### Prerequisites

- Node.js >= 18
- npm >= 8

### Install

```shell
npm install
```

### Build all packages

```shell
npm run build --workspaces
```

### Run tests

```shell
# Run tests for a specific package
cd packages/vm && npm test
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
packages/vm          ← top-level execution context
  └─ packages/evm    ← bytecode interpreter (opcodes, gas, precompiles)
       └─ packages/statemanager  ← account/storage state
            └─ packages/mpt      ← Merkle Patricia Trie
  └─ packages/tx     ← transaction types
  └─ packages/block  ← block / block header
  └─ packages/blockchain ← chain management
  └─ packages/common ← shared chain config
```

## License

[MIT](https://opensource.org/licenses/MIT)
