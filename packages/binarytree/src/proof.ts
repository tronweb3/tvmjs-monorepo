import { EthereumJSErrorWithoutCode, equalsBytes } from '@tvmjs/util'

import { createBinaryTree } from './constructors.ts'
import { decodeBinaryNode, isStemBinaryNode } from './node/index.ts'

import type { BinaryTree } from './binaryTree.ts'
import type { BinaryNode } from './node/index.ts'

/**
 * Saves the nodes from a proof into the tree.
 * @param proof
 */
export async function binaryTreeFromProof(proof: Uint8Array[]): Promise<BinaryTree> {
  const proofTrie = await createBinaryTree()
  const putStack: [Uint8Array, BinaryNode][] = proof.map((bytes) => {
    const node = decodeBinaryNode(bytes)
    return [proofTrie['merkelize'](node), node]
  })
  await proofTrie.saveStack(putStack)
  const root = putStack[0][0]
  proofTrie.root(root)
  return proofTrie
}

/**
 * Verifies a proof.
 * @param rootHash
 * @param key
 * @param proof
 * @throws If proof is found to be invalid.
 * @returns The value from the key, or null if valid proof of non-existence.
 */
export async function verifyBinaryProof(
  rootHash: Uint8Array,
  key: Uint8Array,
  proof: Uint8Array[],
): Promise<Uint8Array | null> {
  // An empty proof can only prove non-existence in an empty tree.
  if (proof.length === 0) {
    if (!equalsBytes(rootHash, new Uint8Array(32))) {
      throw EthereumJSErrorWithoutCode('rootHash does not match proof root')
    }
    return null
  }
  const proofTrie = await binaryTreeFromProof(proof)
  if (!equalsBytes(proofTrie.root(), rootHash)) {
    throw EthereumJSErrorWithoutCode('rootHash does not match proof root')
  }
  const stem = key.slice(0, 31)
  const [value] = await proofTrie.get(stem, [key[31]])
  // Non-existence proofs may end at an internal node or at a stem node with a different stem.
  const lastNode = decodeBinaryNode(proof[proof.length - 1])
  const expectedValue =
    isStemBinaryNode(lastNode) && equalsBytes(lastNode.stem, stem) ? lastNode.values[key[31]] : null
  if (!expectedValue) {
    if (value) {
      throw EthereumJSErrorWithoutCode('Proof is invalid')
    }
  } else if (value && !equalsBytes(value, expectedValue)) {
    throw EthereumJSErrorWithoutCode('Proof is invalid')
  }
  return value
}
