# @tvmjs/block `1.2.0`

TRON execution headers retain their base-fee container and parent gas-limit checks without London activation-block adjustments or DAO extra-data requirements. The protected `_validateDAOExtraData()` hook is removed; public PoW/Clique tools still require explicit consensus metadata.

Serialized headers must include `baseFeePerGas`, including when the fee is zero. Old 15-field headers are rejected instead of being silently assigned a fee. Object construction still defaults the fee to `7n`; complete TRON header encodings and hashes are unchanged.

v1.2.0 removes Blob transaction support and Blob header fields and fee helpers. Object, RPC, payload and RLP inputs containing retired fields are rejected. Ordinary TRON header serialization is unchanged. See [Blob migration and affected packages](../common/README.md#blob-removal-in-v120).

EIP-4788 Beacon root fields and their serialization are also removed. Inputs containing `parentBeaconBlockRoot` or `parent_beacon_block_root` are rejected even when their values are empty. Ordinary Beacon payload data conversion remains available. See [Beacon root migration](../common/README.md#beacon-root-removal-in-v120).

EIP-7702 transactions (`0x04`) and both authorization field spellings are rejected, including on transactions passed directly to `new Block()`. Ordinary transaction types and block round trips are preserved. See [EIP-7702 migration](../common/README.md#eip-7702-removal-in-v120).

| Implements schema and functions related to TRON-compatible blocks. Part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, forked from [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo). |
| --- |

- 🦄 TRON execution block contexts and serialization
- 🌴 Tree-shakeable API
- 👷🏼 Controlled dependency set (4 external + `@noble` crypto)
- Standalone withdrawal-trie and request-hash data helpers
- 🏄🏾‍♂️ WASM-free default + Fully browser ready

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
npm install @tvmjs/block
```


## Getting Started

### Instantiation

There are several standalone functions to instantiate a `Block`:

- `createBlock(blockData: BlockData = {}, opts?: BlockOptions)`
- `createEmptyBlock(headerData: HeaderData, opts?: BlockOptions)`
- `createBlockFromBytesArray(values: BlockBytes, opts?: BlockOptions)`
- `createBlockFromRLP(serialized: Uint8Array, opts?: BlockOptions)`
- `createBlockFromRPC(blockParams: JSONRPCBlock, uncles?: any[], opts?: BlockOptions)`
- `createBlockFromJSONRPCProvider(provider: string | EthersProvider, blockTag: string | bigint, opts: BlockOptions)`
- `createBlockFromExecutionPayload(payload: ExecutionPayload, opts?: BlockOptions)`
- `createBlockFromBeaconPayloadJSON(payload: BeaconPayloadJSON, opts?: BlockOptions)`
- `createSealedCliqueBlock(blockData: BlockData = {}, cliqueSigner: Uint8Array, opts?: BlockOptions)`

For `BlockHeader` instantiation, there are similar standalone functions:

- `createBlockHeader(headerData: HeaderData = {}, opts?: BlockOptions)`
- `createBlockHeaderFromBytesArray(values: BlockHeaderBytes, opts?: BlockOptions)`
- `createBlockHeaderFromRLP(serializedHeaderData: Uint8Array, opts?: BlockOptions)`
- `createBlockHeaderFromRPC(blockParams: JSONRPCBlock, options?: BlockOptions)`
- `createSealedCliqueBlockHeader(headerData: HeaderData = {}, cliqueSigner: Uint8Array, opts?: BlockOptions)`

Instantiation Example:

```ts
// ./examples/simple.ts

import { createBlockHeader } from '@tvmjs/block'
import { bytesToHex } from '@tvmjs/util'

import type { HeaderData } from '@tvmjs/block'

const headerData: HeaderData = {
  number: 15,
  parentHash: '0x6bfee7294bf44572b7266358e627f3c35105e1c3851f3de09e6d646f955725a7',
  gasLimit: 8000000,
  timestamp: 1562422144,
}
const header = createBlockHeader(headerData)
console.log(`Created block header with hash=${bytesToHex(header.hash())}`)
```

Properties of a `Block` or `BlockHeader` object are frozen with `Object.freeze()` which gives you enhanced security and consistency properties when working with the instantiated object. This behavior can be modified using the `freeze` option in the constructor if needed.

Block validation is asynchronous: `await block.validateData()` checks transaction signatures and trie roots. Parent gas-limit validation is available through `block.validateGasLimit(parent)`.

`createBlockFromRPC()` requires full transaction objects. Fetch blocks with the second argument set to `true` in `eth_getBlockByNumber` / `eth_getBlockByHash`. Use `createBlockHeaderFromRPC()` for responses containing only transaction hashes. Decimal difficulty strings are converted directly to `bigint` to preserve integers above `2^53 - 1`.

### WASM Crypto Support

This library by default uses JavaScript implementations for the basic standard crypto primitives like hashing or signature verification (for included txs). See `@tvmjs/common` [README](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/common) for instructions on how to replace with e.g. a more performant WASM implementation by using a shared `common` instance.

## EIP Integrations

### Retained base-fee container

The TRON execution profile retains EIP-1559 transaction envelopes, `baseFeePerGas`, and parent-derived base-fee arithmetic. These are execution-container semantics, not a model of TRON bandwidth, staking, or Energy resource prices. Ethereum Hardfork schedules cannot be selected.

```ts
// ./examples/1559.ts

import { createBlock } from '@tvmjs/block'
import { Common, TronMainnet } from '@tvmjs/common'

const common = new Common({ chain: TronMainnet })
// Base fee is retained execution-container metadata, not a TRON resource price model.
const parent = createBlock(
  { header: { baseFeePerGas: 10n, gasLimit: 1000000n, gasUsed: 600000n } },
  { common },
)
const block = createBlock(
  {
    header: {
      number: 1n,
      parentHash: parent.hash(),
      timestamp: parent.header.timestamp + 1n,
      baseFeePerGas: parent.header.calcNextBaseFee(),
      gasLimit: parent.header.gasLimit,
    },
  },
  { common },
)
console.log(block.header.baseFeePerGas) // 11n
await block.validateData()
block.validateGasLimit(parent)
```

### Standalone withdrawal and request helpers

`genWithdrawalsTrieRoot()` and `genRequestsRoot()` remain available as data tools. EIP-4895 withdrawals, EIP-7685 execution requests, BAL and slot-number fields cannot be activated by a TRON profile. Their header fields are rejected in object, RPC and payload inputs. Additional RLP body fields are rejected rather than silently dropped.

The [withdrawal example](./examples/withdrawals.ts) and [request example](./examples/clrequests.ts) demonstrate standalone hashing only; they do not construct execution blocks carrying those fields.

## Consensus Types

TRON execution presets provide no implicit consensus metadata or canonical network genesis. Default headers have zero difficulty, but that does not imply PoS consensus. Ethereum multi-Hardfork execution and TRON DPoS validation are outside this package's supported execution profile.

Explicit PoW, Clique and PoS metadata can still be supplied through a complete TRON `ChainConfig` to exercise retained tools. `createCustomCommon()` cannot attach this metadata. These extensions do not enable unsupported Ethereum EIPs or restore historical fork scheduling.

### Clique example

```ts
// ./examples/clique.ts

import { cliqueSigner, createSealedCliqueBlock } from '@tvmjs/block'
import { Common, ConsensusAlgorithm, ConsensusType, TronMainnet } from '@tvmjs/common'
import { hexToBytes } from '@tvmjs/util'

// Explicit local metadata for the retained Clique tool, not TRON network consensus.
const common = new Common({
  chain: {
    ...TronMainnet,
    consensus: {
      type: ConsensusType.ProofOfAuthority,
      algorithm: ConsensusAlgorithm.Clique,
      clique: { period: 15, epoch: 30000 },
    },
  },
})
const exampleKey = hexToBytes(`0x${'20'.repeat(32)}`)
const block = createSealedCliqueBlock(
  { header: { number: 1n, extraData: new Uint8Array(97) } },
  exampleKey,
  { common },
)
console.log(`Recovered local signer: ${cliqueSigner(block.header)}`)
```

The [PoW example](./examples/pow.ts) exercises the retained difficulty helper. The [PoS example](./examples/pos.ts) exercises static header checks with explicit metadata; EIP-4399 remains unavailable.

## Browser

We provide hybrid ESM/CJS builds for all our libraries. With the v10 breaking release round from Spring 2025, all libraries are "pure-JS" by default and we have eliminated all hard-wired WASM code. Additionally we have substantially lowered the bundle sizes, reduced the number of dependencies, and cut out all usages of Node.js-specific primitives (like the Node.js event emitter).

It is easily possible to run a browser build of one of the TVMJS libraries within a modern browser using the provided ESM build. For a setup example see [./examples/browser.html](./examples/browser.html).

## API

### Docs

Generated TypeDoc API [Documentation](./docs/README.md)

### Hybrid CJS/ESM Builds

With the breaking releases from Summer 2023 we have started to ship our libraries with both CommonJS (`cjs` folder) and ESM builds (`esm` folder), see `package.json` for the detailed setup.

If you use an ES6-style `import` in your code, the ESM build will be used:

```ts
import { TVMJSClass } from '@tvmjs/[PACKAGE_NAME]'
```

If you use Node.js specific `require`, the CJS build will be used:

```ts
const { TVMJSClass } = require('@tvmjs/[PACKAGE_NAME]')
```

Using ESM will give you additional advantages over CJS beyond browser usage like static code analysis / Tree Shaking which CJS cannot provide.


## Testing

Run the retained regression suites from `packages/block`:

```sh
npm run test:node
npm run test:browser
npm run build
npm run tsc
```

Node and Chromium execute the same suite: TRON construction, encoding, fees, transaction validation, explicit consensus tools, and rejected Ethereum-only inputs. Embedded historical fixtures remain data vectors; a pre-base-fee header is not accepted as a complete TRON serialization.

The old external Ethereum multi-Hardfork difficulty runner is retired. Official Ethereum blockchain/difficulty vectors are not executed as an Ethereum compatibility suite. Standalone withdrawal and request vectors do not imply support for those execution capabilities.

## Upstream

This package is part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, a TypeScript implementation of the TRON Virtual Machine (TVM) forked from the [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo) monorepo. We gratefully acknowledge the EthereumJS team for building and maintaining the original implementation.

For development information, see the [developer docs](../../DEVELOPER.md) and our [code of conduct](../../CODE_OF_CONDUCT.md).
## License

[MPL-2.0](<https://tldrlegal.com/license/mozilla-public-license-2.0-(mpl-2)>)

This package is derived from the original [@ethereumjs](https://github.com/ethereumjs/ethereumjs-monorepo) implementation, licensed under MPL-2.0. All original source files retain their MPL-2.0 license.
