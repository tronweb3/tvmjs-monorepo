[**@tvmjs/binarytree**](../README.md)

***

[@tvmjs/binarytree](../README.md) / BinaryTreeOpts

# Interface: BinaryTreeOpts

Defined in: types.ts:5

## Properties

### cacheSize

> **cacheSize**: `number`

Defined in: types.ts:26

LRU cache for tree nodes to allow for faster node retrieval.

Default: 0 (deactivated)

***

### db

> **db**: `DB`\<`string`, `string` \| `Uint8Array`\<`ArrayBufferLike`\>\>

Defined in: types.ts:9

A database instance.

***

### hashFunction()

> **hashFunction**: (`msg`) => `Uint8Array`

Defined in: types.ts:31

Hash function used for hashing the tree nodes.

#### Parameters

##### msg

`Uint8Array`

#### Returns

`Uint8Array`

***

### root?

> `optional` **root**: `Uint8Array`\<`ArrayBufferLike`\>

Defined in: types.ts:14

A `Uint8Array` for the root of a previously stored tree

***

### useRootPersistence

> **useRootPersistence**: `boolean`

Defined in: types.ts:19

Store the root inside the database after every `write` operation
