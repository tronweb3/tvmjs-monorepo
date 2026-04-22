[**@tvmjs/binarytree**](../README.md)

***

[@tvmjs/binarytree](../README.md) / CheckpointDBOpts

# Interface: CheckpointDBOpts

Defined in: types.ts:34

## Properties

### cacheSize?

> `optional` **cacheSize**: `number`

Defined in: types.ts:48

Cache size (default: 0)

***

### db

> **db**: `DB`\<`string`, `string` \| `Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: types.ts:38

A database instance.

***

### valueEncoding?

> `optional` **valueEncoding**: `ValueEncoding`

Defined in: types.ts:43

ValueEncoding of the database (the values which are `put`/`get` in the db are of this type). Defaults to `string`
