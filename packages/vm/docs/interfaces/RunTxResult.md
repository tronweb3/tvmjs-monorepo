[**@tvmjs/vm**](../README.md)

***

[@tvmjs/vm](../README.md) / RunTxResult

# Interface: RunTxResult

Defined in: vm/src/types.ts:445

Execution result of a transaction

## Extends

- `EVMResult`

## Extended by

- [`AfterTxEvent`](AfterTxEvent.md)

## Properties

### accessList?

> `optional` **accessList**: `AccessList`

Defined in: vm/src/types.ts:482

EIP-2930 access list generated for the tx (see `reportAccessList` option)

***

### amountSpent

> **amountSpent**: `bigint`

Defined in: vm/src/types.ts:454

The amount of ether used by this transaction

***

### blobGasUsed?

> `optional` **blobGasUsed**: `bigint`

Defined in: vm/src/types.ts:497

This is the blob gas units times the fee per blob gas for 4844 transactions

***

### blockGasSpent

> **blockGasSpent**: `bigint`

Defined in: vm/src/types.ts:472

The amount of gas accounted for at block level.
On EIP-7778 this excludes tx-level refund subtraction.

***

### bloom

> **bloom**: `Bloom`

Defined in: vm/src/types.ts:449

Bloom filter resulted from transaction

***

### createdAddress?

> `optional` **createdAddress**: `Address`

Defined in: evm/dist/esm/types.d.ts:341

Address of created account during transaction, if any

#### Inherited from

`EVMResult.createdAddress`

***

### execResult

> **execResult**: `ExecResult`

Defined in: evm/dist/esm/types.d.ts:345

Contains the results from running the code, if any, as described in runCode

#### Inherited from

`EVMResult.execResult`

***

### gasRefund

> **gasRefund**: `bigint`

Defined in: vm/src/types.ts:477

The amount of gas as that was refunded during the transaction (i.e. `gasUsed = totalGasConsumed - gasRefund`)

***

### minerValue

> **minerValue**: `bigint`

Defined in: vm/src/types.ts:492

The value that accrues to the miner by this transaction

***

### preimages?

> `optional` **preimages**: `Map`\<`` `0x${string}` ``, `Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: vm/src/types.ts:487

Preimages mapping of the touched accounts from the tx (see `reportPreimages` option)

***

### receipt

> **receipt**: [`TxReceipt`](../type-aliases/TxReceipt.md)

Defined in: vm/src/types.ts:459

The tx receipt

***

### totalGasSpent

> **totalGasSpent**: `bigint`

Defined in: vm/src/types.ts:466

The amount of gas used in this transaction, which is paid for
This contains the gas units that have been used on execution, plus the upfront cost,
which consists of calldata cost, intrinsic cost and optionally the access list costs
