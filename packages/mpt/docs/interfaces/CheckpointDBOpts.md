[**@tvmjs/mpt**](../README.md)

***

[@tvmjs/mpt](../README.md) / CheckpointDBOpts

# Interface: CheckpointDBOpts

Defined in: packages/mpt/src/types.ts:127

## Properties

### cacheSize?

> `optional` **cacheSize**: `number`

Defined in: packages/mpt/src/types.ts:141

Cache size (default: 0)

***

### db

> **db**: `DB`\<`string`, `string` \| `Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: packages/mpt/src/types.ts:131

A database instance.

***

### valueEncoding?

> `optional` **valueEncoding**: `ValueEncoding`

Defined in: packages/mpt/src/types.ts:136

ValueEncoding of the database (the values which are `put`/`get` in the db are of this type). Defaults to `string`
