# @tvmjs/blockchain `1.0.0`

| A module to store and interact with TRON-compatible blocks. Part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, forked from [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo). |
| --- |

## Table of Contents

- [Installation](#installation)
- [Getting Started](#getting-started)
- [EIP Integrations](#eip-integrations)
- [Consensus Types](#consensus-types)
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

**Note:** If you want to work with `EIP-4844` related functionality, you will have additional initialization steps for the **KZG setup**, see related section below.

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
import { Common, Hardfork, Mainnet } from '@tvmjs/common'
import { bytesToHex } from '@tvmjs/util'

const main = async () => {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.London })
  // Use the safe static constructor which awaits the init method
  const blockchain = await createBlockchain({
    validateBlocks: false, // Skipping validation so we can make a simple chain without having to provide complete blocks
    validateConsensus: false,
    common,
  })

  // We use minimal data to provide a sequence of blocks (increasing number, difficulty, and then setting parent hash to previous block)
  const block = createBlock(
    {
      header: {
        number: 1n,
        parentHash: blockchain.genesisBlock.hash(),
        difficulty: blockchain.genesisBlock.header.difficulty + 1n,
      },
    },
    { common, setHardfork: true },
  )
  const block2 = createBlock(
    {
      header: {
        number: 2n,
        parentHash: block.header.hash(),
        difficulty: block.header.difficulty + 1n,
      },
    },
    { common, setHardfork: true },
  )
  // See @tvmjs/block for more details on how to create a block
  await blockchain.putBlock(block)
  await blockchain.putBlock(block2)

  // We iterate over the blocks in the chain to the current head (block 2)
  await blockchain.iterator('i', (block) => {
    const blockNumber = block.header.number.toString()
    const blockHash = bytesToHex(block.hash())
    console.log(`Block ${blockNumber}: ${blockHash}`)
  })

  // Block 1: 0xa1a061528d74ba81f560e1ebc4f29d6b58171fc13b72b876cdffe6e43b01bdc5
  // Block 2: 0x5583be91cf9fb14f5dbeb03ad56e8cef19d1728f267c35a25ba5a355a528f602
}
void main()
```

More examples can be found in the [examples](./examples/) folder.

## Setup

### Block Storage

For storing blocks different backends can be used. The database needs to conform to the [DB](https://github.com/tronweb3/tvmjs-monorepo/blob/master/packages/util/src/db.ts) interface provided in the `@tvmjs/util` package (since this is used in other places as well).

By default the blockchain package uses a [MapDB](https://github.com/tronweb3/tvmjs-monorepo/blob/master/packages/util/src/mapDB.ts) non-persistent data storage which is also generically provided in the `@tvmjs/util` package.

If you need a persistent data store for your use case you can consider using the wrapper we have written within our [client](https://github.com/tronweb3/tvmjs-monorepo/blob/master/packages/client/src/execution/level.ts) library.

### Consensus

There is a dedicated consensus class for each type of supported consensus, `Ethash`, `Clique` and `Casper` (PoS, this one is rather the do-nothing part of `Casper` and letting the respective consensus/beacon client do the hard work! 🙂). Each consensus class adheres to a common interface `Consensus` implementing the following five methods in a consensus-specific way:

- `genesisInit(genesisBlock: Block): Promise<void>`
- `setup(): Promise<void>`
- `validateConsensus(block: Block): Promise<void>`
- `validateDifficulty(header: BlockHeader): Promise<void>`
- `newBlock(block: Block, commonAncestor?: BlockHeader, ancientHeaders?: BlockHeader[]): Promise<void>`

#### Custom Consensus Algorithms

You can also create a custom consensus class implementing the above interface and pass it into the `Blockchain` constructor using the `consensus` option at instantiation. See [this test script](https://github.com/tronweb3/tvmjs-monorepo/blob/master/packages/blockchain/test/customConsensus.spec.ts) for a complete example of how write and use a custom consensus implementation.

Note, if you construct a blockchain with a custom consensus implementation, transition checks for switching from PoW to PoS are disabled so defining a merge hardfork will have no impact on the consensus mechanism defined for the chain.

## Custom Genesis State

### Genesis State

Genesis state for the 4 supported networks (mainnet, sepolia, hoodi, holesky) is stored in an auxiliary package [@tvmjs/genesis](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/genesis), from which it can be included if needed (for most - especially VM - use cases it is not necessary), see PR [#2844](https://github.com/tronweb3/tvmjs-monorepo/pull/2844).


### Custom genesis from a Geth genesis config

For many custom chains we might come across a genesis configuration, which can be used to build both chain config as well the genesis state (and hence the genesis block as well to start off with)

```ts
// ./examples/gethGenesis.ts

import { createBlockchain } from '@tvmjs/blockchain'
import { createCommonFromGethGenesis, parseGethGenesisState } from '@tvmjs/common'
import { postMergeGethGenesis } from '@tvmjs/testdata'
import { bytesToHex } from '@tvmjs/util'

const main = async () => {
  // Load geth genesis file
  const common = createCommonFromGethGenesis(postMergeGethGenesis, { chain: 'customChain' })
  const genesisState = parseGethGenesisState(postMergeGethGenesis)
  const blockchain = await createBlockchain({
    genesisState,
    common,
  })
  const genesisBlockHash = blockchain.genesisBlock.hash()
  common.setForkHashes(genesisBlockHash)
  console.log(
    `Genesis hash from geth genesis parameters - ${bytesToHex(blockchain.genesisBlock.hash())}`,
  )
}

void main()

```

The genesis block from the initialized `Blockchain` can be retrieved via the `Blockchain.genesisBlock` getter. For creating a genesis block from the params in `@tvmjs/common`, the `createGenesisBlock(stateRoot: Buffer): Block` method can be used.

## Supported Blocks and Tx Types

### EIP-1559 Support

This library supports the handling of `EIP-1559` blocks and transactions.

### EIP-4844 Shard Blob Transactions Support

This library supports the blob transaction type introduced with [EIP-4844](https://eips.ethereum.org/EIPS/eip-4844).

The blockchain library now allows for blob transactions to be validated and included in a chain where EIP-4844 activated either by hardfork or standalone EIP.

**Note:** Working with blob transactions needs a manual KZG library installation and global initialization, see [KZG Setup](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/tx/README.md#kzg-setup) for instructions.

### EIP-7685 Requests Support

This library supports blocks including the [EIP-7685](https://eips.ethereum.org/EIPS/eip-7685) requests to the consensus layer (like e.g. deposit or withdrawal requests).

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

## Upstream

This package is part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, a TypeScript implementation of the TRON Virtual Machine (TVM) forked from the [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo) monorepo. We gratefully acknowledge the EthereumJS team for building and maintaining the original implementation.

For development information, see the [developer docs](../../DEVELOPER.md) and our [code of conduct](../../CODE_OF_CONDUCT.md).
## License

[MPL-2.0](<https://tldrlegal.com/license/mozilla-public-license-2.0-(mpl-2)>)

This package is derived from the original [@ethereumjs](https://github.com/ethereumjs/ethereumjs-monorepo) implementation, licensed under MPL-2.0. All original source files retain their MPL-2.0 license.
