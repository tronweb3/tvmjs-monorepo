[**@tvmjs/binarytree**](../README.md)

***

[@tvmjs/binarytree](../README.md) / verifyBinaryProof

# Function: verifyBinaryProof()

> **verifyBinaryProof**(`rootHash`, `key`, `proof`): `Promise`\<`Uint8Array`\<`ArrayBufferLike`\> \| `null`\>

Defined in: proof.ts:34

Verifies a proof.

## Parameters

### rootHash

`Uint8Array`

### key

`Uint8Array`

### proof

`Uint8Array`\<`ArrayBufferLike`\>[]

## Returns

`Promise`\<`Uint8Array`\<`ArrayBufferLike`\> \| `null`\>

The value from the key, or null if valid proof of non-existence.

## Throws

If proof is found to be invalid.
