<!-- cspell:ignore peerdas -->

# @tvmjs/vm

`ChainConfig` now requires `execution: 'tron'`. Use complete configurations for explicit genesis/consensus metadata; `createCustomCommon()` accepts identity/discovery overrides only, and `createCommonFromGethGenesis()` has been removed. VM/TVM compatibility checks continue to compare supplied metadata. See [Common configuration migration](../common/README.md#custom-networks-and-cryptography).

Remove `allowUnlimitedContractSize` and `allowUnlimitedInitCodeSize` from `tvmOpts`; either key now throws before initialization, even with `false` or `undefined`. VM and direct TVM deployment retain the same TRON execution Energy and rollback behavior without EIP-170/EIP-3860 limits. Transaction envelope charges remain separate from execution Energy. See [contract size migration](../common/README.md#contract-size-configuration-in-v120).

v1.2.0 removes Blob fees, receipts and block-builder accounting. Remove `allowNoBlobs` from `addTransaction()` calls and use the four-argument `generateTxReceipt()` signature. Ordinary transaction execution and receipts are preserved. See [Blob migration and affected packages](../common/README.md#blob-removal-in-v120).

Beacon root initialization, system-account writes and the `historicalRootsLength` parameter are removed. `runTx()`, `runBlock()` and block builders reject retired Beacon root fields before events or state changes. Ordinary contract storage and rollback remain available. See [Beacon root migration](../common/README.md#beacon-root-removal-in-v120).

EIP-7702 authorization processing, refunds and sender-code exceptions are removed. `runTx()`, `runBlock()` and block builders reject type `0x04` and authorization fields before events or state changes. Senders with deployed code remain invalid, including former delegation code. See [EIP-7702 migration](../common/README.md#eip-7702-removal-in-v120).

| Execution context for the TVM (TRON Virtual Machine) implementation. Part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, forked from [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo). |
| --- |

TRON-compatible execution context for
[@tvmjs/tvm](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/tvm)
to build and run blocks and txs and update state.

- 🦄 TRON execution profile with Mainnet, Nile and Shasta presets
- 🌴 Tree-shakeable API
- 👷🏼 Controlled dependency set (7 external + `@Noble` crypto)
- 🧩 Explicit TRON capabilities and governance proposals
- 📬 Flexible state retrieval (Merkle, RPC,...)
- 🏄🏾‍♂️ WASM-free default + Fully browser ready

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
  - [Running a Transaction](#running-a-transaction)
  - [RPC Integration](#rpc-integration)
  - [Building a Block](#building-a-block)
  - [WASM Crypto Support](#wasm-crypto-support)
- [Examples](#examples)
- [Browser](#browser)
- [API](#api)
  - [Docs](#docs)
  - [Hybrid CJS/ESM Builds](#hybrid-cjsesm-builds)
- [Architecture](#architecture)
  - [VM/TVM Relation](#vmtvm-relation)
  - [State and Blockchain Information](#state-and-blockchain-information)
- [Setup](#setup)
  - [Chains](#chains)
  - [Hardforks](#hardforks)
  - [Custom Genesis State](#custom-genesis-state)
- [Supported EIPs](#supported-eips)
- [Events](#events)
  - [Tracing Events](#tracing-events)
  - [Asynchronous event handlers](#asynchronous-event-handlers)
  - [Synchronous event handlers](#synchronous-event-handlers)
- [Understanding the VM](#understanding-the-vm)
- [Internal Structure](#internal-structure)
- [Development](#development)
- [Upstream](#upstream)
- [License](#license)

## Installation

To obtain the latest version, simply require the project using `npm`:

```shell
npm install @tvmjs/vm
```

## Usage

### Running a Transaction

`createVM()` defaults to the execution-only `TronMainnet` profile. Transaction, block and state-manager defaults use the same network. Use the VM's Common when constructing a transaction for an explicitly selected network.

This v1.2.0 development branch rejects Ethereum configurations and the old implicit `Mainnet + tron` mapping. Conflicting `common`, `tvmOpts.common` and `tvm.common` settings throw; equivalent settings resolve to one shared Common. See [Common configuration](../common/README.md) for network and protocol options.

```ts
// ./examples/runTx.ts

import { Common, TronMainnet } from '@tvmjs/common'
import { createLegacyTx } from '@tvmjs/tx'
import { Account, createAddressFromPrivateKey, createZeroAddress, hexToBytes } from '@tvmjs/util'
import { createVM, runTx } from '@tvmjs/vm'

const main = async () => {
  const common = new Common({ chain: TronMainnet })
  const vm = await createVM({ common })
  // Public example key for a local simulation account.
  const privateKey = hexToBytes(`0x${'01'.repeat(32)}`)
  await vm.stateManager.putAccount(
    createAddressFromPrivateKey(privateKey),
    new Account(0n, 1000000n),
  )
  const tx = createLegacyTx(
    {
      gasLimit: 21000n,
      gasPrice: 10n,
      value: 1n,
      to: createZeroAddress(),
    },
    { common },
  ).sign(privateKey)
  const result = await runTx(vm, { tx })
  if (result.execResult.exceptionError) throw result.execResult.exceptionError
  console.log(result.totalGasSpent) // 21000n for the local transaction envelope
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

```

#### TRON Transaction IDs

TRON contract deployment and internal `CREATE` derive addresses from a 32-byte root transaction
ID. `runTx()` accepts the real java-tron ID through `rootTransactionId`. An explicit ID always wins.

For compatibility with 1.0.x applications and local simulators, 1.1.x defaults
`tronTransactionIdPolicy` to `fallback-to-tx-hash`. When no explicit ID is available, a signed
transaction's TVMJS hash is used as a deterministic simulation ID. This hash is the Keccak hash of
the serialized signed TVMJS transaction; it is not java-tron's SHA-256 transaction ID and can
therefore produce a different contract address from the real TRON chain.

Existing simulation code can continue to omit the ID:

```ts
const result = await runTx(vm, {
  tx,
  // Default: tronTransactionIdPolicy: 'fallback-to-tx-hash'
})
```

Real-chain replay and consistency tests should provide the java-tron ID and disable fallback:

```ts
const result = await runTx(vm, {
  tx,
  rootTransactionId: javaTronTransactionId,
  tronTransactionIdPolicy: 'require-explicit',
})
```

For block replay, IDs remain transaction-indexed and the policy is applied by `runTx()` when an
entry is missing:

```ts
const result = await runBlock(vm, {
  block,
  rootTransactionIds: javaTronTransactionIds,
  tronTransactionIdPolicy: 'require-explicit',
})
```

Block builders accept the same `rootTransactionId` and `tronTransactionIdPolicy` options in each
`addTransaction()` call.

Additionally to the `VM.runTx()` method there is an API method `VM.runBlock()` which allows to run the whole block and execute all included transactions along.

### RPC Integration

The previous Ethereum Mainnet and Goerli execution examples have been retired. These examples use local TRON execution and explicit state inputs.

### Building a Block

The VM package can also be used to construct a new valid block by executing and then integrating txs one-by-one.

The following non-complete example gives some illustration on how to use the Block Builder API:

```ts
// ./examples/buildBlock.ts

import { createBlock } from '@tvmjs/block'
import { Common, TronMainnet } from '@tvmjs/common'
import { createLegacyTx } from '@tvmjs/tx'
import { Account, bytesToHex, createAddressFromPrivateKey, hexToBytes } from '@tvmjs/util'
import { buildBlock, createVM } from '@tvmjs/vm'

const main = async () => {
  const common = new Common({ chain: TronMainnet })
  const vm = await createVM({ common })

  const parentBlock = createBlock({ header: { number: 1n } }, { common })
  const headerData = {
    number: 2n,
  }
  const blockBuilder = await buildBlock(vm, {
    parentBlock, // the parent @ethereumjs/block Block
    headerData, // header values for the new block
    blockOpts: {
      freeze: false,
      skipConsensusFormatValidation: true,
      putBlockIntoBlockchain: false,
    },
  })

  const pk = hexToBytes('0x26f81cbcffd3d23eace0bb4eac5274bb2f576d310ee85318b5428bf9a71fc89a')
  const address = createAddressFromPrivateKey(pk)
  const account = new Account(0n, 0xfffffffffn)
  await vm.stateManager.putAccount(address, account) // create a sending account and give it a big balance
  const tx = createLegacyTx({ gasLimit: 0xffffff, gasPrice: 75n }).sign(pk)
  await blockBuilder.addTransaction(tx)

  // Add more transactions

  const { block } = await blockBuilder.build()
  console.log(`Built a block with hash ${bytesToHex(block.hash())}`)
}

void main()

```

### WASM Crypto Support

This library by default uses JavaScript implementations for the basic standard crypto primitives like hashing or signature verification (for included txs). See `@tvmjs/common` [README](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/common) for instructions on how to replace with e.g. a more performant WASM implementation by using a shared `common` instance.

## TRON Energy and transaction overhead

Block builders inherit the parent gas limit and calculate the next base fee from the parent unless explicitly overridden. London activation heights do not double gas limits or reset fees. `runBlock()` does not apply DAO balance transfers or create a DAO refund account.

`runTx().execResult.executionGasUsed` uses the same [TRON Energy schedule](../tvm/README.md#tron-energy-accounting) as a direct TVM call with equivalent state, code and execution settings. `totalGasSpent` also includes the TVMJS transaction envelope's intrinsic gas: the base transaction cost, calldata cost and any top-level creation cost. This wrapper overhead is not java-tron execution Energy or its bandwidth/staking/feeLimit accounting.

EIP-2930 and EIP-1559 transactions remain available as TVMJS transaction formats. Their access-list fields are validated and signed, but have no address/slot surcharge and do not warm state. `reportAccessList` reports diagnostic accesses without changing execution costs. The default TRON schedule generates no SSTORE or SELFDESTRUCT refunds; unused prepaid call and transaction gas is still returned.

## Examples

For a read-only java-tron RPC state adapter, local TVM execution, and a
`triggerconstantcontract` result comparison, see the experimental
[TRON RPC Client PoC](./examples/TRON_RPC_POC.md).

See the [examples](./examples/) folder for different meaningful examples on how to use the VM package and invoke certain aspects of it, e.g. running a complete block, a certain tx or using event listeners, among others. Some noteworthy examples to point out:

1. [./examples/run-blockchain](./examples/run-blockchain.ts): Loads tests data, including accounts and blocks, and runs all of them in the VM.
2. [./examples/run-solidity-contract](./examples/run-solidity-contract.ts): Compiles a Solidity contract, and calls constant and non-constant functions.

## Browser

We provide hybrid ESM/CJS builds for all our libraries. With the v10 breaking release round from Spring 2025, all libraries are "pure-JS" by default and we have eliminated all hard-wired WASM code. Additionally we have substantially lowered the bundle sizes, reduced the number of dependencies, and cut out all usages of Node.js-specific primitives (like the Node.js event emitter).

It is easily possible to run a browser build of one of the TVMJS libraries within a modern browser using the provided ESM build. For a setup example see [./examples/browser.html](./examples/browser.html).

## API

### Docs

Generate the API reference for VM initialization, methods and events with `npm run docs:build --workspace @tvmjs/vm` from the repository root. The output is written to `packages/vm/docs`.

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

## Architecture

### VM/TVM Relation

Starting with the `VM` v6 version the inner TVM core previously included in this library has been extracted to an own package [@tvmjs/tvm](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/tvm).

It is still possible to access all `TVM` functionality through the `tvm` property of the initialized `vm` object, e.g.:

```ts
vm.tvm.runCode()
vm.tvm.events.on('step', function (data) {
  console.log(`Opcode: ${data.opcode.name}\tStack: ${data.stack}`)
})
```

Note that it's now also possible to pass in an own or customized `TVM` instance by using the optional `tvm` constructor option.

### State and Blockchain Information

A previously needed EEI interface for TVM/VM communication is not needed any more and the API has been simplified, also see the respective TVM README section. Most of the EEI related logic is now either handled internally or more generic functionality being taken over by the `@tvmjs/statemanager` package, with the `TVM` now taking in both an (optional) `stateManager` and `blockchain` argument for the constructor (which the `VM` passes over by default).

The previously included `StateManager` has been extracted to its own package [@tvmjs/statemanager](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/statemanager). The `StateManager` package provides a unified state interface and it is now also possible to provide a modified or custom `StateManager` to the VM via the optional `stateManager` constructor option.

## Setup

### Chains

Choose `TronMainnet`, `TronNile` or `TronShasta`. Presets contain execution settings without network genesis or consensus data. A custom Blockchain requires an explicitly supplied genesis block or network genesis metadata.

### Hardforks

Only `Hardfork.Tron` is selectable. Governance flags and supported capabilities are configured through Common, independently of Ethereum hardfork schedules.

```ts
import { Common, TronNile } from '@tvmjs/common'
import { createVM } from '@tvmjs/vm'

const vm = await createVM({ common: new Common({ chain: TronNile }) })
```

### Custom Genesis State

For initializing a custom genesis state, create the VM and initialize its state manager explicitly.

```ts
import { createAddressFromString } from '@tvmjs/util'
import { createVM } from '@tvmjs/vm'

import type { GenesisState } from '@tvmjs/common'

const main = async () => {
  const accountAddress = '0x000d836201318ec6899a67540690382780743280'
  const genesisState: GenesisState = {
    [accountAddress]: '0xde0b6b3a7640000',
  }

  const vm = await createVM()
  await vm.stateManager.generateCanonicalGenesis!(genesisState)
  const account = await vm.stateManager.getAccount(createAddressFromString(accountAddress))

  if (account === undefined) {
    throw new Error('Account does not exist: failed to import genesis state')
  }

  console.log(
    `This balance for account ${accountAddress} in this chain's genesis state is ${Number(
      account?.balance,
    )}`,
  )
}
void main()

```

Genesis state can be configured to contain both EOAs as well as (system) contracts with initial storage values set.

## Supported EIPs

Execution capabilities follow the independent TRON profile in `@tvmjs/common`. Explicit CLZ activation is supported through `eips: [7939]`. Blob transactions, beacon-root execution and withdrawn Ethereum profile capabilities cannot be reactivated.

```ts
// ./examples/vmWithEIPs.ts

import { Common, Hardfork, TronMainnet } from '@tvmjs/common'
import { createVM } from '@tvmjs/vm'

const main = async () => {
  const common = new Common({ chain: TronMainnet, hardfork: Hardfork.Tron, eips: [7939] })
  const vm = await createVM({ common })
  console.log(`CLZ is explicitly active on the TRON profile - ${vm.common.isActivatedEIP(7939)}`)
}
void main()

```

See [Common](../common/README.md) for capability and proposal configuration and [TRON Energy accounting](../tvm/README.md#tron-energy-accounting) for the implemented schedule and its validation limits. Retained Ethereum-only data tools do not enable their execution capabilities.

## Events

### Tracing Events

Our `TypeScript` VM emits events that support async listeners (using [EventEmitter3](https://github.com/primus/eventemitter3)).

You can subscribe to the following events:

- `beforeBlock`: Emits a `Block` right before running it.
- `afterBlock`: Emits `AfterBlockEvent` right after running a block.
- `beforeTx`: Emits a `Transaction` right before running it.
- `afterTx`: Emits a `AfterTxEvent` right after running a transaction.

Note, if subscribing to events with an async listener, specify the second parameter of your listener as a `resolve` function that must be called once your listener code has finished.

```ts
// ./examples/eventListener.ts#L10-L19

// Setup an event listener on the `afterTx` event
vm.events.on('afterTx', (event, resolve) => {
  console.log('asynchronous listener to afterTx', bytesToHex(event.transaction.hash()))
  // we need to call resolve() to avoid the event listener hanging
  resolve?.()
})

vm.events.on('afterTx', (event) => {
  console.log('synchronous listener to afterTx', bytesToHex(event.transaction.hash()))
})
```

Please note that there are additional TVM-specific events in the [@tvmjs/tvm](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/tvm) package.

### Asynchronous event handlers

You can perform asynchronous operations from within an event handler
and prevent the VM to keep running until they finish.

In order to do that, your event handler has to accept two arguments.
The first one will be the event object, and the second one a function.
The VM won't continue until you call this function.

If an exception is passed to that function, or thrown from within the
handler or a function called by it, the exception will bubble into the
VM and interrupt it, possibly corrupting its state. It's strongly
recommended not to do that.

### Synchronous event handlers

If you want to perform synchronous operations, you don't need
to receive a function as the handler's second argument, nor call it.

Note that if your event handler receives multiple arguments, the second
one will be the continuation function, and it must be called.

If an exception is thrown from within the handler or a function called
by it, the exception will bubble into the VM and interrupt it, possibly
corrupting its state. It's strongly recommended not to throw from within
event handlers.

## Understanding the VM

If you want to understand your VM runs we have added a hierarchically structured list of debug loggers for your convenience which can be activated in arbitrary combinations. We also use these loggers internally for development and testing. These loggers use the [debug](https://github.com/visionmedia/debug) library and can be activated on the CL with `DEBUG=tvmjs,[Logger Selection] node [Your Script to Run].js` and produce output like the following:

![TVMJS VM Debug Logger](./debug.png?raw=true)

The following loggers are currently available:

| Logger      | Description                                                        |
| ----------- | ------------------------------------------------------------------ |
| `vm:block`  | Block operations (run txs, generating receipts, block rewards,...) |
| `vm:tx`     |  Transaction operations (account updates, checkpointing,...)       |
| `vm:tx:gas` |  Transaction gas logger                                            |
| `vm:state`  | StateManager logger                                                |

Note that there are additional TVM-specific loggers in the [@tvmjs/tvm](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/tvm) package.

Here are some examples for useful logger combinations.

Run one specific logger:

```shell
DEBUG=tvmjs,vm:tx tsx test.ts
```

Run all loggers currently available:

```shell
DEBUG=tvmjs,vm:*,vm:*:* tsx test.ts
```

Run only the gas loggers:

```shell
DEBUG=tvmjs,vm:*:gas tsx test.ts
```

Excluding the state logger:

```shell
DEBUG=tvmjs,vm:*,vm:*:*,-vm:state tsx test.ts
```

Run some specific loggers including a logger specifically logging the `SSTORE` executions from the VM (this is from the screenshot above):

```shell
DEBUG=tvmjs,vm:tx,vm:tvm,vm:ops:sstore,vm:*:gas tsx test.ts
```

## Internal Structure

The VM processes state changes at several levels:

- **[`runBlock`](./src/runBlock.ts)**: Processes a single block.
  - Performs initial setup: Validates hardfork compatibility, sets the state root (if provided), selects the TRON execution profile.
  - Manages state checkpoints before and after processing.
  - Iterates through transactions within the block:
    - For each transaction, calls `runTx`.
  - Finalizes the block state (state root, receipts root, logs bloom).
  - Commits or reverts state changes based on success.
- **[`runTx`](./src/runTx.ts)**: Processes a single transaction.
  - Performs pre-execution checks: Sender balance sufficient for gas+value, sender nonce validity, transaction gas limit against block gas limit and supported transaction types. Typed and EIP-155-protected transactions must match the VM chainId; unprotected legacy envelopes remain valid across networks.
  - For nonzero TRC-10 transfers with normal balance validation, checks the local Token registry and sender balance. SimpleStateManager and MerkleStateManager populate their registries from supplied account assets; RPCStateManager does not implement Token existence lookup. See [StateManager capabilities](../statemanager/README.md#local-trc-10-registry).
  - Collects requested access diagnostics without prewarming addresses or storage.
  - Pays intrinsic gas cost.
  - Executes the transaction code using `vm.tvm.runCall` (or specific logic for contract creation).
  - Calculates gas used and refunds remaining gas.
  - Transfers gas fees to the fee recipient (recipient receives all pre EIP-1559, base fee is burned post EIP-1559).
  - Generates a transaction receipt.
  - Manages state checkpoints and commits/reverts changes for the transaction.
- **[`vm.tvm.runCall`](../tvm/src/tvm.ts)** (within `@tvmjs/tvm`): Executes the TVM code for a transaction (message call or contract creation).
  - Steps through TVM opcodes.
  - Manages memory, stack, and storage changes.
  - Handles exceptions and gas consumption during execution.

Note: The process of iterating through the blockchain (block by block) is typically managed by components outside the core VM package, such as `@tvmjs/blockchain` or a full client implementation, which then utilize the VM's `runBlock` method.

## Development

Developer documentation - currently mainly with information on testing and debugging - can be found [here](./DEVELOPER.md).

## Upstream

This package is part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, a TypeScript implementation of the TRON Virtual Machine (TVM) forked from the [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo) monorepo. We gratefully acknowledge the EthereumJS team for building and maintaining the original implementation.

For development information, see the [developer docs](../../DEVELOPER.md) and our [code of conduct](../../CODE_OF_CONDUCT.md).
## License

[MPL-2.0](<https://tldrlegal.com/license/mozilla-public-license-2.0-(mpl-2)>)

This package is derived from the original [@ethereumjs](https://github.com/ethereumjs/ethereumjs-monorepo) implementation, licensed under MPL-2.0. All original source files retain their MPL-2.0 license.
