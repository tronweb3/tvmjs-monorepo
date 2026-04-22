[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / PutBatch

# Interface: PutBatch\<TKey, TValue\>

Defined in: packages/util/src/db.ts:29

## Type Parameters

### TKey

`TKey` *extends* `Uint8Array` \| `string` \| `number` = `Uint8Array`

### TValue

`TValue` *extends* `Uint8Array` \| `string` \| [`DBObject`](../type-aliases/DBObject.md) = `Uint8Array`

## Properties

### key

> **key**: `TKey`

Defined in: packages/util/src/db.ts:34

***

### opts?

> `optional` **opts**: [`EncodingOpts`](../type-aliases/EncodingOpts.md)

Defined in: packages/util/src/db.ts:36

***

### type

> **type**: `"put"`

Defined in: packages/util/src/db.ts:33

***

### value

> **value**: `TValue`

Defined in: packages/util/src/db.ts:35
