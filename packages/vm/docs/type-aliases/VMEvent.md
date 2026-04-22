[**@tvmjs/vm**](../README.md)

***

[@tvmjs/vm](../README.md) / VMEvent

# Type Alias: VMEvent

> **VMEvent** = `object`

Defined in: vm/src/types.ts:78

## Properties

### afterBlock()

> **afterBlock**: (`data`, `resolve?`) => `void`

Defined in: vm/src/types.ts:80

#### Parameters

##### data

[`AfterBlockEvent`](../interfaces/AfterBlockEvent.md)

##### resolve?

(`result?`) => `void`

#### Returns

`void`

***

### afterTx()

> **afterTx**: (`data`, `resolve?`) => `void`

Defined in: vm/src/types.ts:82

#### Parameters

##### data

[`AfterTxEvent`](../interfaces/AfterTxEvent.md)

##### resolve?

(`result?`) => `void`

#### Returns

`void`

***

### beforeBlock()

> **beforeBlock**: (`data`, `resolve?`) => `void`

Defined in: vm/src/types.ts:79

#### Parameters

##### data

`Block`

##### resolve?

(`result?`) => `void`

#### Returns

`void`

***

### beforeTx()

> **beforeTx**: (`data`, `resolve?`) => `void`

Defined in: vm/src/types.ts:81

#### Parameters

##### data

`TypedTransaction`

##### resolve?

(`result?`) => `void`

#### Returns

`void`
