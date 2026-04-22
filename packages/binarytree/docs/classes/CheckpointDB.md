[**@tvmjs/binarytree**](../README.md)

***

[@tvmjs/binarytree](../README.md) / CheckpointDB

# Class: CheckpointDB

Defined in: db/checkpoint.ts:11

DB is a thin wrapper around the underlying levelup db,
which validates inputs and sets encoding type.

## Implements

- `DB`

## Constructors

### Constructor

> **new CheckpointDB**(`opts`): `CheckpointDB`

Defined in: db/checkpoint.ts:45

Initialize a DB instance.

#### Parameters

##### opts

[`CheckpointDBOpts`](../interfaces/CheckpointDBOpts.md)

#### Returns

`CheckpointDB`

## Properties

### \_stats

> **\_stats**: `object`

Defined in: db/checkpoint.ts:29

#### cache

> **cache**: `object`

##### cache.hits

> **hits**: `number` = `0`

##### cache.reads

> **reads**: `number` = `0`

##### cache.writes

> **writes**: `number` = `0`

#### db

> **db**: `object`

##### db.hits

> **hits**: `number` = `0`

##### db.reads

> **reads**: `number` = `0`

##### db.writes

> **writes**: `number` = `0`

***

### cacheSize

> `readonly` **cacheSize**: `number`

Defined in: db/checkpoint.ts:14

***

### checkpoints

> **checkpoints**: [`Checkpoint`](../type-aliases/Checkpoint.md)[]

Defined in: db/checkpoint.ts:12

***

### db

> **db**: `DB`\<`string`, `string` \| `Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: db/checkpoint.ts:13

## Methods

### batch()

> **batch**(`opStack`): `Promise`\<`void`\>

Defined in: db/checkpoint.ts:227

#### Parameters

##### opStack

`BatchDBOp`[]

#### Returns

`Promise`\<`void`\>

#### Inherit Doc

#### Implementation of

`DB.batch`

***

### checkpoint()

> **checkpoint**(`root`): `void`

Defined in: db/checkpoint.ts:86

Adds a new checkpoint to the stack

#### Parameters

##### root

`Uint8Array`

#### Returns

`void`

***

### commit()

> **commit**(): `Promise`\<`void`\>

Defined in: db/checkpoint.ts:93

Commits the latest checkpoint

#### Returns

`Promise`\<`void`\>

***

### del()

> **del**(`key`): `Promise`\<`void`\>

Defined in: db/checkpoint.ts:204

#### Parameters

##### key

`Uint8Array`

#### Returns

`Promise`\<`void`\>

#### Inherit Doc

#### Implementation of

`DB.del`

***

### get()

> **get**(`key`): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\> \| `undefined`\>

Defined in: db/checkpoint.ts:133

#### Parameters

##### key

`Uint8Array`

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\> \| `undefined`\>

#### Inherit Doc

#### Implementation of

`DB.get`

***

### hasCheckpoints()

> **hasCheckpoints**(): `boolean`

Defined in: db/checkpoint.ts:78

Is the DB during a checkpoint phase?

#### Returns

`boolean`

***

### open()

> **open**(): `Promise`\<`void`\>

Defined in: db/checkpoint.ts:289

Opens the database -- if applicable

#### Returns

`Promise`\<`void`\>

#### Implementation of

`DB.open`

***

### put()

> **put**(`key`, `value`): `Promise`\<`void`\>

Defined in: db/checkpoint.ts:179

#### Parameters

##### key

`Uint8Array`

##### value

`Uint8Array`

#### Returns

`Promise`\<`void`\>

#### Inherit Doc

#### Implementation of

`DB.put`

***

### revert()

> **revert**(): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: db/checkpoint.ts:125

Reverts the latest checkpoint

#### Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\>\>

***

### setCheckpoints()

> **setCheckpoints**(`checkpoints`): `void`

Defined in: db/checkpoint.ts:64

Flush the checkpoints and use the given checkpoints instead.

#### Parameters

##### checkpoints

[`Checkpoint`](../type-aliases/Checkpoint.md)[]

#### Returns

`void`

***

### shallowCopy()

> **shallowCopy**(): `CheckpointDB`

Defined in: db/checkpoint.ts:281

#### Returns

`CheckpointDB`

#### Inherit Doc

#### Implementation of

`DB.shallowCopy`

***

### stats()

> **stats**(`reset`): `object`

Defined in: db/checkpoint.ts:259

#### Parameters

##### reset

`boolean` = `true`

#### Returns

`object`

##### cache

> **cache**: `object`

###### cache.hits

> **hits**: `number` = `0`

###### cache.reads

> **reads**: `number` = `0`

###### cache.writes

> **writes**: `number` = `0`

##### db

> **db**: `object`

###### db.hits

> **hits**: `number` = `0`

###### db.reads

> **reads**: `number` = `0`

###### db.writes

> **writes**: `number` = `0`

##### size

> **size**: `number`
