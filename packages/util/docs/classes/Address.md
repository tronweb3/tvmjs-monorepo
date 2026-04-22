[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / Address

# Class: Address

Defined in: packages/util/src/address.ts:24

Handling and generating Ethereum addresses

## Constructors

### Constructor

> **new Address**(`bytes`): `Address`

Defined in: packages/util/src/address.ts:27

#### Parameters

##### bytes

`Uint8Array`

#### Returns

`Address`

## Properties

### bytes

> `readonly` **bytes**: `Uint8Array`

Defined in: packages/util/src/address.ts:25

## Methods

### equals()

> **equals**(`address`): `boolean`

Defined in: packages/util/src/address.ts:37

Is address equal to another.

#### Parameters

##### address

`Address`

#### Returns

`boolean`

***

### isPrecompileOrSystemAddress()

> **isPrecompileOrSystemAddress**(): `boolean`

Defined in: packages/util/src/address.ts:52

True if address is in the address range defined
by EIP-1352

#### Returns

`boolean`

***

### isZero()

> **isZero**(): `boolean`

Defined in: packages/util/src/address.ts:44

Is address zero.

#### Returns

`boolean`

***

### toBytes()

> **toBytes**(): `Uint8Array`

Defined in: packages/util/src/address.ts:69

Returns a new Uint8Array representation of address.

#### Returns

`Uint8Array`

***

### toString()

> **toString**(): `` `0x${string}` ``

Defined in: packages/util/src/address.ts:62

Returns hex encoding of address.

#### Returns

`` `0x${string}` ``
