[**@tvmjs/common**](../README.md)

***

[@tvmjs/common](../README.md) / BinaryTreeAccessWitnessInterface

# Interface: BinaryTreeAccessWitnessInterface

Defined in: src/interfaces.ts:98

## Methods

### accesses()

> **accesses**(): `Generator`\<[`BinaryTreeAccessedStateWithAddress`](../type-aliases/BinaryTreeAccessedStateWithAddress.md)\>

Defined in: src/interfaces.ts:99

#### Returns

`Generator`\<[`BinaryTreeAccessedStateWithAddress`](../type-aliases/BinaryTreeAccessedStateWithAddress.md)\>

***

### commit()

> **commit**(): `void`

Defined in: src/interfaces.ts:113

#### Returns

`void`

***

### debugWitnessCost()

> **debugWitnessCost**(): `void`

Defined in: src/interfaces.ts:101

#### Returns

`void`

***

### merge()

> **merge**(`accessWitness`): `void`

Defined in: src/interfaces.ts:112

#### Parameters

##### accessWitness

`BinaryTreeAccessWitnessInterface`

#### Returns

`void`

***

### rawAccesses()

> **rawAccesses**(): `Generator`\<[`RawBinaryTreeAccessedState`](../type-aliases/RawBinaryTreeAccessedState.md)\>

Defined in: src/interfaces.ts:100

#### Returns

`Generator`\<[`RawBinaryTreeAccessedState`](../type-aliases/RawBinaryTreeAccessedState.md)\>

***

### readAccountBasicData()

> **readAccountBasicData**(`address`): `bigint`

Defined in: src/interfaces.ts:102

#### Parameters

##### address

`Address`

#### Returns

`bigint`

***

### readAccountCodeChunks()

> **readAccountCodeChunks**(`contract`, `startPc`, `endPc`): `bigint`

Defined in: src/interfaces.ts:108

#### Parameters

##### contract

`Address`

##### startPc

`number`

##### endPc

`number`

#### Returns

`bigint`

***

### readAccountCodeHash()

> **readAccountCodeHash**(`address`): `bigint`

Defined in: src/interfaces.ts:104

#### Parameters

##### address

`Address`

#### Returns

`bigint`

***

### readAccountHeader()

> **readAccountHeader**(`address`): `bigint`

Defined in: src/interfaces.ts:106

#### Parameters

##### address

`Address`

#### Returns

`bigint`

***

### readAccountStorage()

> **readAccountStorage**(`contract`, `storageSlot`): `bigint`

Defined in: src/interfaces.ts:110

#### Parameters

##### contract

`Address`

##### storageSlot

`bigint`

#### Returns

`bigint`

***

### revert()

> **revert**(): `void`

Defined in: src/interfaces.ts:114

#### Returns

`void`

***

### writeAccountBasicData()

> **writeAccountBasicData**(`address`): `bigint`

Defined in: src/interfaces.ts:103

#### Parameters

##### address

`Address`

#### Returns

`bigint`

***

### writeAccountCodeChunks()

> **writeAccountCodeChunks**(`contract`, `startPc`, `endPc`): `bigint`

Defined in: src/interfaces.ts:109

#### Parameters

##### contract

`Address`

##### startPc

`number`

##### endPc

`number`

#### Returns

`bigint`

***

### writeAccountCodeHash()

> **writeAccountCodeHash**(`address`): `bigint`

Defined in: src/interfaces.ts:105

#### Parameters

##### address

`Address`

#### Returns

`bigint`

***

### writeAccountHeader()

> **writeAccountHeader**(`address`): `bigint`

Defined in: src/interfaces.ts:107

#### Parameters

##### address

`Address`

#### Returns

`bigint`

***

### writeAccountStorage()

> **writeAccountStorage**(`contract`, `storageSlot`): `bigint`

Defined in: src/interfaces.ts:111

#### Parameters

##### contract

`Address`

##### storageSlot

`bigint`

#### Returns

`bigint`
