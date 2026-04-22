[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / BlockLevelAccessList

# Class: BlockLevelAccessList

Defined in: packages/util/src/bal.ts:115

Structural helper class for block level access lists

EXPERIMENTAL: DO NOT USE IN PRODUCTION!

## Constructors

### Constructor

> **new BlockLevelAccessList**(`accesses`): `BlockLevelAccessList`

Defined in: packages/util/src/bal.ts:124

#### Parameters

##### accesses

[`Accesses`](../type-aliases/Accesses.md) = `{}`

#### Returns

`BlockLevelAccessList`

## Properties

### accesses

> **accesses**: [`Accesses`](../type-aliases/Accesses.md)

Defined in: packages/util/src/bal.ts:116

***

### blockAccessIndex

> **blockAccessIndex**: `number`

Defined in: packages/util/src/bal.ts:117

## Methods

### addAddress()

> **addAddress**(`address`): `void`

Defined in: packages/util/src/bal.ts:284

#### Parameters

##### address

`` `0x${string}` ``

#### Returns

`void`

***

### addBalanceChange()

> **addBalanceChange**(`address`, `balance`, `blockAccessIndex`, `originalBalance?`): `void`

Defined in: packages/util/src/bal.ts:361

#### Parameters

##### address

`` `0x${string}` ``

##### balance

`bigint`

##### blockAccessIndex

`number`

##### originalBalance?

`bigint`

#### Returns

`void`

***

### addCodeChange()

> **addCodeChange**(`address`, `code`, `blockAccessIndex`, `originalCode?`): `void`

Defined in: packages/util/src/bal.ts:418

#### Parameters

##### address

`` `0x${string}` ``

##### code

`BALByteCodeBytes`

##### blockAccessIndex

`number`

##### originalCode?

`BALByteCodeBytes`

#### Returns

`void`

***

### addNonceChange()

> **addNonceChange**(`address`, `nonce`, `blockAccessIndex`): `void`

Defined in: packages/util/src/bal.ts:407

#### Parameters

##### address

`` `0x${string}` ``

##### nonce

`bigint`

##### blockAccessIndex

`number`

#### Returns

`void`

***

### addStorageRead()

> **addStorageRead**(`address`, `storageKey`): `void`

Defined in: packages/util/src/bal.ts:349

#### Parameters

##### address

`` `0x${string}` ``

##### storageKey

`BALStorageKeyBytes`

#### Returns

`void`

***

### addStorageWrite()

> **addStorageWrite**(`address`, `storageKey`, `value`, `blockAccessIndex`, `originalValue?`): `void`

Defined in: packages/util/src/bal.ts:297

#### Parameters

##### address

`` `0x${string}` ``

##### storageKey

`BALStorageKeyBytes`

##### value

`BALStorageValueBytes`

##### blockAccessIndex

`number`

##### originalValue?

`BALStorageValueBytes`

#### Returns

`void`

***

### checkpoint()

> **checkpoint**(): `void`

Defined in: packages/util/src/bal.ts:147

#### Returns

`void`

***

### cleanupNetZeroBalanceChanges()

> **cleanupNetZeroBalanceChanges**(): `void`

Defined in: packages/util/src/bal.ts:385

EIP-7928: Remove balance changes for addresses where final balance equals first balance.
Call this at the end of each transaction to clean up net-zero balance changes.

#### Returns

`void`

***

### cleanupSelfdestructed()

> **cleanupSelfdestructed**(`addresses`): `void`

Defined in: packages/util/src/bal.ts:532

#### Parameters

##### addresses

`` `0x${string}` ``[]

#### Returns

`void`

***

### commit()

> **commit**(): `void`

Defined in: packages/util/src/bal.ts:154

#### Returns

`void`

***

### hash()

> **hash**(): `Uint8Array`

Defined in: packages/util/src/bal.ts:143

This hash is used in the block header

#### Returns

`Uint8Array`

the hash of the serialized block level access list

***

### raw()

> **raw**(): `BALRawBlockAccessList`

Defined in: packages/util/src/bal.ts:231

Returns the raw block level access list with values
correctly sorted.

#### Returns

`BALRawBlockAccessList`

the raw block level access list

***

### revert()

> **revert**(): `void`

Defined in: packages/util/src/bal.ts:160

#### Returns

`void`

***

### serialize()

> **serialize**(): `Uint8Array`

Defined in: packages/util/src/bal.ts:134

Serializes the block level access list to RLP.

#### Returns

`Uint8Array`

the RLP encoded block level access list

***

### toJSON()

> **toJSON**(): [`BALJSONBlockAccessList`](../type-aliases/BALJSONBlockAccessList.md)

Defined in: packages/util/src/bal.ts:473

Converts the internal representation to the JSON format (BALJSONBlockAccessList).
Inverse of createBlockLevelAccessListFromJSON().

#### Returns

[`BALJSONBlockAccessList`](../type-aliases/BALJSONBlockAccessList.md)
