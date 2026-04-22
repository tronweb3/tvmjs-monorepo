[**@tvmjs/common**](../README.md)

***

[@tvmjs/common](../README.md) / StateManagerInterface

# Interface: StateManagerInterface

Defined in: src/interfaces.ts:121

## Properties

### originalStorageCache

> **originalStorageCache**: `object`

Defined in: src/interfaces.ts:171

#### clear()

> **clear**(): `void`

##### Returns

`void`

#### get()

> **get**(`address`, `key`): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

##### Parameters

###### address

`Address`

###### key

`Uint8Array`

##### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

## Methods

### checkChunkWitnessPresent()?

> `optional` **checkChunkWitnessPresent**(`contract`, `programCounter`): `Promise`\<`boolean`\>

Defined in: src/interfaces.ts:181

#### Parameters

##### contract

`Address`

##### programCounter

`number`

#### Returns

`Promise`\<`boolean`\>

***

### checkpoint()

> **checkpoint**(): `Promise`\<`void`\>

Defined in: src/interfaces.ts:147

#### Returns

`Promise`\<`void`\>

***

### clearCaches()

> **clearCaches**(): `void`

Defined in: src/interfaces.ts:187

#### Returns

`void`

***

### clearStorage()

> **clearStorage**(`address`): `Promise`\<`void`\>

Defined in: src/interfaces.ts:139

#### Parameters

##### address

`Address`

#### Returns

`Promise`\<`void`\>

***

### commit()

> **commit**(): `Promise`\<`void`\>

Defined in: src/interfaces.ts:148

#### Returns

`Promise`\<`void`\>

***

### deleteAccount()

> **deleteAccount**(`address`): `Promise`\<`void`\>

Defined in: src/interfaces.ts:128

#### Parameters

##### address

`Address`

#### Returns

`Promise`\<`void`\>

***

### dumpStorage()?

> `optional` **dumpStorage**(`address`): `Promise`\<[`StorageDump`](StorageDump.md)\>

Defined in: src/interfaces.ts:165

#### Parameters

##### address

`Address`

#### Returns

`Promise`\<[`StorageDump`](StorageDump.md)\>

***

### dumpStorageRange()?

> `optional` **dumpStorageRange**(`address`, `startKey`, `limit`): `Promise`\<[`StorageRange`](StorageRange.md)\>

Defined in: src/interfaces.ts:166

#### Parameters

##### address

`Address`

##### startKey

`bigint`

##### limit

`number`

#### Returns

`Promise`\<[`StorageRange`](StorageRange.md)\>

***

### generateCanonicalGenesis()?

> `optional` **generateCanonicalGenesis**(`initState`): `Promise`\<`void`\>

Defined in: src/interfaces.ts:175

#### Parameters

##### initState

`any`

#### Returns

`Promise`\<`void`\>

***

### getAccount()

> **getAccount**(`address`): `Promise`\<`Account` \| `undefined`\>

Defined in: src/interfaces.ts:126

#### Parameters

##### address

`Address`

#### Returns

`Promise`\<`Account` \| `undefined`\>

***

### getAppliedKey()?

> `optional` **getAppliedKey**(`address`): `Uint8Array`

Defined in: src/interfaces.ts:182

#### Parameters

##### address

`Uint8Array`

#### Returns

`Uint8Array`

***

### getCode()

> **getCode**(`address`): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: src/interfaces.ts:133

#### Parameters

##### address

`Address`

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

***

### getCodeSize()

> **getCodeSize**(`address`): `Promise`\<`number`\>

Defined in: src/interfaces.ts:134

#### Parameters

##### address

`Address`

#### Returns

`Promise`\<`number`\>

***

### getStateRoot()

> **getStateRoot**(): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: src/interfaces.ts:154

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

***

### getStorage()

> **getStorage**(`address`, `key`): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: src/interfaces.ts:137

#### Parameters

##### address

`Address`

##### key

`Uint8Array`

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

***

### hasStateRoot()

> **hasStateRoot**(`root`): `Promise`\<`boolean`\>

Defined in: src/interfaces.ts:156

#### Parameters

##### root

`Uint8Array`

#### Returns

`Promise`\<`boolean`\>

***

### initBinaryTreeExecutionWitness()?

> `optional` **initBinaryTreeExecutionWitness**(`blockNum`, `executionWitness?`): `void`

Defined in: src/interfaces.ts:176

#### Parameters

##### blockNum

`bigint`

##### executionWitness?

`BinaryTreeExecutionWitness` | `null`

#### Returns

`void`

***

### modifyAccountFields()

> **modifyAccountFields**(`address`, `accountFields`): `Promise`\<`void`\>

Defined in: src/interfaces.ts:129

#### Parameters

##### address

`Address`

##### accountFields

[`AccountFields`](../type-aliases/AccountFields.md)

#### Returns

`Promise`\<`void`\>

***

### putAccount()

> **putAccount**(`address`, `account?`): `Promise`\<`void`\>

Defined in: src/interfaces.ts:127

#### Parameters

##### address

`Address`

##### account?

`Account`

#### Returns

`Promise`\<`void`\>

***

### putCode()

> **putCode**(`address`, `value`): `Promise`\<`void`\>

Defined in: src/interfaces.ts:132

#### Parameters

##### address

`Address`

##### value

`Uint8Array`

#### Returns

`Promise`\<`void`\>

***

### putStorage()

> **putStorage**(`address`, `key`, `value`): `Promise`\<`void`\>

Defined in: src/interfaces.ts:138

#### Parameters

##### address

`Address`

##### key

`Uint8Array`

##### value

`Uint8Array`

#### Returns

`Promise`\<`void`\>

***

### revert()

> **revert**(): `Promise`\<`void`\>

Defined in: src/interfaces.ts:149

#### Returns

`Promise`\<`void`\>

***

### setStateRoot()

> **setStateRoot**(`stateRoot`, `clearCache?`): `Promise`\<`void`\>

Defined in: src/interfaces.ts:155

#### Parameters

##### stateRoot

`Uint8Array`

##### clearCache?

`boolean`

#### Returns

`Promise`\<`void`\>

***

### shallowCopy()

> **shallowCopy**(`downlevelCaches?`): `StateManagerInterface`

Defined in: src/interfaces.ts:188

#### Parameters

##### downlevelCaches?

`boolean`

#### Returns

`StateManagerInterface`

***

### tokenIdExists()

> **tokenIdExists**(`tokenId`): `Promise`\<`boolean`\>

Defined in: src/interfaces.ts:142

#### Parameters

##### tokenId

`number`

#### Returns

`Promise`\<`boolean`\>

***

### verifyBinaryTreePostState()?

> `optional` **verifyBinaryTreePostState**(`accessWitness`): `Promise`\<`boolean`\>

Defined in: src/interfaces.ts:180

#### Parameters

##### accessWitness

[`BinaryTreeAccessWitnessInterface`](BinaryTreeAccessWitnessInterface.md)

#### Returns

`Promise`\<`boolean`\>
