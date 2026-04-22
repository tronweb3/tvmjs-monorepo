[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / Units

# Class: Units

Defined in: packages/util/src/units.ts:25

## Constructors

### Constructor

> **new Units**(): `Units`

#### Returns

`Units`

## Methods

### ether()

> `static` **ether**(`amount`): `bigint`

Defined in: packages/util/src/units.ts:41

Convert a number or bigint input of ether to wei

#### Parameters

##### amount

amount of units of ether to convert to wei

`number` | `bigint`

#### Returns

`bigint`

amount of units in wei

***

### gwei()

> `static` **gwei**(`amount`): `bigint`

Defined in: packages/util/src/units.ts:52

Convert a number or bigint input of gwei to wei

#### Parameters

##### amount

amount of units of gwei to convert to wei

`number` | `bigint`

#### Returns

`bigint`

amount of units in wei

***

### validateInput()

> `static` **validateInput**(`amount`): `void`

Defined in: packages/util/src/units.ts:26

#### Parameters

##### amount

`number` | `bigint`

#### Returns

`void`
