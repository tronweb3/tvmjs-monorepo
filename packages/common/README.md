# @tvmjs/common

Shared configuration for TVMJS. This development branch introduces the v1.2.0 TRON-only execution configuration.

## Installation

```sh
npm install @tvmjs/common
```

## TRON networks

| Preset | chainId | Execution profile |
| --- | --- | --- |
| `TronMainnet` | `728126428` | `tron` |
| `TronNile` | `3448148188` | `tron` |
| `TronShasta` | `2494104990` | `tron` |

```ts
import { Common, Hardfork, TronMainnet, createTronChainIdCommon } from '@tvmjs/common'

const common = new Common({ chain: TronMainnet, hardfork: Hardfork.Tron })
console.log(common.chainId()) // 728126428n
const nile = createTronChainIdCommon('nile')
console.log(nile.chainId()) // 3448148188n
```

`tron` is the only selectable execution profile. Block numbers and timestamps do not select Ethereum upgrades. The profile's block-zero marker describes an execution configuration, not a historical TRON activation schedule. The `chainId` is returned by the CHAINID opcode when this Common is supplied to a VM or TVM.

Ethereum presets, Ethereum hardforks, custom hardfork schedules and the old `Mainnet + hardfork: 'tron'` combination are rejected. Unknown preset names or IDs also throw instead of selecting a different network.

`getPresetChainConfig()` accepts the preset names in the table or their numeric chain IDs. The `createTronChainIdCommon()` factory takes the short names `mainnet`, `nile` and `shasta`.

The published `Common.isTron()` and hardfork query APIs remain available:

| Query | TRON execution result |
| --- | --- |
| `isTron()` | `true` for supported execution configurations, including custom TRON chain IDs. |
| `getHardforkBy()` / `setHardforkBy()` | `tron` for supported block and timestamp contexts. |
| `hardforkBlock()` / `hardforkTimestamp()` | `0n` / `null` for `tron`. |
| `eipBlock()` / `eipTimestamp()` | `0n` / `null` for baseline groups; optional EIPs have no scheduled activation, even when explicitly enabled. |
| `nextHardforkBlockOrTimestamp()` | `null`; no subsequent network transition is scheduled. |

Use `isActivatedEIP()` and `isActivatedProposal()` for individual capabilities. The exported historical Ethereum `Hardfork` names remain available for raw data and diagnostics; they cannot select an execution profile.

## Execution capabilities and proposals

The exported `tronExecutionProfile` lists the shared implementation groups explicitly. It has no inherited Ethereum hardfork schedule or consensus transition.

- Baseline execution includes the existing TRON opcode set, transient storage, PUSH0, MCOPY and SELFDESTRUCT behavior.
- `eips: [7939]` explicitly enables CLZ. `common.eips()` returns explicit selections; `common.isActivatedEIP(id)` includes baseline selections.
- Unsupported capabilities, including Blob transactions, beacon roots, withdrawals and Ethereum consensus transitions, cannot be activated through `setEIPs()` or a custom hardfork.
- Mainnet, Nile and Shasta default Proposal 65 on so direct TVM use matches their current memory-opcode Energy. Pass `activatedProposals: []` for execution before that proposal. Proposal 95 and 96 remain independent governance flags and do not automatically activate CLZ or the complete Prague/Osaka feature sets.

For the current mainnet rules used by `@tvmjs/client` in v1.2.0, use
`createCurrentTronMainnetCommon()`. It selects proposals 65 and 96 and enables
CLZ (`eips: [7939]`). Plain `new Common({ chain: TronMainnet })` includes
Proposal 65 only. Pass explicit `activatedProposals` and `eips` to either form
when replaying a different era.

```ts
import { createCurrentTronMainnetCommon } from '@tvmjs/common'

const common = createCurrentTronMainnetCommon()
```

```ts
import { Common, TronNile } from '@tvmjs/common'

const common = new Common({
  chain: TronNile,
  activatedProposals: [95, 96],
  eips: [7939],
})
console.log(common.isActivatedProposal(96)) // true
console.log(common.isActivatedEIP(7939)) // true
```

EIP-2929 cold/warm pricing, EIP-3529 refund rules and EIP-3651 coinbase warming are disabled and cannot be enabled explicitly. EIP-2930 remains available for transaction encoding; access lists do not change TRON Energy costs. See [TVM Energy accounting](../tvm/README.md#tron-energy-accounting) for the reference schedule and its boundaries.

## Contract size configuration in v1.2.0

TRON deployments do not apply EIP-170 runtime code limits or EIP-3860 initcode limits and word metering. `isActivatedEIP(3860)` now returns `false`; explicit activation and `paramByEIP()` queries for EIP-3860 are rejected. Group `607` remains active for shared EXP, replay-protection and created-account nonce behavior, with TRON Energy overrides.

Remove the following retired configuration from callers:

| Package | Removed API or parameter data |
| --- | --- |
| `@tvmjs/tvm` | `TVMOpts.allowUnlimitedContractSize`, `TVMOpts.allowUnlimitedInitCodeSize` and the corresponding TVM instance properties. |
| `@tvmjs/tvm` | `paramsTVM[607].maxCodeSize`, `paramsTVM[3860]` (`maxInitCodeSize`, `initCodeWordGas`), and `TVMError.errorMessages.CODESIZE_EXCEEDS_MAXIMUM` / `INITCODE_SIZE_VIOLATION`. |
| `@tvmjs/tx` | `TxOptions.allowUnlimitedInitCodeSize` and `paramsTx[3860]`. |
| `@tvmjs/vm` | The two removed TVM options inside `tvmOpts`. |

Passing a removed option throws before initialization, including `false`, `undefined`, `null` or inherited properties. Omit these keys entirely. There is no replacement bypass flag. Custom parameter data cannot restore retired size limits or word metering.

Memory expansion, CREATE2 hashing, code deposit Energy and transaction envelope charges still apply. Insufficient Energy, REVERT and invalid `0xEF` runtime code still fail and roll back deployment state. Independent EOF parsing retains its own bounds; EOF execution remains unavailable.

## Execution presets and network metadata

`TronExecutionChainConfig` contains execution settings without `genesis` or `consensus`. `NetworkChainConfig` describes explicitly supplied network metadata. No TRON preset inherits Ethereum genesis, Ethash, Casper, discovery records or fork hashes.

```ts
import { Common, TronMainnet } from '@tvmjs/common'

const common = new Common({ chain: TronMainnet })
console.log(common.hasGenesis()) // false
console.log(common.hasConsensus()) // false
```

`genesis()`, `consensusType()`, `consensusAlgorithm()` and `consensusConfig()` throw a metadata error when the corresponding data was not supplied. VM/TVM execution and execution block contexts work without it. Creating a `Blockchain` requires an explicit genesis block or network genesis metadata; enabling consensus validation additionally requires explicit consensus metadata and an implementation. This library does not provide a TRON node consensus implementation.

`ChainConfig.execution` is required and must be `'tron'`. `Mainnet`, `Sepolia`, `Holesky` and `Hoodi` are exported as `EthereumChainData`, a separate, non-executable data type. They cannot be passed to `Common` or used as the base of `createCustomCommon()`. Ethereum fork-hash operations remain unsupported.

`createCommonFromGethGenesis()`, `GethConfigOpts` and `CreateCommonFromGethGenesisOpts` have been removed. Use `parseGethGenesis()` for raw network data and `parseGethGenesisState()` for allocations. Neither parser selects an execution profile or creates a `Common`; parsed Ethereum network data is not an executable `ChainConfig`.

`parseGethGenesis()` explicitly rejects `blobSchedule`, `blobGasUsed` and `excessBlobGas`, including empty schedules and entries named `tron`. Rejection is based on field presence, including inherited or non-enumerable fields and explicit `undefined`. Blob gas fields are checked before copying input properties. Other supported genesis fields can still be parsed as raw data.

`parseGethGenesisState()` normalizes allocation addresses, balances, code, storage and nonce into `GenesisState`. It preserves integer balances using `bigint` conversion and returns allocation data; it does not calculate a state root or execute contracts. Historical Ethereum fixtures used to validate these data tools do not imply Ethereum or Blob execution support.

## Blob removal in v1.2.0

Blob support has been physically removed from this development branch. EIPs 4844, 7516, 7594, 7691, 7892 and 7918 cannot be activated. This is a breaking API change across the following packages:

| Package | Removed APIs and behavior |
| --- | --- |
| `@tvmjs/common` | `getBlobGasSchedule()`, `BpoSchedule`, `GethGenesisBlobSchedule`, `CustomCrypto.kzg`, and Blob genesis fields. |
| `@tvmjs/tx` | `Blob4844Tx`, `TransactionType.BlobEIP4844`, Blob constructors and type guards, network wrappers, `NetworkWrapperType`, and Blob data/JSON/RLP interfaces. |
| `@tvmjs/block` | `blobGasUsed`, `excessBlobGas`, `getBlobGasPrice()`, `calcDataFee()`, `calcNextExcessBlobGas()`, `calcNextBlobGasPrice()`, and `validateBlobTransactions()`. |
| `@tvmjs/blockchain` | Blob validation and parent-header Blob accounting. |
| `@tvmjs/tvm` | BLOBHASH (`0x49`), BLOBBASEFEE (`0x4a`), `blobVersionedHashes` execution/message context, `blobGasUsed` results, `getBlobBaseFee()`, and KZG precompile errors. TRON's multi-sign precompile remains at `0x0a`. |
| `@tvmjs/vm` | Blob fees/results/receipts, `EIP4844BlobTxReceipt`, `BlockBuilder.blobGasUsed`, `addTransaction({ allowNoBlobs })`, and the last two Blob arguments of `generateTxReceipt()` (now four arguments). |
| `@tvmjs/util` | The `blobs` and `kzg` modules: `KZG`, `CELLS_PER_EXT_BLOB`, `getBlob`, `getBlobs`, `computeVersionedHash`, `commitmentsToVersionedHashes`, and all `blobsTo*` helpers. |

Remove Blob options and KZG initialization from ordinary TRON execution calls. Explicitly supplied retired fields, including zero, empty arrays, `null` and `undefined`, now throw instead of being discarded. Transaction type `0x03` is rejected by object, RPC, RLP and block-body entry points; do not relabel a Blob transaction as another transaction type. Existing Legacy (`0x00`), EIP-2930 (`0x01`) and EIP-1559 (`0x02`) type numbers and encodings are unchanged.

Ordinary TRON execution headers keep their existing 16-field RLP order. Old extended headers containing Blob positions are rejected rather than shifted into later Ethereum fields. The Beacon payload data converter remains available for supported fields and rejects both snake-case and camel-case Blob gas fields before conversion.

The dedicated `kzg-wasm`, `micro-eth-signer` and `@paulmillr/trusted-setups` dependencies and their examples have been removed. Rebuild all affected workspaces together. When upgrading an existing checkout, use a clean build so obsolete Blob files from earlier builds are not included in package artifacts.

## Beacon root removal in v1.2.0

EIP-4788 Beacon root support has been physically removed. It remains unavailable on TronMainnet, TronNile and TronShasta; construction, `setEIPs()` and `paramByEIP()` reject EIP-4788.

| Package | Removed APIs and behavior |
| --- | --- |
| `@tvmjs/common` | EIP-4788 metadata entry. |
| `@tvmjs/block` | `BlockHeader.parentBeaconBlockRoot` and the corresponding HeaderData, JSONHeader, JSONRPCBlock, ExecutionPayload and BeaconPayloadJSON fields; header serialization and input/output mappings. |
| `@tvmjs/tvm` | EIP-4788 support declaration; caller-supplied block contexts containing Beacon root fields are rejected before execution. |
| `@tvmjs/vm` | Beacon root initialization and ring-buffer writes in `runBlock()` and `buildBlock()`, the internal `accumulateParentBeaconBlockRoot()` helper, and the `historicalRootsLength` parameter. |

Omit `parentBeaconBlockRoot` and `parent_beacon_block_root` when creating ordinary TRON block contexts. Both names are rejected by presence, including explicit `undefined`, `null`, zero and empty values. VM block/transaction entry points and builders validate these fields before events, checkpoints or state-root changes. Ethereum Beacon-era blocks remain unsupported; dropping their fields would change the block identity.

Ordinary TRON headers retain their 16-field RLP order and hashes. The Beacon payload converter remains a data tool for ordinary fields and the retained withdrawals/requests mappings; those Ethereum execution features cannot be activated in the TRON profile. EIP-2935 history handling and other inactive extensions remain outside this removal.

## EIP-7702 removal in v1.2.0

EIP-7702 transactions, authorization signing and code delegation have been physically removed. All three TRON presets continue to reject EIP-7702 activation and parameter queries.

| Package | Removed APIs and behavior |
| --- | --- |
| `@tvmjs/common` | EIP-7702 metadata entry. |
| `@tvmjs/tx` | `EOACode7702Tx`, `createEOACode7702Tx*`, `isEOACode7702Tx*`, `TransactionType.EOACodeEIP7702`, `Capability.EIP7702EOACode`, `EIP7702CompatibleTx`, and authorization transaction data/JSON/RLP types. |
| `@tvmjs/util` | The `authorization` module, `eoaCode7702*` signing/recovery/conversion helpers, `EOA_CODE_7702_AUTHORITY_SIGNING_MAGIC`, and `EOACode7702AuthorizationList*` types and guards. |
| `@tvmjs/block` | Acceptance of type `0x04` or authorization fields in object, RPC, binary and payload transactions, including transactions supplied directly to `new Block()`. |
| `@tvmjs/tvm` | Delegation target lookup, its dedicated access tracking, the EIP-7702 support declaration and `DELEGATION_7702_FLAG`. |
| `@tvmjs/vm` | Authorization processing, authority nonce/code updates, authorization refunds and the delegated-sender exception. |

Type `0x04` is rejected at transaction and block input boundaries. Both `authorizationList` and `authorization_list` are rejected by field presence, including `undefined`, `null` and empty lists on ordinary transactions. `runTx()`, `runBlock()` and `BlockBuilder.addTransaction()` validate supplied transaction objects before events or state changes; a retired transaction later in a block is rejected before the first transaction executes.

For ordinary TRON transactions, remove obsolete authorization options from the application code and use types `0x00`, `0x01` or `0x02`. Their signing payloads, type numbers, chain IDs and TRC-10 validation rules are unchanged. There is no replacement for Ethereum delegation: relabeling a signed `0x04` transaction or dropping its authorization list would change its meaning and signature.

Stored code beginning with `0xef0100` is executed as ordinary bytecode and fails with an invalid opcode; it no longer redirects execution. Transaction senders with any deployed code remain rejected. Ordinary CALL/DELEGATECALL storage contexts, execution refunds and state rollback are preserved. Generic signature and address utilities remain available; their shared crypto dependencies are still required.

Rebuild the affected packages together from clean outputs. Incremental TypeScript builds can leave obsolete `tx/7702`, `tx/capabilities/eip7702` and `util/authorization` files in `dist`; they must not be included in release artifacts. EOF, BAL, history and requests implementations remain subject to the existing TRON capability restrictions and are outside this removal.

## Parameters

Execution packages register their parameter dictionaries with Common. Parameters are merged in the explicit order in `tronExecutionProfile.eips`, followed by the `tron` parameter group and explicitly enabled optional EIPs. Selecting an already active baseline EIP does not override the TRON parameter group.

```ts
import { Common, TronMainnet } from '@tvmjs/common'

const common = new Common({
  chain: TronMainnet,
  params: { tron: { exampleLimit: 64 } },
})
console.log(common.param('exampleLimit')) // 64n
common.updateParams({ tron: { exampleLimit: 128 } })
console.log(common.paramByHardfork('exampleLimit', 'tron')) // 128n
```

`updateParams()` merges dictionaries; `resetParams()` replaces them. `paramByEIP()` uses the same supported EIP set as `setEIPs()`. It can read parameters for a supported optional EIP before activation, and querying does not activate that EIP. Retired EIPs are rejected even if their parameter dictionaries were supplied. `paramByHardfork()` accepts the TRON profile, while `paramByBlock()` uses the same profile for the supplied context. Missing parameters throw.

Execution constructors preserve existing Common parameters when loading defaults. `updateParams(defaults, false)` fills missing values; the default `updateParams(overrides)` behavior still replaces supplied values. Put custom Energy settings in the `tron` parameter group.

## Custom networks and cryptography

```ts
import { TronMainnet, createCustomCommon } from '@tvmjs/common'

const common = createCustomCommon({ name: 'private-tron', chainId: 123 }, TronMainnet)
console.log(common.chainId()) // 123n
```

Custom networks use the TRON profile. Supply parameter overrides, supported explicit capabilities and governance flags through the corresponding options. Custom Ethereum hardfork dictionaries are rejected.

The first argument is a `CustomChainConfig`: only `name`, `chainId`, `comment`, `url`, `bootstrapNodes` and `dnsNetworks` can be overridden. Metadata and profile overrides are excluded from the type; unsupported keys supplied dynamically are also rejected at runtime. Omit forbidden keys entirely, even if their value is `undefined`. The options argument cannot replace the selected chain.

Supply network metadata through a complete configuration instead:

```ts
import { Common, TronMainnet } from '@tvmjs/common'
import type { ChainConfig } from '@tvmjs/common'

const chain: ChainConfig = {
  ...TronMainnet,
  name: 'local-execution-fixture',
  // Example metadata for local simulation, not TRON Mainnet's genesis.
  genesis: { gasLimit: 1000000, difficulty: 0, nonce: '0x0000000000000000', extraData: '0x' },
}
const common = new Common({ chain })
console.log(common.hasGenesis()) // true
```

Explicit custom consensus metadata and implementations remain supported through the complete configuration and Blockchain's `consensusDict`. A configuration type cannot verify the network origin of supplied metadata; callers remain responsible for that data. Customizing the identity of an already complete base preserves its metadata.

The configuration migration affects `@tvmjs/common` and the historical fixture types in `@tvmjs/testdata`. Update Common construction in `@tvmjs/blockchain`, `@tvmjs/tx` and `@tvmjs/vm` consumers and examples, and rebuild dependent packages together. See the [allocation import example](../blockchain/examples/gethGenesis.ts) and [custom TRON transaction example](../tx/examples/custom-chain-tx.ts).

`customCrypto` continues to support alternative hashing and signing primitives. See [the custom crypto example](./examples/customCrypto.ts). `copy()` isolates parameter dictionaries, proposal state, EIP selections and network metadata; crypto function references are preserved and event listeners are not copied.

## VM/TVM configuration consistency

When `common`, `tvmOpts.common` or `tvm.common` are supplied together, VM checks for conflicting network IDs, capabilities, proposals, crypto functions, genesis/consensus metadata and supplied active parameter values. Equivalent configurations are accepted and the VM and TVM share the selected Common instance. Genesis and consensus comparisons ignore object key order; missing metadata conflicts with explicitly supplied metadata.

Parameter defaults are checked again after initialization. `isCompatibleWith()` compares overlapping active parameter values numerically: a missing default or a different inactive EIP parameter does not itself create a conflict. Different optional EIP selections do conflict; once both configurations activate that EIP, its supplied parameter values must also agree.

## Builds and development

ES modules, CommonJS and browser builds are supported. The repository validation environment is Node `20.20.0` and npm `10.8.2`.

```sh
npm run test:node --workspace @tvmjs/common
npm run test:browser --workspace @tvmjs/common
npm run tsc --workspace @tvmjs/common
npm run examples --workspace @tvmjs/common
```

Node and Browser run the same retained Common suite, including configuration rejection and raw data parsing. Browser tests require Playwright's Chromium headless shell (`npx playwright install chromium --only-shell` from the repository root).

The four TypeScript examples cover basic configuration, custom identity, custom cryptography and the three TRON networks. After building the workspaces, run `npx vite` from this package and open `/examples/browser.html` for the browser configuration examples.

## Upstream

This package is derived from EthereumJS Common and retains shared algorithms and parameter dictionaries needed by TVMJS.

## License

[MIT](./LICENSE)
