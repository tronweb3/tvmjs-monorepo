# @tvmjs/blockchain `1.2.0`

Header validation uses the parent-derived base fee and ordinary gas-limit bounds at every height. Ethereum London activation heights do not override these checks. Invalid fees or doubled gas limits are rejected without advancing the canonical head.

v1.2.0 removes Blob validation and parent-header Blob accounting. Blob blocks are rejected by block construction; ordinary chain storage and fork choice keep their existing behavior. See [Blob migration and affected packages](../common/README.md#blob-removal-in-v120).

| A module to store and interact with TRON-compatible blocks. Part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, forked from [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo). |
| --- |

## Table of Contents

- [Installation](#installation)
- [Getting Started](#getting-started)
- [Supported Blocks and Tx Types](#supported-blocks-and-tx-types)
- [Consensus](#consensus)
- [Browser](#browser)
- [API](#api)
- [Testing](#testing)
- [Upstream](#upstream)
- [License](#license)

## Installation

To obtain the latest version, simply install the project using `npm`:

```shell
npm install @tvmjs/blockchain
```


## Getting Started

### Introduction

The `Blockchain` package represents a TRON-compatible blockchain storing a sequential chain of [@tvmjs/block](../block) blocks and holding information about the current canonical head block as well as the context the chain is operating in (e.g. the hardfork rules the current head block adheres to).

New blocks can be added to the blockchain. Validation ensures that the block format adheres to the given chain rules (with the `Blockchain.validateBlock()` function) and consensus rules (`Blockchain.consensus.validateConsensus()`).

The library also supports reorg scenarios e.g. by allowing to add a new block with `Blockchain.putBlock()` which follows a different canonical path to the head than given by the current canonical head block.

## Examples

The following is an example to instantiate a simple Blockchain object, put blocks into the blockchain and then iterate through the blocks added:

```ts
// ./examples/simple.ts

import { createBlock } from '@tvmjs/block'
import { createBlockchain } from '@tvmjs/blockchain'
import { Common, TronMainnet } from '@tvmjs/common'
import { bytesToHex } from '@tvmjs/util'

const common = new Common({ chain: TronMainnet })
// An explicit local genesis, not the network's canonical genesis block.
const genesisBlock = createBlock({ header: { gasLimit: 1000000n } }, { common })
const blockchain = await createBlockchain({ common, genesisBlock, validateBlocks: true })

let parent = genesisBlock
for (let height = 1n; height <= 2n; height++) {
  const block = createBlock(
    {
      header: {
        number: height,
        parentHash: parent.hash(),
        timestamp: parent.header.timestamp + 1n,
        gasLimit: parent.header.gasLimit,
        baseFeePerGas: parent.header.calcNextBaseFee(),
      },
    },
    { common },
  )
  await blockchain.putBlock(block)
  parent = block
}

await blockchain.iterator('example', (block) => {
  console.log(`Block ${block.header.number}: ${bytesToHex(block.hash())}`)
})
```

More examples can be found in the [examples](./examples/) folder.

## Setup

### Block Storage

For storing blocks different backends can be used. The database needs to conform to the [DB](https://github.com/tronweb3/tvmjs-monorepo/blob/master/packages/util/src/db.ts) interface provided in the `@tvmjs/util` package (since this is used in other places as well).

By default the blockchain package uses a [MapDB](https://github.com/tronweb3/tvmjs-monorepo/blob/master/packages/util/src/mapDB.ts) non-persistent data storage which is also generically provided in the `@tvmjs/util` package.

If you need a persistent data store for your use case you can consider using the wrapper we have written within our [client](https://github.com/tronweb3/tvmjs-monorepo/blob/master/packages/client/src/execution/level.ts) library.

### Consensus

By default there is no consensus implementation: TRON presets contain execution configuration only. Supply an explicit `genesisBlock`, or provide genesis metadata and state separately. Without consensus metadata, canonical selection follows block height; an equal-height sibling is stored without replacing the first canonical block. Rewriting an older block does not move the head back, and canonical bodies arriving after headers advance the block head independently.

`Ethash`, `Clique`, `Casper` and custom consensus adapters remain extension tools. To use one, provide the metadata in a complete TRON `ChainConfig` and supply any required implementation through `consensusDict`. Setting `validateConsensus: true` without metadata or a matching implementation is rejected. These adapters do not implement TRON DPoS or permit Ethereum Hardfork schedules.

The [Clique example](./examples/clique.ts) demonstrates explicit metadata and genesis initialization. The [custom consensus test](./test/customConsensus.spec.ts) demonstrates the adapter contract (`genesisInit`, `setup`, `validateConsensus`, `validateDifficulty`, and `newBlock`).

## Custom Genesis State

### Genesis State

Genesis state can be supplied directly with the `genesisState` constructor option when creating a blockchain. This repository does not currently publish a separate genesis-data package.


### Importing Geth allocations for local execution

`parseGethGenesisState()` imports account allocations as data. Supply TRON execution configuration and explicit genesis metadata separately; `createCommonFromGethGenesis()` has been removed. The following example builds a local simulation from a fixture, not a canonical TRON network genesis block.

```ts
// ./examples/gethGenesis.ts

import { createBlockchain } from '@tvmjs/blockchain'
import { Common, TronMainnet, parseGethGenesisState } from '@tvmjs/common'
import { postMergeGethGenesis } from '@tvmjs/testdata'
import { bytesToHex } from '@tvmjs/util'

const main = async () => {
  // Import allocations as data; supply separate TRON execution configuration.
  const common = new Common({
    chain: {
      ...TronMainnet,
      name: 'local-genesis-example',
      // Local simulation metadata, not the TRON Mainnet genesis block.
      genesis: { gasLimit: 1000000, difficulty: 0, nonce: '0x0000000000000000', extraData: '0x' },
    },
  })
  const genesisState = parseGethGenesisState(postMergeGethGenesis)
  const blockchain = await createBlockchain({
    genesisState,
    common,
  })
  console.log(`Local genesis hash: ${bytesToHex(blockchain.genesisBlock.hash())}`)
}

void main()

```

The initialized genesis block is available through `Blockchain.genesisBlock`. `createGenesisBlock(stateRoot: Uint8Array)` uses explicitly supplied Common genesis metadata. An execution-only preset can also be paired with an explicit `genesisBlock`; it does not supply network genesis or consensus data itself.

## Supported Blocks and Tx Types

### EIP-1559 Support

This library supports the handling of `EIP-1559` blocks and transactions.

### Unavailable Ethereum execution capabilities

Blob transactions, Beacon root fields and authorization transactions are removed. Withdrawals, execution requests, BAL and slot-number implementations may remain as data tools, but cannot be activated in a TRON execution profile. Their block input is rejected; standalone helper availability does not imply execution support.

## Browser

We provide hybrid ESM/CJS builds for all our libraries. All libraries are "pure-JS" by default and we have eliminated all hard-wired WASM code. Additionally we have substantially lowered the bundle sizes, reduced the number of dependencies, and cut out all usages of Node.js-specific primitives (like the Node.js event emitter).

It is easily possible to run a browser build of one of the TVMJS libraries within a modern browser using the provided ESM build. For a setup example see [./examples/browser.html](./examples/browser.html).

## API

### Docs

Generated TypeDoc API [Documentation](./docs/README.md)

### Hybrid CJS/ESM Builds

With the breaking releases from Summer 2023 we have started to ship our libraries with both CommonJS (`cjs` folder) and ESM builds (`esm` folder), see `package.json` for the detailed setup.

If you use an ES6-style `import` in your code files from the ESM build will be used:

```ts
import { TVMJSClass } from '@tvmjs/[PACKAGE_NAME]'
```

If you use Node.js specific `require`, the CJS build will be used:

```ts
const { TVMJSClass } = require('@tvmjs/[PACKAGE_NAME]')
```

Using ESM will give you additional advantages over CJS beyond browser usage like static code analysis / Tree Shaking which CJS can not provide.

## Events

The `Blockchain` class has a public property `events` which contains an `EventEmitter` (using [EventEmitter3](https://github.com/primus/eventemitter3)). Following events are emitted on which you can react within your code:

| Event                    | Description                                 |
| ------------------------ | ------------------------------------------- |
| `deletedCanonicalBlocks` | Emitted when blocks are reorged and deleted |

## Debugging

This library uses the [debug](https://github.com/visionmedia/debug) debugging utility package.

The following initial logger is currently available:

| Logger              | Description                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| `blockchain:#`      | Core blockchain operations like when a block or header is put or deleted |
| `blockchain:clique` | Clique consensus operations like updating the vote and/or signer list    |
| `blockchain:ethash` | Ethash consensus operations like PoW block or header validation          |

The following is an example for a logger run:

Run with the clique logger:

```shell
DEBUG=tvmjs,blockchain:clique tsx test.ts
```

`tvmjs` **must** be included in the `DEBUG` environment variables to enable **any** logs.
Additional log selections can be added with a comma separated list (no spaces). Logs with extensions can be enabled with a colon `:`, and `*` can be used to include all extensions (currently do not apply for blockchain debugging, example taken from another library).

`DEBUG=tvmjs,statemanager:cache:*,trie,statemanager:merkle npx vitest test/statemanager.spec.ts`

## Testing

Run `npm run test:node` and `npm run test:browser` from `packages/blockchain`. Both execute the retained storage, fork-choice, iterator, explicit-consensus and configuration regression suites. Fixtures use an explicit local genesis; they are not canonical TRON network genesis blocks.

The formerly skipped iterator-reorg and shorter-chain/higher-total-difficulty cases execute with explicit TRON configuration. Clique voting, checkpoint signer validation, headers-before-bodies and repeated-old-block regressions remain covered. Ethash proof verification and the external official Ethereum blockchain vector suite are not executed by these package tests.

## Upstream

This package is part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, a TypeScript implementation of the TRON Virtual Machine (TVM) forked from the [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo) monorepo. We gratefully acknowledge the EthereumJS team for building and maintaining the original implementation.

For development information, see the [developer docs](../../DEVELOPER.md) and our [code of conduct](../../CODE_OF_CONDUCT.md).
## License

[MPL-2.0](<https://tldrlegal.com/license/mozilla-public-license-2.0-(mpl-2)>)

This package is derived from the original [@ethereumjs](https://github.com/ethereumjs/ethereumjs-monorepo) implementation, licensed under MPL-2.0. All original source files retain their MPL-2.0 license.
