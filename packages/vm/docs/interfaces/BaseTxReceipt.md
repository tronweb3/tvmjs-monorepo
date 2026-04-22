[**@tvmjs/vm**](../README.md)

***

[@tvmjs/vm](../README.md) / BaseTxReceipt

# Interface: BaseTxReceipt

Defined in: vm/src/types.ts:19

Abstract interface with common transaction receipt fields

## Extended by

- [`PreByzantiumTxReceipt`](PreByzantiumTxReceipt.md)
- [`PostByzantiumTxReceipt`](PostByzantiumTxReceipt.md)

## Properties

### bitvector

> **bitvector**: `Uint8Array`

Defined in: vm/src/types.ts:27

Bloom bitvector

***

### cumulativeBlockGasUsed

> **cumulativeBlockGasUsed**: `bigint`

Defined in: vm/src/types.ts:23

Cumulative gas used in the block including this tx

***

### logs

> **logs**: `Log`[]

Defined in: vm/src/types.ts:31

Logs emitted
