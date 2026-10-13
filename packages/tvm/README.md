<!-- cspell:ignore blockhashes Fusaka prehash subarray CALLDATACOPY CODECOPY dataloadn datasize datacopy -->

# @tvmjs/tvm

EIP-170 runtime limits and EIP-3860 initcode limits/metering are removed. Omit `allowUnlimitedContractSize` and `allowUnlimitedInitCodeSize`; either key now throws, even with `false` or `undefined`. The corresponding instance properties, size parameters and error identifiers are removed. Code deposit, memory and CREATE2 hashing still consume Energy. See [contract size migration](../common/README.md#contract-size-configuration-in-v120).

v1.2.0 removes Blob execution context and BLOBHASH/BLOBBASEFEE implementations. Passing `blobVersionedHashes` to a Message, `runCall()` or `runCode()` now throws. TRON Token opcodes and the multi-sign precompile at `0x0a` are preserved. See [Blob migration and affected packages](../common/README.md#blob-removal-in-v120).

Caller-supplied block contexts with `parentBeaconBlockRoot` or `parent_beacon_block_root` are rejected before execution. EIP-4788 cannot be activated. See [Beacon root migration](../common/README.md#beacon-root-removal-in-v120).

EIP-7702 code delegation and `DELEGATION_7702_FLAG` are removed. Code beginning with `0xef0100` fails as invalid bytecode without loading a delegation target. Ordinary CALL/DELEGATECALL behavior is preserved. See [EIP-7702 migration](../common/README.md#eip-7702-removal-in-v120).

The shared execution table reserves `0xd0`–`0xd3` for TRON `CALLTOKEN`, `TOKENBALANCE`, `CALLTOKENVALUE` and `CALLTOKENID`. Conflicting EOF data-instruction handlers and the `7480` group in the exported `paramsTVM` dictionary are removed, including `dataloadGas`, `dataloadnGas`, `datasizeGas` and `datacopyGas`. EOF cannot be activated through the TRON profile; independent EOF container parsing and the remaining inactive EOF implementation are retained.

| TypeScript implementation of the TRON Virtual Machine (TVM). Part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, forked from [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo). |
| --- |

- 🦄 TRON execution profile with Mainnet, Nile and Shasta presets
- 🌴 Tree-shakeable API
- 👷🏼 Controlled dependency set (7 external + `@Noble` crypto)
- 🧩 Explicit TRON capabilities and governance proposals
- 🛠️ Custom precompiles
- 🚀 Built-in profiler
- 🪢 User-friendly colored debugging
- 🏄🏾‍♂️ WASM-free default + Fully browser ready

## Table of Contents

- [Installation](#installation)
- [Getting Started](#getting-started)
- [Examples](#examples)
- [Browser](#browser)
- [API](#api)
- [Architecture](#architecture)
- [Supported Hardforks](#supported-hardforks)
- [Supported EIPs](#supported-eips)
- [Precompiles](#precompiles)
- [Events](#events)
- [Understanding the TVM](#understanding-the-tvm)
- [Profiling the TVM](#profiling-the-tvm)
- [Development](#development)
- [Upstream](#upstream)
- [License](#license)

## Installation

To obtain the latest version, simply require the project using `npm`:

```shell
npm install @tvmjs/tvm
```

This package provides the core TRON Virtual Machine (TVM) implementation which is capable of executing TVM-compatible bytecode. The package has been extracted from the [@tvmjs/vm](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/vm) package along the VM `v6` release.

## Getting Started

### Basic

The following is the simplest example for an TVM instantiation with reasonable defaults for state and blockchain information (like blockhashes):

`createTVM()` defaults to the execution-only `TronMainnet` profile. Select `TronNile` or `TronShasta` through an explicit Common. This v1.2.0 development branch accepts only the `tron` profile; Ethereum presets and the old implicit `Mainnet + tron` mapping are rejected. Execution does not require network genesis or consensus metadata.

See [Common configuration](../common/README.md) for network and protocol options.

```ts
// ./examples/simple.ts

import { createTVM } from '@tvmjs/tvm'
import { hexToBytes } from '@tvmjs/util'

const main = async () => {
  const tvm = await createTVM()
  const res = await tvm.runCode({ code: hexToBytes('0x6001') }) // PUSH1 01 -- simple bytecode to push 1 onto the stack
  console.log(res.executionGasUsed) // 3n
}

void main()
```

### Blockchain, State and Events

If you want the TVM to run against a specific state, you need an `@tvmjs/statemanager`. An `@tvmjs/blockchain` instance can be passed in to provide access to external interface information like a blockhash:

```ts
// ./examples/withBlockchain.ts

import { createBlock } from '@tvmjs/block'
import { createBlockchain } from '@tvmjs/blockchain'
import { Common, Hardfork, TronMainnet } from '@tvmjs/common'
import { MerkleStateManager } from '@tvmjs/statemanager'
import { createTVM } from '@tvmjs/tvm'
import { bytesToHex, hexToBytes } from '@tvmjs/util'

import type { PrefixedHexString } from '@tvmjs/util'

const main = async () => {
  const common = new Common({ chain: TronMainnet, hardfork: Hardfork.Tron })
  const stateManager = new MerkleStateManager({ common })
  // A synthetic genesis block for this local execution example.
  const genesisBlock = createBlock({}, { common })
  const blockchain = await createBlockchain({ common, genesisBlock })

  const tvm = await createTVM({
    common,
    stateManager,
    blockchain,
  })

  const STOP = '00'
  const ADD = '01'
  const PUSH1 = '60'

  // Note that numbers added are hex values, so '20' would be '32' as decimal e.g.
  const code = [PUSH1, '03', PUSH1, '05', ADD, STOP]

  tvm.events.on('step', function (data) {
    // Note that data.stack is not immutable, i.e. it is a reference to the vm's internal stack object
    console.log(`Opcode: ${data.opcode.name}\tStack: ${data.stack}`)
  })

  const results = await tvm.runCode({
    code: hexToBytes(('0x' + code.join('')) as PrefixedHexString),
    gasLimit: BigInt(0xffff),
  })

  console.log(`Returned: ${bytesToHex(results.returnValue)}`)
  console.log(`gasUsed: ${results.executionGasUsed.toString()}`)
}

void main()

```

Additionally, this example shows how to use events to listen to the inner workings and procedural updates
(`step` event) of the TVM.

### WASM Crypto Support

This library by default uses JavaScript implementations for the basic standard crypto primitives like hashing or signature verification (for included txs). See `@tvmjs/common` [README](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/common) for instructions on how to replace them with, e.g., a more performant WASM implementation by using a shared `common` instance.

## TRON Energy accounting

The default schedule follows java-tron [GreatVoyage-v4.8.2 EnergyCost](https://github.com/tronprotocol/java-tron/blob/f8ff7c76f45ab41d9bb76922329657506819701b/actuator/src/main/java/org/tron/core/vm/EnergyCost.java). It uses version-0 call forwarding, no dynamic Energy penalty, the original memory instruction schedule, and the SELFDESTRUCT restriction already selected by this profile. These are execution settings, not a claim about the current governance state of a network.

| Operation | Energy |
| --- | --- |
| BALANCE, EXTCODESIZE, TOKENBALANCE, ISCONTRACT | 20 |
| EXTCODEHASH | 400 |
| SLOAD | 50 |
| SSTORE, first nonzero write to an absent slot | 20,000 |
| Other SSTORE writes, including unchanged values | 5,000 |
| CALL, CALLCODE, DELEGATECALL, STATICCALL, CALLTOKEN | 40 base |
| Nonzero CALL/CALLTOKEN transfer | 9,000, plus 25,000 if the recipient is missing |
| SELFDESTRUCT | 5,000, plus 25,000 if the beneficiary is missing |

Memory expansion, data copying and callee execution are charged separately. A CALL transfers at most the remaining Energy after caller costs, without reserving Ethereum's 1/64. The 2,300 value-transfer stipend and unused callee Energy follow the reference call rules. Existing empty accounts do not pay creation Energy, and zero-value calls do not create missing recipients.

An explicit `runCall({ code })` override initializes a missing execution account so storage writes continue to work, without saving the supplied code.

There are no cold/warm access surcharges or SSTORE/SELFDESTRUCT refunds. Access-list reporting is diagnostic and does not warm state. Journal checkpoints and revert behavior remain active.

A slot written to zero remains present for the rest of that transaction, matching java-tron's storage row cache. Subsequent writes to that slot cost 5,000 Energy, even when its current value is zero. For example, `0 → 1 → 0 → 1` costs 30,000 Energy for the three SSTORE instructions, plus instruction setup costs. Successful child calls preserve this presence; reverted child calls discard their changes. A later public execution starts with fresh storage-presence tracking.

MLOAD, MSTORE and MSTORE8 charge memory expansion without an additional base fee in the original schedule. To reproduce java-tron's `allowHigherLimitForMaxCpuTimeOfOneTx` memory adjustment, set `params: { tron: { mloadGas: 1, mstoreGas: 1, mstore8Gas: 1 } }` on Common. CALLDATACOPY, CODECOPY and RETURNDATACOPY charge expansion and copying without an extra base fee in either schedule.

The original [Energy vectors](./test/testdata/tronEnergy.json) record source-derived costs and pre-migration results. The separate [execution fixture](./test/testdata/javaTronExecution.json) contains 71 reference results measured externally with the pinned java-tron VM engine, using real repository caches and mocked empty backing stores. The [fixed inputs](./test/testdata/javaTronExecutionInputs.json) and results record the upstream commit, execution configuration and provenance hashes. TVM tests compare Energy, errors, return values, stack, logs and account state across three TRON presets and two StateManagers; VM tests replay the same inputs through signed local transaction envelopes. These regression tests run TVMJS against the recorded results and require no Java, Gradle or external checkout.

This validates the recorded execution settings. It does not run a live node or cover dynamic Energy penalties, version-1 contracts or the full bandwidth/staking/feeLimit resource model. `executionGasUsed` measures execution Energy; the VM wrapper's transaction overhead is reported separately in `totalGasSpent`.

### Storage parameter migration in v1.2.0

<!-- cspell:ignore coldsload -->

Remove these retired keys from consumers of the public `paramsTVM` dictionary:

| Former groups | Removed keys |
| --- | --- |
| 1013, 1716 | `netSstoreNoopGas`, `netSstoreInitGas`, `netSstoreCleanGas`, `netSstoreDirtyGas`, `netSstoreClearRefundGas`, `netSstoreResetRefundGas`, `netSstoreResetClearRefundGas` |
| 1679, 2929, 3529 | `sstoreSentryEIP2200Gas`, `sstoreNoopEIP2200Gas`, `sstoreDirtyEIP2200Gas`, `sstoreInitEIP2200Gas`, `sstoreInitRefundEIP2200Gas`, `sstoreCleanEIP2200Gas`, `sstoreCleanRefundEIP2200Gas`, `sstoreClearRefundEIP2200Gas` |
| 2929 | `coldsloadGas` |

The empty `1716` parameter group is also removed. Use `sloadGas`, `sstoreSetGas` and `sstoreResetGas` for the current TRON schedule. Supplying retired keys as custom parameters does not enable net metering, storage refunds or EIP-2929. Other entries in shared parameter groups remain available, including address costs used by the retained, inactive EOF implementation.

`TVMError.errorMessages.CODESTORE_OUT_OF_GAS` is removed. Handle `OUT_OF_GAS` for insufficient code-deposit Energy; the failed creation is reverted, including storage, logs and value transfers. Internal CREATE/CREATE2 returns zero when the child fails.

## Examples

See the [examples](./examples/) folder for different meaningful examples on how to use the TVM package and invoke certain aspects of it, e.g. running a bytecode snippet, listening to events, or to activate an TVM with a certain EIP for experimental purposes.

## Browser

We provide hybrid ESM/CJS builds for all our libraries. With the v10 breaking release round from Spring 2025, all libraries are "pure-JS" by default and we have eliminated all hard-wired WASM code. Additionally we have substantially lowered the bundle sizes, reduced the number of dependencies, and cut out all usages of Node.js-specific primitives (like the Node.js event emitter).

It is easily possible to run a browser build of one of the TVMJS libraries within a modern browser using the provided ESM build. For a setup example see [./examples/browser.html](./examples/browser.html).

## API

### Docs

Generate the API reference for TVM initialization, methods and events with `npm run docs:build --workspace @tvmjs/tvm` from the repository root. The output is written to `packages/tvm/docs`.

### Hybrid CJS/ESM Builds

With the breaking releases from Summer 2023 we have started to ship our libraries with both CommonJS (`cjs` folder) and ESM builds (`esm` folder), see `package.json` for the detailed setup.

If you use an ES6-style `import` in your code files, the ESM build will be used:

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

This package contains the inner TRON Virtual Machine (TVM) core functionality which was included in the [@tvmjs/vm](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/vm) package up to v5 and has been extracted along the v6 release.

This will make it easier to customize the inner TVM, which can now be passed as an optional argument to the outer `VM` instance.

### State and Blockchain Information

For the TVM to properly work it needs access to a respective execution environment (to e.g. request on information like block hashes) as well as the connection to an outer account and contract state.

With the v2 release TVM, VM and StateManager have been substantially reworked in this regard, see PR [#2649](https://github.com/ethereumjs/ethereumjs-monorepo/pull/2649/) and PR [#2702](https://github.com/ethereumjs/ethereumjs-monorepo/pull/2702) for further deepening context.

The interfaces (in a non-TypeScript sense) between these packages have been simplified and the `EEI` package has been completely removed. Most of the EEI related logic is now either handled internally or more generic functionality being taken over by the `@tvmjs/statemanager` package.

This allows for both a standalone TVM instantiation with reasonable defaults as well as for a simplified TVM -> VM passing if a customized TVM is needed.

## Supported Hardforks

The only supported execution profile is `Hardfork.Tron`. Capabilities are selected from `tronExecutionProfile` in `@tvmjs/common`; Ethereum block numbers, timestamps and hardfork names do not control TRON execution.

Proposal 95/96 are supplied through `activatedProposals`. They retain their existing execution gates and do not imply complete java-tron Prague/Osaka support.

## Supported EIPs

Common and TVM validate explicit EIPs against the same `tronExecutionProfile`. Its base implementation groups can be supplied explicitly without changing TRON Energy costs. Explicit CLZ activation uses `eips: [7939]`. Unsupported EIPs, including 4844, 4788 and 7516, are rejected.

```ts
// ./examples/eips.ts

import { Common, Hardfork, TronMainnet } from '@tvmjs/common'
import { createTVM } from '@tvmjs/tvm'

const main = async () => {
  const common = new Common({ chain: TronMainnet, hardfork: Hardfork.Tron, eips: [7939] })
  const tvm = await createTVM({ common })
  console.log(`CLZ is explicitly active on the TRON profile - ${tvm.common.isActivatedEIP(7939)}`)
}

void main()

```

The [TRON Energy schedule](#tron-energy-accounting) applies independently of Ethereum hardfork ordering. See [Common configuration](../common/README.md) for profile and proposal settings.

## Precompiles

The TRON profile selects precompiles through explicit capabilities. The existing 0x01 through 0x08 implementations remain available, followed by TRON batch signature validation at 0x09 and multi-signature validation at 0x0a. Proposal 96 retains strict input checks for the TRON signature precompiles.

Multi-signature validation at `0x0a` accepts at most 5 signatures and counts each recovered signer only once within that invocation. Batch validation at `0x09` accepts at most 16 signatures and returns individual verification results. These precompiles do not track messages across calls or transactions; contracts must enforce any required replay protection, such as a nonce or consumed-message record, in the signed payload and contract state.

See [the MODEXP example](./examples/precompiles/05-modexp.ts) for a direct call. BLS, KZG and optional Ethereum hardfork activation examples have been retired with their configuration entry points.

### Custom Precompiles

The TVM supports registering custom precompiles at arbitrary addresses. Custom precompiles can **add** new precompiles, **override** existing ones, or **delete** built-in precompiles.

Pass an array of `CustomPrecompile` entries to the `customPrecompiles` option when creating the TVM:

```ts
// ./examples/precompiles/customPrecompile.ts

import { Common, Hardfork, TronMainnet } from '@tvmjs/common'
import { createTVM } from '@tvmjs/tvm'
import {
  bigIntToBytes,
  bytesToBigInt,
  bytesToHex,
  createAddressFromString,
  setLengthLeft,
} from '@tvmjs/util'

import type { ExecResult, PrecompileInput } from '@tvmjs/tvm'

// Custom precompile that adds two 32-byte big-endian unsigned integers (mod 2^256).
const ADDITION_GAS = 15n

function additionPrecompile(input: PrecompileInput): ExecResult {
  const a = bytesToBigInt(input.data.subarray(0, 32))
  const b = bytesToBigInt(input.data.subarray(32, 64))
  const sum = (a + b) % 2n ** 256n
  return {
    executionGasUsed: ADDITION_GAS,
    returnValue: setLengthLeft(bigIntToBytes(sum), 32),
  }
}

const main = async () => {
  const common = new Common({ chain: TronMainnet, hardfork: Hardfork.Tron })
  const ADDRESS = '0x000000000000000000000000000000000000ff01'

  // Register the custom precompile with a hex string address
  const tvm = await createTVM({
    common,
    customPrecompiles: [{ address: ADDRESS, function: additionPrecompile }],
  })

  // Verify it is registered
  const fn = tvm.getPrecompile(ADDRESS)
  console.log(`Precompile registered at ${ADDRESS}: ${fn !== undefined}`)

  // Build call data: two 32-byte values (7 + 35)
  const a = setLengthLeft(bigIntToBytes(7n), 32)
  const b = setLengthLeft(bigIntToBytes(35n), 32)
  const callData = new Uint8Array(64)
  callData.set(a, 0)
  callData.set(b, 32)

  // Execute via runCall
  const result = await tvm.runCall({
    to: createAddressFromString(ADDRESS),
    gasLimit: BigInt(30000),
    data: callData,
  })

  console.log('--------------------------------')
  console.log('Custom Addition Precompile')
  console.log(`Input    : 7 + 35`)
  console.log(
    `Result   : ${bytesToBigInt(result.execResult.returnValue)} (${bytesToHex(result.execResult.returnValue)})`,
  )
  console.log(`Gas used : ${result.execResult.executionGasUsed}`)
  console.log('--------------------------------')
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})

```

The address for custom precompiles can be specified as either an `Address` instance or a `0x`-prefixed hex string. All relevant types (`CustomPrecompile`, `AddPrecompile`, `DeletePrecompile`, `PrecompileFunc`, `PrecompileInput`) are exported from `@tvmjs/tvm`.

You can use `tvm.getPrecompile(address)` to retrieve a registered precompile function at any address (works for both built-in and custom precompiles):

```ts
const sha256 = tvm.getPrecompile('0x0000000000000000000000000000000000000002')
const custom = tvm.getPrecompile('0x000000000000000000000000000000000000ff01') // custom
```

To **override** a built-in precompile, register a custom precompile at the same address. To **delete** a precompile, pass an entry with only the `address` field (no `function`):

```ts
const tvm = await createTVM({
  customPrecompiles: [
    { address: '0x0000000000000000000000000000000000000002' }, // deletes SHA256
  ],
})
```

## Events

### Tracing Events

The TVM emits events that support async listeners (using [EventEmitter3](https://github.com/primus/eventemitter3)).

You can subscribe to the following events:

- `beforeMessage`: Emits a `Message` right after running it.
- `afterMessage`: Emits an `TVMResult` right after running a message.
- `step`: Emits an `InterpreterStep` right before running an TVM step.
- `newContract`: Emits a `NewContractEvent` right before creating a contract. This event contains the deployment code, not the deployed code, as the creation message may not return such a code.

#### Event listeners

You can perform asynchronous operations from within an event handler
and prevent the TVM from continuing until they finish.

If subscribing to events with an async listener, specify the second
parameter of your listener as a `resolve` function that must be called once your listener code has finished.

See below for example usage:

```ts
// ./examples/eventListener.ts#L7-L14

tvm.events.on('beforeMessage', (event) => {
  console.log('synchronous listener to beforeMessage', event)
})
tvm.events.on('afterMessage', (event, resolve) => {
  console.log('asynchronous listener to beforeMessage', event)
  // we need to call resolve() to avoid the event listener hanging
  resolve?.()
})
```

If an exception is passed to that function, or thrown from within the
handler or a function called by it, the exception will bubble into the
TVM and interrupt it, possibly corrupting its state. It's strongly
recommended not to do that.

## Understanding the TVM

If you want to understand your TVM runs we have added a hierarchically structured list of debug loggers for your convenience which can be activated in arbitrary combinations. We also use these loggers internally for development and testing. These loggers use the [debug](https://github.com/visionmedia/debug) library and can be activated on the CLI with `DEBUG=tvmjs,[Logger Selection] node [Your Script to Run].js` and produce output like the following:

![TVMJS TVM Debug Logger](./debug.png?raw=true)

The following loggers are currently available:

| Logger                             | Description                                         |
| ---------------------------------- | --------------------------------------------------- |
| `tvm:tvm`                          |  TVM control flow, CALL or CREATE message execution |
| `tvm:gas`                          |  TVM gas logger                                     |
| `tvm:precompiles`                  |  TVM precompiles logger                             |
| `tvm:journal`                      |  TVM journal logger                                 |
| `tvm:ops`                          |  Opcode traces                                      |
| `tvm:ops:[Lower-case opcode name]` | Traces on a specific opcode                         |

Here are some examples of useful logger combinations.

Run one specific logger:

```shell
DEBUG=tvmjs,tvm tsx test.ts
```

Run all loggers currently available:

```shell
DEBUG=tvmjs,tvm:*,tvm:*:* tsx test.ts
```

Run only the gas loggers:

```shell
DEBUG=tvmjs,tvm:*:gas tsx test.ts
```

Excluding the ops logger:

```shell
DEBUG=tvmjs,tvm:*,tvm:*:*,-tvm:ops tsx test.ts
```

Run some specific loggers including a logger specifically logging the `SSTORE` executions from the TVM (this is from the screenshot above):

```shell
DEBUG=tvmjs,tvm,tvm:ops:sstore,tvm:*:gas tsx test.ts
```

`tvmjs` **must** be included in the `DEBUG` environment variables to enable **any** logs.
Additional log selections can be added with a comma separated list (no spaces). Logs with extensions can be enabled with a colon `:`, and `*` can be used to include all extensions.

`DEBUG=tvmjs,tvm:journal,tvm:ops:* npx vitest test/runCall.spec.ts`

### Internal Structure

The TVM processes state changes through a hierarchical flow of execution:

#### Top Level: Message Execution (`runCall`)
The `runCall` method handles the execution of messages, which can be either contract calls or contract creations:
- Creates a checkpoint in the state
- Sets up the execution environment (block context, transaction origin, etc.)
- Manages account nonce updates
- Handles value transfers between accounts
- Delegates to either `_executeCall` or `_executeCreate` based on whether the message has a `to` address
- **Both `_executeCall` and `_executeCreate` call into `runInterpreter` to actually execute the bytecode**
- Processes any errors or exceptions
- Manages selfdestruct sets and created contract addresses
- Commits or reverts state changes based on execution result
- Triggers events (`beforeMessage`, `afterMessage`)

#### Code Execution (`runCode` / `runInterpreter`)
The `runCode` method is a helper for directly running TVM bytecode (e.g., for testing or utility purposes) without the full message/transaction context:
- Sets up a minimal message context for code execution
- **Directly calls `runInterpreter` to execute the provided bytecode**
- Does not go through the full message handling logic of `runCall`

The `runInterpreter` method is used by both `runCall` (via `_executeCall`/`_executeCreate`) and `runCode` to process the actual bytecode.

#### Bytecode Processing (Interpreter)
The Interpreter class is the core bytecode processor:
- Manages execution state (program counter, stack, memory, gas)
- Executes a loop that:
  - Analyzes jump destinations
  - Fetches the next opcode
  - Calculates gas costs (static and dynamic)
  - Executes the opcode handler
  - Updates the program counter
  - Emits step events for debugging/tracing
- Handles stack, memory, and storage operations
- Processes call and creation operations by delegating back to the TVM

#### Opcode Functions
Each opcode has an associated handler function that:
- Validates inputs
- Calculates dynamic gas costs
- Performs the opcode's logic (stack operations, memory operations, etc.)
- Updates the TVM state
- The program counter is incremented in between the execution of the gas handler and opcode logic handler functions, this should be considered e.g. if parsing immediate input parameters
- Special opcodes like `CALL`, `CREATE`, `DELEGATECALL` create a new message and call back to the TVM's `runCall` method

#### Journal and State Management
- State changes are tracked in a journal system
- The journal supports checkpointing and reversion
- Transient storage (EIP-1153) has its own checkpoint mechanism
- When a message completes successfully, changes are committed to the state
- On failure (exceptions), changes are reverted

This layered architecture provides separation of concerns while allowing for the complex interactions needed to execute smart contracts on the TRON platform.

## Profiling the TVM

The TVMJS TVM comes with built-in profiling capabilities to detect performance bottlenecks and to generally support the targeted evolution of the JavaScript TVM performance.

To repeatedly run the TVM profiler within the client sync the client on mainnet or a larger testnet to the desired block. Then the profiler should be run without sync (to not distort the results) by using the `--executeBlocks` and the `--vmProfileBlocks` (or `--vmProfileTxs`) flags in conjunction like:

```shell
npm run client:start -- --sync=none --vmProfileBlocks --executeBlocks=962720
```

This will give a profile output like the following:

![TVMJS TVM Profiler](./profiler.png?raw=true)

The `total (ms)` column gives you a good overview what takes the most significant amount of time, to be put in relation with the number of calls.

The number to optimize for is the `Mgas/s` value. This value indicates how much gas (being a measure for the computational cost for an opcode) can be processed by the second.

A good measure to putting this relation with is by taking both the Ethereum gas limit (the max amount of "computation" per block) and the time/slot into account. With a gas limit of 30 Mio and a 12 sec slot time this leads to a following (very) minimum `Mgas/s` value:

```shell
30M / 12 sec = 2.5 Million gas per second
```

Note that this is nevertheless a very theoretical value but pretty valuable for some first rough orientation though.

Another note: profiler results for at least some opcodes are heavily distorted, first to mention the `SSTORE` opcode where the major "cost" occurs after block execution on checkpoint commit, which is not taken into account by the profiler.

Generally all results should rather encourage and need "self thinking" 😋 and are not suited to be blindly taken over without a deeper understanding/grasping of the underlying measurement conditions.

Happy TVM Profiling! 🎉 🤩

## Development

Run the complete TVM package suites from the repository root:

```sh
npm run build --workspace @tvmjs/tvm
npm run tsc --workspace @tvmjs/tvm
npm run test:node --workspace @tvmjs/tvm
npm run test:browser --workspace @tvmjs/tvm
```

Browser tests require a local Playwright Chromium installation. Both suites include the bundled MODEXP vectors and the Noble/MCL BLS helper vectors. BLS fixtures use JSON imports so Browser runs the same cases without a filesystem loader. Direct BLS/P256 helper tests do not enable those capabilities in the TRON execution profile.

The v1.2.0 test migration follows these rules:

| Treatment | Coverage |
| --- | --- |
| Migrate retained tests | Events, custom crypto, signature and BN254 precompiles, MODEXP, transient storage, and direct P256/BLS helpers use valid TRON configuration. Preserve expected outputs and meaningful error checks. |
| Replace Ethereum expectations with TRON checks | Deployment and internal creation use root transaction IDs; CREATE2 checks the 21-byte stack result. CALL, CALLCODE, SELFDESTRUCT and BN254 use fixed TRON Energy expectations. Nonce-limit checks use different transaction IDs to avoid accidental address-collision failures; `skipBalance` tests inspect the actual caller and recipient balances. |
| Retire unsupported execution tests | Ethereum hardfork transitions, BAL/EOF activation, and alternate precompile addresses are replaced by rejection or non-registration checks. The previously excluded Ethereum EOF runners and alternate-address wrappers are removed; the underlying inactive implementations and independent EOF container parser remain. |

The external `ethereum-tests` EOF conformance vectors are not executed. A passing TVM suite covers this package's retained behavior and capability boundaries; VM API tests and the repository-wide release gates must be run separately.

See [@tvmjs/vm](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/vm) README.

## Upstream

This package is part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, a TypeScript implementation of the TRON Virtual Machine (TVM) forked from the [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo) monorepo. We gratefully acknowledge the EthereumJS team for building and maintaining the original implementation.

For development information, see the [developer docs](../../DEVELOPER.md) and our [code of conduct](../../CODE_OF_CONDUCT.md).
## License

[MPL-2.0](<https://tldrlegal.com/license/mozilla-public-license-2.0-(mpl-2)>)

This package is derived from the original [@ethereumjs](https://github.com/ethereumjs/ethereumjs-monorepo) implementation, licensed under MPL-2.0. All original source files retain their MPL-2.0 license.
