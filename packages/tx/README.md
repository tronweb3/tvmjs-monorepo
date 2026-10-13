# @tvmjs/tx `1.2.0`

EIP-3860 initcode limits and word metering are removed. Omit `TxOptions.allowUnlimitedInitCodeSize`; this key now throws even with `false` or `undefined`. `paramsTx[3860]` is removed. Ordinary data byte fees, creation overhead, signing and serialization remain unchanged. See [contract size migration](../common/README.md#contract-size-configuration-in-v120).

Blob transactions, their public constructors/types and network wrappers have been removed in v1.2.0. Type `0x03` and retired Blob fields are rejected, including zero or empty values. Legacy, EIP-2930 and EIP-1559 encodings keep their original type numbers. See [Blob migration and affected packages](../common/README.md#blob-removal-in-v120).

EIP-7702 transaction classes, constructors, types and guards are also removed. Type `0x04`, `authorizationList` and `authorization_list` are rejected at input boundaries, including explicitly empty fields. Ordinary transaction signing is unchanged. See [EIP-7702 migration](../common/README.md#eip-7702-removal-in-v120).

| Implements schema and functions for TRON-compatible transaction types (including TRC-10 token transfers). Part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, forked from [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo). |
| --- |

- 🦄 Legacy, EIP-2930 and EIP-1559 transaction encoding for TRON execution
- 🌴 Tree-shakeable API
- 👷🏼 Controlled dependency set (1 external + `@Noble` crypto)
- 🎼 Unified tx type API
- 🏄🏾‍♂️ WASM-free default + Fully browser ready

## Table of Contents

- [Installation](#installation)
- [Getting Started](#getting-started)
- [Chain and Hardfork Support](#chain-and-hardfork-support)
- [Transaction Types](#transaction-types)
  - [Gas Fee Market Transactions (EIP-1559)](#gas-fee-market-transactions-eip-1559)
  - [Access List Transactions (EIP-2930)](#access-list-transactions-eip-2930)
  - [Legacy Transactions](#legacy-transactions)
- [Transaction Factory](#transaction-factory)
- [Custom TRON execution transactions](#custom-tron-execution-transactions)
- [Browser](#browser)
- [External signing](#external-signing)
- [API](#api)
- [Development](#development)
- [Upstream](#upstream)
- [License](#license)

## Installation

To obtain the latest version, simply require the project using `npm`:

```shell
npm install @tvmjs/tx
```

## Getting Started

### Transaction constructors

Use the exported factory functions for the desired format:

| Input | Legacy | Access list | Fee market |
| --- | --- | --- | --- |
| Object | `createLegacyTx` | `createAccessList2930Tx` | `createFeeMarket1559Tx` |
| RLP bytes | `createLegacyTxFromRLP` | `createAccessList2930TxFromRLP` | `createFeeMarket1559TxFromRLP` |
| Values array | `createLegacyTxFromBytesArray` | `createAccessList2930TxFromBytesArray` | `create1559FeeMarketTxFromBytesArray` |

See one of the code examples on the tx types below on how to use.

All types of transaction objects are frozen with `Object.freeze()` which gives you enhanced security and consistency properties when working with the instantiated object. This behavior can be modified using the `freeze` option in the constructor if needed.

### WASM Crypto Support

This library by default uses JavaScript implementations for the basic standard crypto primitives like hashing or signature verification. See `@tvmjs/common` [README](https://github.com/tronweb3/tvmjs-monorepo/tree/master/packages/common) for instructions on how to replace with e.g. a more performant WASM implementation by using a shared `common` instance.

## Chain and Hardfork Support

Transactions default to `TronMainnet`. Supply a `Common` configured with `TronNile` or `TronShasta` for the other supported networks. The `tron` execution profile controls capabilities; Ethereum presets and hardfork schedules cannot be selected. See [TRON configuration](../common/README.md#tron-networks).

Legacy, EIP-2930 and EIP-1559 envelopes retain their existing type numbers and signing rules. Blob (`0x03`) and EIP-7702 (`0x04`) transactions are unsupported.

## Transaction Types

### Table of Contents

This library supports the following transaction types ([EIP-2718](https://eips.ethereum.org/EIPS/eip-2718)):

- [Gas Fee Market Transactions (EIP-1559)](#gas-fee-market-transactions-eip-1559)
- [Access List Transactions (EIP-2930)](#access-list-transactions-eip-2930)
- [Legacy Transactions](#legacy-transactions) (including TRC-10 fields)

### Gas Fee Market Transactions (EIP-1559)

- Class: `FeeMarket1559Tx`
- EIP: [EIP-1559](https://eips.ethereum.org/EIPS/eip-1559)
- Availability: TRON execution profile
- Type: `2`

This fee-market container is retained for local TRON execution. It does not model native TRON resource accounting or node transaction encoding:

```ts
// ./examples/londonTx.ts

import { Common, TronMainnet } from '@tvmjs/common'
import type { FeeMarketEIP1559TxData } from '@tvmjs/tx'
import { createFeeMarket1559Tx } from '@tvmjs/tx'
import { bytesToHex, hexToBytes } from '@tvmjs/util'

const common = new Common({ chain: TronMainnet })

const txData: FeeMarketEIP1559TxData = {
  data: '0x1a8451e600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  gasLimit: '0x02625a00',
  maxPriorityFeePerGas: '0x01',
  maxFeePerGas: '0xff',
  nonce: '0x00',
  to: '0xcccccccccccccccccccccccccccccccccccccccc',
  value: '0x0186a0',
  chainId: common.chainId(),
  accessList: [],
  type: '0x02',
}

const tx = createFeeMarket1559Tx(txData, { common })
// Demonstration key only. This is a local execution envelope, not a node broadcast.
const privateKey = hexToBytes(`0x${'46'.repeat(32)}`)
const signedTx = tx.sign(privateKey)
console.log(bytesToHex(signedTx.hash()))
```

### Access List Transactions (EIP-2930)

- Class: `AccessList2930Tx`
- EIP: [EIP-2930](https://eips.ethereum.org/EIPS/eip-2930)
- Availability: TRON execution profile
- Type: `1`

Access lists remain part of the signed transaction payload. Their entries do not add TRON intrinsic gas or enable warm/cold access pricing:

```ts
// ./examples/accessListTx.ts

import { Common, TronMainnet } from '@tvmjs/common'
import type { AccessList2930TxData } from '@tvmjs/tx'
import { createAccessList2930Tx } from '@tvmjs/tx'
import { bytesToHex, hexToBytes } from '@tvmjs/util'

const common = new Common({ chain: TronMainnet })

const txData: AccessList2930TxData = {
  data: '0x1a8451e600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  gasLimit: '0x02625a00',
  gasPrice: '0x01',
  nonce: '0x00',
  to: '0xcccccccccccccccccccccccccccccccccccccccc',
  value: '0x0186a0',
  chainId: common.chainId(),
  accessList: [
    {
      address: '0x0000000000000000000000000000000000000101',
      storageKeys: [
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        '0x00000000000000000000000000000000000000000000000000000000000060a7',
      ],
    },
  ],
  type: '0x01',
}

const tx = createAccessList2930Tx(txData, { common })
// Demonstration key only. Access-list entries do not add TRON access charges.
const privateKey = hexToBytes(`0x${'46'.repeat(32)}`)
const signedTx = tx.sign(privateKey)
console.log(bytesToHex(signedTx.hash()))
```

Access-list entries remain serializable metadata. Use the legacy format for transaction-level TRC-10 transfers; typed envelopes reject nonzero `tokenId` or `tokenValue` because their signing payloads do not include those fields.

### Legacy Transactions

- Class: `LegacyTx`
- Availability: TRON execution profile
- Type: `0` (internal)

Legacy envelopes include `tokenId` and `tokenValue` in their signing payloads and eleven-field RLP encoding. `toJSON()` emits these values as hex quantities, preserving IDs above Number precision when reconstructing a transaction with the same Common. See this [example script](./examples/transactions.ts) or the following example.

```ts
// ./examples/legacyTx.ts

import { Common, TronMainnet } from '@tvmjs/common'
import type { LegacyTxData } from '@tvmjs/tx'
import { createLegacyTx } from '@tvmjs/tx'
import { bytesToHex, hexToBytes } from '@tvmjs/util'

const txData: LegacyTxData = {
  nonce: '0x0',
  gasPrice: '0x09184e72a000',
  gasLimit: '0xc350',
  to: '0x0000000000000000000000000000000000000000',
  value: '0x00',
  data: '0x7f7465737432000000000000000000000000000000000000000000000000000000600057',
}

const common = new Common({ chain: TronMainnet })
const tx = createLegacyTx(txData, { common })

// WARNING: The private key in this example is for demonstration only. Never use in production.
const privateKey = hexToBytes('0xe331b6d69882b4cb4ea581d88e0b604039a3de5967688d3dcffdd2270c0fd109')

const signedTx = tx.sign(privateKey)

const _serializedTx = signedTx.serialize()
console.log(bytesToHex(signedTx.hash()))
```

## Transaction Factory

Use `createTx()` when the transaction type is selected at runtime:

```ts
// ./examples/txFactory.ts

import { Common, TronMainnet } from '@tvmjs/common'
import { Capability, createTx } from '@tvmjs/tx'

import type { EIP1559CompatibleTx } from '@tvmjs/tx'

const common = new Common({ chain: TronMainnet })

const txData = { type: 2, maxFeePerGas: BigInt(20) } // Creates an EIP-1559 compatible transaction
const tx = createTx(txData, { common })

if (tx.supports(Capability.EIP1559FeeMarket)) {
  console.log(
    `The max fee per gas for this transaction is ${(tx as EIP1559CompatibleTx).maxFeePerGas}`,
  )
}
```

The correct tx type class for instantiation will then be chosen at runtime based on the data provided as an input.

The package exports these generic constructors:

- `createTx(txData, txOptions)` for transaction objects.
- `createTxFromRLP(data, txOptions)` for serialized bytes.
- `createTxFromBlockBodyData(data, txOptions)` for block-body entries.
- `createTxFromRPC(txData, txOptions)` and `createTxFromJSONRPCProvider(provider, txHash, txOptions)` for compatible JSON-RPC envelopes.

## Custom TRON execution transactions

Use `createCustomCommon({ name, chainId }, TronMainnet)` to create a local TRON execution configuration. The TRON profile is preserved; Ethereum network presets and L2 execution configuration are no longer supported. The retired xDai example has been removed.

See [the custom TRON transaction example](./examples/custom-chain-tx.ts) for signing and sender verification. These transaction objects are local execution envelopes; this example does not submit a transaction to a TRON node.

`createCustomCommon()` accepts identity and discovery overrides only. Supply genesis or consensus metadata through a complete `ChainConfig` passed to `new Common({ chain })`; see [Common configuration migration](../common/README.md#custom-networks-and-cryptography).

## Browser

We provide hybrid ESM/CJS builds for all our libraries. With the v10 breaking release round from Spring 2025, all libraries are "pure-JS" by default and we have eliminated all hard-wired WASM code. Additionally we have substantially lowered the bundle sizes, reduced the number of dependencies, and cut out all usages of Node.js-specific primitives (like the Node.js event emitter).

It is easily possible to run a browser build of one of the TVMJS libraries within a modern browser using the provided ESM build. For a setup example see [./examples/browser.html](./examples/browser.html).

## External signing

Use `getMessageToSign()` to obtain the signing payload and `addSignature()` to attach an external signature. Legacy transactions return an array of bytes that must be RLP encoded; typed transactions return serialized bytes. The legacy payload includes `tokenId` and `tokenValue`, and the selected TRON chain ID participates in replay protection.

The former Ethereum Ledger example has been retired. Hardware-wallet support for these local execution envelopes has not been validated. Native TRON transaction signing and broadcasting require java-tron transaction encoding and are outside this package's examples.

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

## Development

From the repository root, run:

```shell
npm run build --workspace @tvmjs/tx
npm run tsc --workspace @tvmjs/tx
npm run test --workspace @tvmjs/tx
npm run lint --workspace @tvmjs/tx
npm run spellcheck --workspace @tvmjs/tx
npm run examples --workspace @tvmjs/tx
```

`test` runs the complete retained Node and Chromium Browser suites. `test:node:api` remains available for Node-only runs; the obsolete `test:node:tx:*` FORKS scripts have been removed.

| v1.2.0 test migration | Coverage |
| --- | --- |
| Migrated | Legacy, EIP-2930 and EIP-1559 encoding, signing, RPC normalization, input validation and Common copying. Bundled signature vectors retain their original chain IDs through explicit TRON custom identities. |
| Retired | Ethereum fork-matrix/T9N runners and the Ethereum Ledger example. Ledger compatibility with TRON signing was not verified. The official Ethereum transaction-vector runner was not executed; bundled vectors are a separate local regression suite. |
| Replaced | Ethereum hardfork switching, warm/cold access-list pricing and EIP-7825 activation assumptions become TRON rejection/isolation tests, zero access-list charges and uint64 bounds. All three TRON networks cover signature replay rejection and large TRC-10 ID serialization. |

These package tests validate local transaction envelopes. They do not represent new live java-tron differential results or native TRON transaction broadcasting.

## Upstream

This package is part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, a TypeScript implementation of the TRON Virtual Machine (TVM) forked from the [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo) monorepo. We gratefully acknowledge the EthereumJS team for building and maintaining the original implementation.

For development information, see the [developer docs](../../DEVELOPER.md) and our [code of conduct](../../CODE_OF_CONDUCT.md).
## License

[MPL-2.0](<https://tldrlegal.com/license/mozilla-public-license-2.0-(mpl-2)>)

This package is derived from the original [@ethereumjs](https://github.com/ethereumjs/ethereumjs-monorepo) implementation, licensed under MPL-2.0. All original source files retain their MPL-2.0 license.
