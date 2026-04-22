[**@tvmjs/vm**](../README.md)

***

[@tvmjs/vm](../README.md) / AfterTxEvent

# Interface: AfterTxEvent

Defined in: vm/src/types.ts:500

Execution result of a transaction

## Extends

- [`RunTxResult`](RunTxResult.md)

## Properties

### accessList?

> `optional` **accessList**: `AccessList`

Defined in: vm/src/types.ts:482

EIP-2930 access list generated for the tx (see `reportAccessList` option)

#### Inherited from

[`RunTxResult`](RunTxResult.md).[`accessList`](RunTxResult.md#accesslist)

***

### amountSpent

> **amountSpent**: `bigint`

Defined in: vm/src/types.ts:454

The amount of ether used by this transaction

#### Inherited from

[`RunTxResult`](RunTxResult.md).[`amountSpent`](RunTxResult.md#amountspent)

***

### blobGasUsed?

> `optional` **blobGasUsed**: `bigint`

Defined in: vm/src/types.ts:497

This is the blob gas units times the fee per blob gas for 4844 transactions

#### Inherited from

[`RunTxResult`](RunTxResult.md).[`blobGasUsed`](RunTxResult.md#blobgasused)

***

### blockGasSpent

> **blockGasSpent**: `bigint`

Defined in: vm/src/types.ts:472

The amount of gas accounted for at block level.
On EIP-7778 this excludes tx-level refund subtraction.

#### Inherited from

[`RunTxResult`](RunTxResult.md).[`blockGasSpent`](RunTxResult.md#blockgasspent)

***

### bloom

> **bloom**: `Bloom`

Defined in: vm/src/types.ts:449

Bloom filter resulted from transaction

#### Inherited from

[`RunTxResult`](RunTxResult.md).[`bloom`](RunTxResult.md#bloom)

***

### createdAddress?

> `optional` **createdAddress**: `Address`

Defined in: evm/dist/esm/types.d.ts:341

Address of created account during transaction, if any

#### Inherited from

[`RunTxResult`](RunTxResult.md).[`createdAddress`](RunTxResult.md#createdaddress)

***

### execResult

> **execResult**: `ExecResult`

Defined in: evm/dist/esm/types.d.ts:345

Contains the results from running the code, if any, as described in runCode

#### Inherited from

[`RunTxResult`](RunTxResult.md).[`execResult`](RunTxResult.md#execresult)

***

### gasRefund

> **gasRefund**: `bigint`

Defined in: vm/src/types.ts:477

The amount of gas as that was refunded during the transaction (i.e. `gasUsed = totalGasConsumed - gasRefund`)

#### Inherited from

[`RunTxResult`](RunTxResult.md).[`gasRefund`](RunTxResult.md#gasrefund)

***

### minerValue

> **minerValue**: `bigint`

Defined in: vm/src/types.ts:492

The value that accrues to the miner by this transaction

#### Inherited from

[`RunTxResult`](RunTxResult.md).[`minerValue`](RunTxResult.md#minervalue)

***

### preimages?

> `optional` **preimages**: `Map`\<`` `0x${string}` ``, `Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: vm/src/types.ts:487

Preimages mapping of the touched accounts from the tx (see `reportPreimages` option)

#### Inherited from

[`RunTxResult`](RunTxResult.md).[`preimages`](RunTxResult.md#preimages)

***

### receipt

> **receipt**: [`TxReceipt`](../type-aliases/TxReceipt.md)

Defined in: vm/src/types.ts:459

The tx receipt

#### Inherited from

[`RunTxResult`](RunTxResult.md).[`receipt`](RunTxResult.md#receipt)

***

### totalGasSpent

> **totalGasSpent**: `bigint`

Defined in: vm/src/types.ts:466

The amount of gas used in this transaction, which is paid for
This contains the gas units that have been used on execution, plus the upfront cost,
which consists of calldata cost, intrinsic cost and optionally the access list costs

#### Inherited from

[`RunTxResult`](RunTxResult.md).[`totalGasSpent`](RunTxResult.md#totalgasspent)

***

### transaction

> **transaction**: `TypedTransaction`

Defined in: vm/src/types.ts:504

The transaction which just got finished
