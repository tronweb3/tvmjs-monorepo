[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / CLRequest

# Class: CLRequest\<T\>

Defined in: packages/util/src/request.ts:20

## Type Parameters

### T

`T` *extends* [`CLRequestType`](../type-aliases/CLRequestType.md)

## Constructors

### Constructor

> **new CLRequest**\<`T`\>(`requestType`, `requestData`): `CLRequest`\<`T`\>

Defined in: packages/util/src/request.ts:32

#### Parameters

##### requestType

`T`

##### requestData

`Uint8Array`

#### Returns

`CLRequest`\<`T`\>

## Properties

### bytes

> `readonly` **bytes**: `Uint8Array`

Defined in: packages/util/src/request.ts:22

## Accessors

### data

#### Get Signature

> **get** **data**(): `Uint8Array`\<`ArrayBufferLike`\>

Defined in: packages/util/src/request.ts:28

##### Returns

`Uint8Array`\<`ArrayBufferLike`\>

***

### type

#### Get Signature

> **get** **type**(): `T`

Defined in: packages/util/src/request.ts:24

##### Returns

`T`
