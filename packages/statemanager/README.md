# @tvmjs/statemanager `1.2.0`

| Library to provide high level access to TRON-compatible state. Part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, forked from [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo). |
| --- |

- 🫧 Transparent state access from TVM/VM
- 🌴 Tree-shakeable API
- 👷🏼 Controlled dependency set (5 external + `@Noble` crypto)
- ⏳ Checkpoints + Diff-based Caches
- 🔌 Unified interface (for custom SMs)
- 🎁 3 SMs included (Merkle/Simple/RPC)
- 🛵 233KB bundle size (for Merkle SM) (63KB gzipped)
- 🏄🏾‍♂️ WASM-free default + Fully browser ready

## Table of Contents

- [Installation](#installation)
- [Getting Started](#getting-started)
- [MerkleStateManager](#merklestatemanager)
- [SimpleStateManager](#simplestatemanager)
- [RPCStateManager](#rpcstatemanager)
- [Binary Tree (experimental)](#binary-tree-experimental)
- [Browser](#browser)
- [API](#api)
- [Development](#development)
- [Upstream](#upstream)
- [License](#license)


## Installation

To obtain the latest version, simply require the project using `npm`:

```shell
npm install @tvmjs/statemanager
```

## Getting Started

### Overview

The `StateManager` provides high-level access and manipulation methods to and for the TRON-compatible state, thinking in terms of accounts or contract code rather than the storage operations of the underlying data structure (e.g. a [Merkle-Patricia Trie](../mpt/)).

This library includes several different implementations that all implement the `StateManager` interface which is accepted by the `vm` library. These include:

- [`SimpleStateManager`](./src/simpleStateManager.ts) - a minimally functional (and dependency minimized) version of the state manager suitable for most basic TVM bytecode operations
- [`MerkleStateManager`](./src/merkleStateManager.ts) - a Merkle-Patricia Trie implementation used for local state, proofs and VM execution
- [`RPCStateManager`](./src/rpcStateManager.ts) - an adapter that reads account, code and storage data from a compatible JSON-RPC provider and keeps execution changes in local caches

The exported [`StatefulBinaryTreeStateManager`](./src/statefulBinaryTreeStateManager.ts) is a retained experimental data implementation. It cannot be activated by a TRON execution profile; see [Binary Tree](#binary-tree-experimental).

It also includes a checkpoint/revert/commit mechanism to either persist or revert state changes and provides a sophisticated caching mechanism under the hood to reduce repeated reads from disk.

### TRON execution configuration

`MerkleStateManager` and `RPCStateManager` default to `TronMainnet`. For `TronNile`, `TronShasta`, optional EIPs or custom crypto, pass a `Common` and use compatible configuration in the VM/TVM. `SimpleStateManager` also accepts an optional `common`.

Ethereum presets and Ethereum Hardfork schedules cannot configure execution. The TRON presets provide execution settings without Ethereum genesis or consensus metadata. Reading a historical Ethereum proof or other data fixture does not enable Ethereum execution.

### WASM Crypto Support

This library by default uses JavaScript implementations for the basic standard crypto primitives like hashing for underlying trie keys. See `@tvmjs/common` [README](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/common) for instructions on how to replace with e.g. a more performant WASM implementation by using a shared `common` instance.

## `MerkleStateManager`

### Local TRC-10 registry

`putAccount()` seeds an in-memory Token registry from `Account.asset` keys. `tokenIdExists()` queries these locally supplied IDs, not the network's asset issuance database. Checkpoints roll back new registrations along with account state; only the outermost commit makes registrations permanent. Loading a trie root or an account proof alone does not reconstruct this registry. When initializing a separate instance from external state, supply the required Token account data through `putAccount()` before executing Token transactions.

`shallowCopy()` independently copies the registry at the state before the outermost open checkpoint, matching its copied trie root. Pending registrations from that checkpoint or any nested commit are excluded. Account caches are not copied; flush initialization writes before copying, or finish the outermost commit. Registrations and balances subsequently changed in one instance do not mutate the other instance's snapshot.

### Usage example

```ts
// ./examples/basicUsage.ts

import { MerkleStateManager } from '@tvmjs/statemanager'
import { Account, Address, hexToBytes } from '@tvmjs/util'

const main = async () => {
  const stateManager = new MerkleStateManager()
  const address = new Address(hexToBytes('0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b'))
  const account = new Account(BigInt(0), BigInt(1000))
  await stateManager.checkpoint()
  await stateManager.putAccount(address, account)
  await stateManager.commit()
  await stateManager.flush()

  // Account at address 0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b has balance 1000
  console.log(
    `Account at address ${address.toString()} has balance ${
      (await stateManager.getAccount(address))?.balance
    }`,
  )
}
void main()
```

### Account, Storage and Code Caches

Starting with the v2 release and complemented by the v2.1 release the StateManager comes with a significantly more elaborate caching mechanism for account, storage and code caches.

There are now two cache options available: an unbounded cache (`CacheType.ORDERED_MAP`) for short-lived usage scenarios (this one is the default cache) and a fixed-size cache (`CacheType.LRU`) for a long-lived large cache scenario.

Caches now "survive" a flush operation and especially long-lived usage scenarios will benefit from increased performance by a growing and more "knowing" cache leading to less and less trie reads.

Have a look at the extended `CacheOptions` on how to use and leverage the new cache system.

### Instantiating from Proofs

`fromMerkleStateProof(proof, safe, opts)` creates a partial Merkle state from one or more [EIP-1186](https://eips.ethereum.org/EIPS/eip-1186) proofs. The optional third argument accepts `MerkleStateManagerOpts`, including a compatible `common`, trie and cache settings.

`verifyMerkleStateProof(stateManager, proof)` checks account proofs against that StateManager's root and storage proofs against the authenticated account storage root. Establish the expected root independently when using external data: a proof alone does not establish which root is canonical. Proofs do not contain contract bytecode.

See below example for common usage:

```ts
// ./examples/fromProofInstantiation.ts

import {
  MerkleStateManager,
  addMerkleStateProofData,
  fromMerkleStateProof,
  getMerkleStateProof,
} from '@tvmjs/statemanager'
import { Address, hexToBytes } from '@tvmjs/util'

const main = async () => {
  // setup `stateManager` with some existing address
  const stateManager = new MerkleStateManager()
  const contractAddress = new Address(hexToBytes('0xa94f5374fce5edbc8e2a8697c15331677e6ebf0b'))
  const byteCode = hexToBytes('0x67ffffffffffffffff600160006000fb')
  const storageKey1 = hexToBytes(
    '0x0000000000000000000000000000000000000000000000000000000000000001',
  )
  const storageKey2 = hexToBytes(
    '0x0000000000000000000000000000000000000000000000000000000000000002',
  )
  const storageValue1 = hexToBytes('0x01')
  const storageValue2 = hexToBytes('0x02')

  await stateManager.putCode(contractAddress, byteCode)
  await stateManager.putStorage(contractAddress, storageKey1, storageValue1)
  await stateManager.putStorage(contractAddress, storageKey2, storageValue2)

  const proof = await getMerkleStateProof(stateManager, contractAddress)
  const proofWithStorage = await getMerkleStateProof(stateManager, contractAddress, [
    storageKey1,
    storageKey2,
  ])
  const partialStateManager = await fromMerkleStateProof(proof)

  // To add more proof data, use `addMerkleStateProofData`
  await addMerkleStateProofData(partialStateManager, proofWithStorage)
  console.log(await partialStateManager.getCode(contractAddress)) // contract bytecode is not included in proof
  console.log(await partialStateManager.getStorage(contractAddress, storageKey1), storageValue1) // should match
  console.log(await partialStateManager.getStorage(contractAddress, storageKey2), storageValue2) // should match

  const accountFromNewSM = await partialStateManager.getAccount(contractAddress)
  const accountFromOldSM = await stateManager.getAccount(contractAddress)
  console.log(accountFromNewSM, accountFromOldSM) // should match

  const slot1FromNewSM = await partialStateManager.getStorage(contractAddress, storageKey1)
  const slot2FromNewSM = await partialStateManager.getStorage(contractAddress, storageKey2)
  console.log(slot1FromNewSM, storageValue1) // should match
  console.log(slot2FromNewSM, storageValue2) // should match
}
void main()
```

## `SimpleStateManager`

The `SimpleStateManager` is a dependency-minimized simple state manager implementation. While this state manager implementation lacks the implementations of some non-core functionality as well as proof related logic (e.g. `setStateRoot()`) it is suitable for a lot use cases where things like sophisticated caching or state root handling is not needed.

TRC-10 token IDs are exact `bigint` values throughout the `StateManagerInterface`: `tokenIdExists(tokenId: bigint)` replaces the former `number` parameter, and `Account.asset` is keyed by canonical decimal ID strings (see `tokenIdToKey()` in `@tvmjs/util`). Custom state manager implementations must update the `tokenIdExists()` signature and must not convert token IDs to `Number`, which merges IDs above `2^53 - 1`.

`SimpleStateManager` implements a local in-memory Token registry seeded by `putAccount()` asset keys, including explicitly supplied zero balances. Unknown IDs return `false`. Known IDs remain registered when a balance is spent or a holder is deleted; registrations introduced in a reverted checkpoint are discarded. Nested commits remain reversible by their enclosing checkpoint. `shallowCopy()` copies the current account state and checkpoint stack, including independent registry snapshots, so each instance can commit or revert independently.

This supports `runTx()` validation of nonzero TRC-10 transfers when the sender's Token balances are supplied locally. It does not fetch Token issuance records, implement proof/state-root operations, or add remote Token support to `RPCStateManager`.

This state manager can be instantiated and used as follows:

```ts
// ./examples/simple.ts

import { SimpleStateManager } from '@tvmjs/statemanager'
import { Account, createAddressFromPrivateKey, randomBytes } from '@tvmjs/util'

const main = async () => {
  const sm = new SimpleStateManager()
  const address = createAddressFromPrivateKey(randomBytes(32))
  const account = new Account(0n, 0xfffffn)
  await sm.putAccount(address, account)
  console.log(await sm.getAccount(address))
}

void main()
```

## `RPCStateManager`

`RPCStateManager` requires `eth_getProof`, `eth_getCode` and `eth_getStorageAt` at the selected block tag. It uses the returned account fields as trusted input and caches local execution changes; it does not authenticate provider responses against a trusted chain root. `getRPCStateProof()` retrieves the provider's proof without verifying it.

Use it with VM/TVM for local execution under the selected TRON profile. A TRON `Common` does not make this adapter compatible with java-tron RPC or supply remote TRC-10 assets. Typed and EIP-155-protected transactions must match the VM chainId; unprotected legacy envelopes retain their existing cross-network behavior. java-tron RPC and client integration are outside this package's current scope.

A simple example of usage:

```ts
// ./examples/rpcStateManager.ts

import { Common, TronMainnet } from '@tvmjs/common'
import { RPCStateManager } from '@tvmjs/statemanager'
import { createAddressFromString } from '@tvmjs/util'

const main = async () => {
  const provider = process.env.PROVIDER
  if (provider === undefined) {
    console.log('Set PROVIDER to an RPC URL supporting eth_getProof to read an account.')
    return
  }
  // The provider must support EIP-1186; a TRON Common does not add java-tron RPC support.
  const common = new Common({ chain: TronMainnet })
  const stateManager = new RPCStateManager({ common, provider, blockTag: 500000n })
  const address = createAddressFromString('0xd8da6bf26964af9d7eed9e03e53415d37aa96045')
  const account = await stateManager.getAccount(address)
  console.log('Provider account balance at block 500000:', account?.balance)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
```

The account example makes a remote request only when `PROVIDER` is set. Choose an endpoint that supports the required methods and the requested historical state. The balance is reported in the provider's raw units.

### Points on `RPCStateManager` usage

#### Instantiating the TVM

For BLOCKHASH reads, supply `RPCBlockChain` alongside `RPCStateManager`. The example below initializes TVM locally; execution also needs a matching block context and a provider supporting `eth_getBlockByNumber`. It does not query the network during initialization:

```ts
// ./examples/tvm.ts

import { Common, TronMainnet } from '@tvmjs/common'
import { RPCBlockChain, RPCStateManager } from '@tvmjs/statemanager'
import { createTVM } from '@tvmjs/tvm'

const main = async () => {
  const provider = process.env.PROVIDER ?? 'http://localhost:8545'
  const common = new Common({ chain: TronMainnet })
  const blockchain = new RPCBlockChain(provider)
  const blockTag = 1n
  const state = new RPCStateManager({ common, provider, blockTag })
  const tvm = await createTVM({ common, blockchain, stateManager: state })
  // Initialization is local. Execution needs the matching block context and a compatible provider.
  console.log('Configured TVM chainId:', tvm.common.chainId())
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
```

Use the same provider and consistent block context for state and history reads. RPC block hashes are trusted provider data, not locally verified headers. `RPCBlockChain` is read-only: `putBlock()` rejects writes instead of submitting or silently discarding them.

#### Provider selection

- The provider you select must support the `eth_getProof`, `eth_getCode`, and `eth_getStorageAt` RPC methods.
- Not all providers support retrieving state from all block heights so refer to your provider's documentation. Trying to use a block height not supported by your provider (e.g. any block older than the last 256 for CloudFlare) will result in RPC errors when using the state manager.

#### Block Tag selection

- You have to pass a block number or `earliest` in the constructor that specifies the block height you want to pull state from.
- The `latest`/`pending` values supported by the Ethereum JSON-RPC are not supported as longer running scripts run the risk of state values changing as blocks are mined while your script is running.
- If using a very recent block as your block tag, be aware that reorgs could occur and potentially alter the state you are interacting with.
- For local execution based on the state before block X, use block tag X-1. Transactions and block inputs must match the configured TRON chainId and supported execution fields; arbitrary historical Ethereum blocks are not valid execution inputs.

#### Cache and execution boundaries

- `shallowCopy()` preserves the provider, numeric or `earliest` block tag, and a copy of `Common`, including optional EIPs and custom crypto. It starts with empty independent caches; local writes from the source instance are not copied.
- `checkpoint()`, `commit()` and `revert()` apply to account, code and storage caches together. Writes remain local and are not submitted to the provider.
- `setBlockTag()` and `clearCaches()` clear both current and original storage caches. Change snapshots between executions, outside active checkpoints.
- A full state trie is unavailable. `getStateRoot()` returns a placeholder of 32 zero bytes, `setStateRoot()` is a no-op, and `hasStateRoot()` is not implemented. A successful local block run does not validate the remote state root or consensus.
- `eth_getProof` has no TRC-10 issuance registry or Token account balances. `putAccount()` seeds an exact, checkpoint-aware local Token registry from its asset keys, which is enough to validate transfers from explicitly supplied replay accounts. Unknown IDs return `false`. A snapshot-aware `tokenIdExists: (id: bigint, blockTag: bigint | 'earliest') => boolean | Promise<boolean>` resolver can supplement that registry with issuance data from an external source. The resolver receives the same fixed block tag as account and storage reads, follows `setBlockTag()`, and is preserved by `shallowCopy()`. `clearCaches()` clears the local registry. A non-boolean resolver result throws. The sender's Token balances must still be seeded with `putAccount()`; `skipBalance` is not a replacement for Token state.
- VM results include the retained transaction envelope's intrinsic gas. They are not by themselves measurements of java-tron on-chain Energy.

The offline tests in [rpcStateManager.spec.ts](./test/rpcStateManager.spec.ts) cover fixed historical data fixtures, and [rpcStateManager.tron.spec.ts](./test/rpcStateManager.tron.spec.ts) covers signed local execution on all three TRON presets. They do not contact or validate a live node.

## Binary Tree (experimental)

`StatefulBinaryTreeStateManager` and its public types remain available as experimental standalone data APIs. A supplied TRON `Common` is rejected because EIP-7864 is unavailable; EIP-6800 and EIP-7864 cannot be enabled in the TRON profile. The retained implementation is not evidence of TRON Binary Tree execution support.

Old Verkle StateManager implementation files are not exported. The legacy `StatelessVerkleStateManagerOpts` type remains exported for compatibility; it does not imply a corresponding implementation.

## Browser

We provide hybrid ESM/CJS builds for all our libraries. With the v10 breaking release round from Spring 2025, all libraries are "pure-JS" by default and we have eliminated all hard-wired WASM code. Additionally we have substantially lowered the bundle sizes, reduced the number of dependencies, and cut out all usages of Node.js-specific primitives (like the Node.js event emitter).

It is easily possible to run a browser build of one of the TVMJS libraries within a modern browser using the provided ESM build. For a setup example see [./examples/browser.html](./examples/browser.html).

## API

### Docs

See the [public exports](./src/index.ts), [StateManager options and proof types](./src/types.ts), and [StateManagerInterface](../common/src/interfaces.ts). Generate TypeDoc locally with `npm run docs:build`.

### Hybrid CJS/ESM Builds

With the breaking releases from Summer 2023 we have started to ship our libraries with both CommonJS (`cjs` folder) and ESM builds (`esm` folder), see `package.json` for the detailed setup.

If you use an ES6-style `import` in your code files from the ESM build will be used:

```ts
import { MerkleStateManager } from '@tvmjs/statemanager'
```

If you use Node.js specific `require`, the CJS build will be used:

```ts
const { MerkleStateManager } = require('@tvmjs/statemanager')
```

Using ESM will give you additional advantages over CJS beyond browser usage like static code analysis / Tree Shaking which CJS can not provide.

## Development

Run `npm run test:node`, `npm run test:browser`, `npm run build`, `npm run tsc` and `npm run lint` from this package. Browser tests use Chromium and include the same offline RPC, proof and storage dump tests as Node. See the [repository developer guide](../../DEVELOPER.md) for shared tooling.

## Upstream

This package is part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, a TypeScript implementation of the TRON Virtual Machine (TVM) forked from the [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo) monorepo. We gratefully acknowledge the EthereumJS team for building and maintaining the original implementation.

For development information, see the [developer docs](../../DEVELOPER.md) and our [code of conduct](../../CODE_OF_CONDUCT.md).
## License

[MPL-2.0](<https://tldrlegal.com/license/mozilla-public-license-2.0-(mpl-2)>)

This package is derived from the original [@ethereumjs](https://github.com/ethereumjs/ethereumjs-monorepo) implementation, licensed under MPL-2.0. All original source files retain their MPL-2.0 license.
