[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / getBinaryTreeKey

# Function: getBinaryTreeKey()

> **getBinaryTreeKey**(`stem`, `leaf`): `Uint8Array`\<`ArrayBuffer`\>

Defined in: packages/util/src/binaryTree.ts:116

## Parameters

### stem

`Uint8Array`

The 31-bytes binary tree stem as a Uint8Array.

### leaf

`Uint8Array`\<`ArrayBufferLike`\> | [`BinaryTreeLeafType`](../type-aliases/BinaryTreeLeafType.md)

## Returns

`Uint8Array`\<`ArrayBuffer`\>

The tree key as a Uint8Array.

## Dev

Returns the tree key for a given binary tree stem, and sub index.

## Dev

Assumes that the tree node width = 256
