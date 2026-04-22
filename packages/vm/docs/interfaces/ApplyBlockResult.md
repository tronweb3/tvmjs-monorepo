[**@tvmjs/vm**](../README.md)

***

[@tvmjs/vm](../README.md) / ApplyBlockResult

# Interface: ApplyBlockResult

Defined in: vm/src/types.ts:323

Result of applyBlock

## Properties

### bloom

> **bloom**: `Bloom`

Defined in: vm/src/types.ts:327

The Bloom filter

***

### gasUsed

> **gasUsed**: `bigint`

Defined in: vm/src/types.ts:331

The gas used after executing the block

***

### preimages?

> `optional` **preimages**: `Map`\<`` `0x${string}` ``, `Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: vm/src/types.ts:347

Preimages mapping of the touched accounts from the block (see reportPreimages option)

***

### receipts

> **receipts**: [`TxReceipt`](../type-aliases/TxReceipt.md)[]

Defined in: vm/src/types.ts:339

Receipts generated for transactions in the block

***

### receiptsRoot

> **receiptsRoot**: `Uint8Array`

Defined in: vm/src/types.ts:335

The receipt root after executing the block

***

### results

> **results**: [`RunTxResult`](RunTxResult.md)[]

Defined in: vm/src/types.ts:343

Results of executing the transactions in the block
