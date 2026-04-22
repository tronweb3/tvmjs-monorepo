[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / Account

# Class: Account

Defined in: packages/util/src/account.ts:145

Account class to load and maintain the  basic account objects.
Supports partial loading and access required for stateless with null
as the placeholder.

Note: passing undefined in constructor is different from null
While undefined leads to default assignment, null is retained
to track the information not available/loaded because of partial
witness access

## Constructors

### Constructor

> **new Account**(`nonce`, `balance`, `storageRoot`, `codeHash`, `codeSize`, `version`, `asset`, `activePermissions`): `Account`

Defined in: packages/util/src/account.ts:276

This constructor assigns and validates the values.
It is not recommended to use this constructor directly. Instead use the static
factory methods to assist in creating an Account from varying data types.
undefined get assigned with the defaults, but null args are retained as is

#### Parameters

##### nonce

`bigint` | `null`

##### balance

`bigint` | `null`

##### storageRoot

`Uint8Array`\<`ArrayBufferLike`\> | `null`

##### codeHash

`Uint8Array`\<`ArrayBufferLike`\> | `null`

##### codeSize

`number` | `null`

##### version

`number` | `null`

##### asset

\{\[`key`: `number`\]: `bigint`; \} | `null`

##### activePermissions

[`Permission`](../interfaces/Permission.md)[] | `null`

#### Returns

`Account`

#### Deprecated

## Properties

### \_activePermissions

> **\_activePermissions**: [`Permission`](../interfaces/Permission.md)[] \| `null` = `null`

Defined in: packages/util/src/account.ts:156

***

### \_asset

> **\_asset**: \{\[`key`: `string` \| `number`\]: `bigint`; \} \| `null` = `null`

Defined in: packages/util/src/account.ts:153

***

### \_balance

> **\_balance**: `bigint` \| `null` = `null`

Defined in: packages/util/src/account.ts:147

***

### \_codeHash

> **\_codeHash**: `Uint8Array`\<`ArrayBufferLike`\> \| `null` = `null`

Defined in: packages/util/src/account.ts:149

***

### \_codeSize

> **\_codeSize**: `number` \| `null` = `null`

Defined in: packages/util/src/account.ts:151

***

### \_nonce

> **\_nonce**: `bigint` \| `null` = `null`

Defined in: packages/util/src/account.ts:146

***

### \_storageRoot

> **\_storageRoot**: `Uint8Array`\<`ArrayBufferLike`\> \| `null` = `null`

Defined in: packages/util/src/account.ts:148

***

### \_version

> **\_version**: `number` \| `null` = `null`

Defined in: packages/util/src/account.ts:152

## Accessors

### activePermissions

#### Get Signature

> **get** **activePermissions**(): [`Permission`](../interfaces/Permission.md)[] \| `null`

Defined in: packages/util/src/account.ts:242

##### Returns

[`Permission`](../interfaces/Permission.md)[] \| `null`

#### Set Signature

> **set** **activePermissions**(`_activePermissions`): `void`

Defined in: packages/util/src/account.ts:249

##### Parameters

###### \_activePermissions

[`Permission`](../interfaces/Permission.md)[] | `null`

##### Returns

`void`

***

### asset

#### Get Signature

> **get** **asset**(): \{\[`key`: `number`\]: `bigint`; \} \| `null`

Defined in: packages/util/src/account.ts:224

##### Returns

\{\[`key`: `number`\]: `bigint`; \} \| `null`

#### Set Signature

> **set** **asset**(`_asset`): `void`

Defined in: packages/util/src/account.ts:231

##### Parameters

###### \_asset

\{\[`key`: `number`\]: `bigint`; \} | `null`

##### Returns

`void`

***

### balance

#### Get Signature

> **get** **balance**(): `bigint`

Defined in: packages/util/src/account.ts:180

##### Returns

`bigint`

#### Set Signature

> **set** **balance**(`_balance`): `void`

Defined in: packages/util/src/account.ts:187

##### Parameters

###### \_balance

`bigint`

##### Returns

`void`

***

### codeHash

#### Get Signature

> **get** **codeHash**(): `Uint8Array`\<`ArrayBufferLike`\>

Defined in: packages/util/src/account.ts:202

##### Returns

`Uint8Array`\<`ArrayBufferLike`\>

#### Set Signature

> **set** **codeHash**(`_codeHash`): `void`

Defined in: packages/util/src/account.ts:209

##### Parameters

###### \_codeHash

`Uint8Array`

##### Returns

`void`

***

### codeSize

#### Get Signature

> **get** **codeSize**(): `number`

Defined in: packages/util/src/account.ts:213

##### Returns

`number`

#### Set Signature

> **set** **codeSize**(`_codeSize`): `void`

Defined in: packages/util/src/account.ts:220

##### Parameters

###### \_codeSize

`number`

##### Returns

`void`

***

### nonce

#### Get Signature

> **get** **nonce**(): `bigint`

Defined in: packages/util/src/account.ts:169

##### Returns

`bigint`

#### Set Signature

> **set** **nonce**(`_nonce`): `void`

Defined in: packages/util/src/account.ts:176

##### Parameters

###### \_nonce

`bigint`

##### Returns

`void`

***

### storageRoot

#### Get Signature

> **get** **storageRoot**(): `Uint8Array`\<`ArrayBufferLike`\>

Defined in: packages/util/src/account.ts:191

##### Returns

`Uint8Array`\<`ArrayBufferLike`\>

#### Set Signature

> **set** **storageRoot**(`_storageRoot`): `void`

Defined in: packages/util/src/account.ts:198

##### Parameters

###### \_storageRoot

`Uint8Array`

##### Returns

`void`

***

### version

#### Get Signature

> **get** **version**(): `number`

Defined in: packages/util/src/account.ts:158

##### Returns

`number`

#### Set Signature

> **set** **version**(`_version`): `void`

Defined in: packages/util/src/account.ts:165

##### Parameters

###### \_version

`number`

##### Returns

`void`

## Methods

### getPermissionById()

> **getPermissionById**(`id`): [`Permission`](../interfaces/Permission.md) \| `null`

Defined in: packages/util/src/account.ts:257

#### Parameters

##### id

`number`

#### Returns

[`Permission`](../interfaces/Permission.md) \| `null`

***

### getTokenBalance()

> **getTokenBalance**(`tokenId`): `bigint`

Defined in: packages/util/src/account.ts:235

#### Parameters

##### tokenId

`bigint`

#### Returns

`bigint`

***

### isContract()

> **isContract**(): `boolean`

Defined in: packages/util/src/account.ts:394

Returns a `Boolean` determining if the account is a contract.

#### Returns

`boolean`

***

### isEmpty()

> **isEmpty**(): `boolean`

Defined in: packages/util/src/account.ts:409

Returns a `Boolean` determining if the account is empty complying to the definition of
account emptiness in [EIP-161](https://eips.ethereum.org/EIPS/eip-161):
"An account is considered empty when it has no code and zero nonce and zero balance."

#### Returns

`boolean`

***

### raw()

> **raw**(): `Uint8Array`\<`ArrayBufferLike`\>[]

Defined in: packages/util/src/account.ts:323

Returns an array of Uint8Arrays of the raw bytes for the account, in order.

#### Returns

`Uint8Array`\<`ArrayBufferLike`\>[]

***

### serialize()

> **serialize**(): `Uint8Array`

Defined in: packages/util/src/account.ts:343

Returns the RLP serialization of the account as a `Uint8Array`.

#### Returns

`Uint8Array`

***

### serializeWithPartialInfo()

> **serializeWithPartialInfo**(): `Uint8Array`

Defined in: packages/util/src/account.ts:347

#### Returns

`Uint8Array`

***

### updatePermissions()

> **updatePermissions**(`__namedParameters`): `void`

Defined in: packages/util/src/account.ts:253

#### Parameters

##### \_\_namedParameters

###### activePermissions

[`Permission`](../interfaces/Permission.md)[]

#### Returns

`void`
