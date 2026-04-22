[**@tvmjs/vm**](../README.md)

***

[@tvmjs/vm](../README.md) / RunBlockResult

# Interface: RunBlockResult

Defined in: vm/src/types.ts:353

Result of [runBlock](../functions/runBlock.md)

## Extends

- `Omit`\<[`ApplyBlockResult`](ApplyBlockResult.md), `"bloom"`\>

## Extended by

- [`AfterBlockEvent`](AfterBlockEvent.md)

## Properties

### blockLevelAccessList?

> `optional` **blockLevelAccessList**: `BlockLevelAccessList`

Defined in: vm/src/types.ts:375

The block level access list created during execution
(if EIP-7928 is active)

***

### gasUsed

> **gasUsed**: `bigint`

Defined in: vm/src/types.ts:331

The gas used after executing the block

#### Inherited from

[`ApplyBlockResult`](ApplyBlockResult.md).[`gasUsed`](ApplyBlockResult.md#gasused)

***

### logsBloom

> **logsBloom**: `Uint8Array`

Defined in: vm/src/types.ts:361

The bloom filter of the LOGs (events) after executing the block

***

### preimages?

> `optional` **preimages**: `Map`\<`` `0x${string}` ``, `Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: vm/src/types.ts:347

Preimages mapping of the touched accounts from the block (see reportPreimages option)

#### Inherited from

[`ApplyBlockResult`](ApplyBlockResult.md).[`preimages`](ApplyBlockResult.md#preimages)

***

### receipts

> **receipts**: [`TxReceipt`](../type-aliases/TxReceipt.md)[]

Defined in: vm/src/types.ts:339

Receipts generated for transactions in the block

#### Inherited from

[`ApplyBlockResult`](ApplyBlockResult.md).[`receipts`](ApplyBlockResult.md#receipts)

***

### receiptsRoot

> **receiptsRoot**: `Uint8Array`

Defined in: vm/src/types.ts:335

The receipt root after executing the block

#### Inherited from

[`ApplyBlockResult`](ApplyBlockResult.md).[`receiptsRoot`](ApplyBlockResult.md#receiptsroot)

***

### requests?

> `optional` **requests**: `CLRequest`\<`CLRequestType`\>[]

Defined in: vm/src/types.ts:370

Any CL requests that were processed in the course of this block

***

### requestsHash?

> `optional` **requestsHash**: `Uint8Array`\<`ArrayBufferLike`\>

Defined in: vm/src/types.ts:366

The requestsHash for any CL requests in the block

***

### results

> **results**: [`RunTxResult`](RunTxResult.md)[]

Defined in: vm/src/types.ts:343

Results of executing the transactions in the block

#### Inherited from

[`ApplyBlockResult`](ApplyBlockResult.md).[`results`](ApplyBlockResult.md#results)

***

### stateRoot

> **stateRoot**: `Uint8Array`

Defined in: vm/src/types.ts:357

The stateRoot after executing the block
