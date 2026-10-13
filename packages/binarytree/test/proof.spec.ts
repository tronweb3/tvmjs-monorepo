import { blake3 } from '@noble/hashes/blake3.js'
import { assert, describe, it } from 'vitest'

import { createBinaryTree } from '../src/constructors.ts'
import { decodeBinaryNode, isInternalBinaryNode } from '../src/index.ts'
import { binaryTreeFromProof, verifyBinaryProof } from '../src/proof.ts'

import type { StemBinaryNode } from '../src/node/stemNode.ts'

// Create an array of 100 random key/value pairs by hashing keys.

const keyValuePairs: { originalKey: Uint8Array; hashedKey: Uint8Array; value: Uint8Array }[] = []

for (let i = 0; i < 100; i++) {
  const key = new Uint8Array(32).fill(0)
  key[31] = i // vary the last byte to differentiate keys

  const hashedKey = blake3(key)

  // Create a value also based on i (filled with 0xBB and ending with i)
  const value = new Uint8Array(32).fill(1)
  value[31] = i

  keyValuePairs.push({ originalKey: key, hashedKey, value })
}

describe('binary tree proof', async () => {
  const tree1 = await createBinaryTree()

  // Insert each key/value pair into the tree.
  for (const { hashedKey, value } of keyValuePairs) {
    const stem = hashedKey.slice(0, 31)
    const index = hashedKey[31]
    await tree1.put(stem, [index], [value])
  }

  it('should create and verify a merkle proof for existing key', async () => {
    // create merkle proof for first key/value pair
    const proof = await tree1.createBinaryProof(keyValuePairs[0].hashedKey)

    const rootNode = decodeBinaryNode(proof[0])
    assert.deepEqual(
      tree1['merkelize'](rootNode),
      tree1.root(),
      'first value in proof should be root node',
    )
    const valueNode = decodeBinaryNode(proof[proof.length - 1]) as StemBinaryNode
    assert.deepEqual(
      keyValuePairs[0].value,
      valueNode.values[keyValuePairs[0].hashedKey[31]],
      'last value in proof should be target node',
    )

    // create sparse tree from proof
    const tree2 = await binaryTreeFromProof(proof)
    assert.deepEqual(
      tree2.root(),
      tree1.root(),
      'tree from proof should be created with correct root node',
    )

    // get value from sparse tree
    const [value] = await tree2.get(keyValuePairs[0].hashedKey.slice(0, 31), [
      keyValuePairs[0].hashedKey[31],
    ])
    assert.deepEqual(value, keyValuePairs[0].value)

    // verify proof using verifyBinaryProof
    const proofValue = await verifyBinaryProof(tree1.root(), keyValuePairs[0].hashedKey, proof)
    assert.deepEqual(keyValuePairs[0].value, proofValue, 'verify proof should return target value')
  })

  it('should create and verify a proof of non-existence', async () => {
    const fakeKey = new Uint8Array(keyValuePairs[0].hashedKey.length).fill(5)

    const proof = await tree1.createBinaryProof(fakeKey)
    const proofValue = await verifyBinaryProof(tree1.root(), fakeKey, proof)
    assert.deepEqual(proofValue, undefined, 'verify proof of non-existence should return undefined')
  })

  it('should verify non-existence proofs ending at an internal node', async () => {
    const tree = await createBinaryTree()
    const value = new Uint8Array(32).fill(1)
    const [keyA, keyB, keyC] = [0x00, 0x80, 0xa0].map((byte) => new Uint8Array(32).fill(byte))
    for (const key of [keyA, keyB, keyC]) await tree.put(key.slice(0, 31), [key[31]], [value])
    // 0x80 and 0xa0 share the prefix 0b10, so the path for 0b11… ends at their internal parent.
    const missingKey = new Uint8Array(32).fill(0xc0)
    const proof = await tree.createBinaryProof(missingKey)
    assert.isTrue(isInternalBinaryNode(decodeBinaryNode(proof[proof.length - 1])))
    assert.notExists(await verifyBinaryProof(tree.root(), missingKey, proof))
  })

  it('should verify proofs after deleting a stem', async () => {
    const tree = await createBinaryTree()
    const keyA = new Uint8Array(32).fill(0x01)
    const keyB = new Uint8Array(32).fill(0x02)
    const value = new Uint8Array(32).fill(1)
    await tree.put(keyA.slice(0, 31), [keyA[31]], [value])
    await tree.put(keyB.slice(0, 31), [keyB[31]], [value])
    await tree.del(keyB.slice(0, 31), [keyB[31]])

    assert.notExists(await verifyBinaryProof(tree.root(), keyB, await tree.createBinaryProof(keyB)))
    assert.deepEqual(
      await verifyBinaryProof(tree.root(), keyA, await tree.createBinaryProof(keyA)),
      value,
    )
  })

  it('should verify non-existence proofs against an empty tree', async () => {
    const tree = await createBinaryTree()
    const key = new Uint8Array(32)
    await tree.put(key.slice(0, 31), [key[31]], [new Uint8Array(32).fill(1)])
    await tree.del(key.slice(0, 31), [key[31]])
    const proof = await tree.createBinaryProof(key)
    assert.deepEqual(proof, [])
    assert.isNull(await verifyBinaryProof(tree.root(), key, proof))
    try {
      await verifyBinaryProof(new Uint8Array(32).fill(1), key, proof)
      assert.fail('should reject an empty proof for a non-empty root')
    } catch (e) {
      assert.include((e as Error).message, 'rootHash does not match proof root')
    }
  })
})
