import { MapDB, ValueEncoding, utf8ToBytes } from '@tvmjs/util'
import { assert, describe, it } from 'vitest'

import {
  MerklePatriciaTrie,
  createMPT,
  createMPTFromProof,
  createMerkleProof,
  genesisMPTStateRoot,
} from '../src/index.ts'

describe('MPT Coverage Boost Tests', () => {
  it('covers genesisMPTStateRoot with various account shapes', async () => {
    const genesisState: any = {
      // String balance
      '0x1111111111111111111111111111111111111111': '1000',
      // Partial AccountState with balance, code, storage, nonce
      '0x2222222222222222222222222222222222222222': [
        '2000', // balance
        '0x60016000', // code
        [
          ['0x01', '0x02'],
          ['0x03', '0x04'],
        ], // storage
        '10', // nonce
      ],
      // Unprefixed address and empty storage
      '3333333333333333333333333333333333333333': ['500', undefined, [], undefined],
    }

    const root = await genesisMPTStateRoot(genesisState)
    assert.isDefined(root)
    assert.lengthOf(root, 32)
  })

  it('covers createMPT with different options', async () => {
    // Basic createMPT
    const trie1 = await createMPT()
    assert.isDefined(trie1)

    // With useKeyHashing and keyPrefix
    const trie2 = await createMPT({
      useKeyHashing: true,
      keyPrefix: new Uint8Array([1, 2, 3]),
    })
    assert.isDefined(trie2)

    // With db and useRootPersistence (without root)
    const db = new MapDB<string, string | Uint8Array>()
    const trie3 = await createMPT({
      db,
      useRootPersistence: true,
      valueEncoding: ValueEncoding.Bytes,
    })
    assert.isDefined(trie3)

    // With db and useRootPersistence (with root)
    const customRoot = new Uint8Array(32).fill(7)
    const trie4 = await createMPT({
      db,
      useRootPersistence: true,
      valueEncoding: ValueEncoding.Bytes,
      root: customRoot,
    })
    assert.isDefined(trie4)
    assert.deepEqual(trie4.root(), customRoot)

    // With String valueEncoding and existing string root in db
    const trie5 = await createMPT({
      db,
      useRootPersistence: true,
      valueEncoding: ValueEncoding.String,
      root: customRoot,
    })
    assert.isDefined(trie5)
  })

  it('covers createMPTFromProof and proof methods', async () => {
    const trie = new MerklePatriciaTrie()
    const k1 = utf8ToBytes('key1')
    const v1 = utf8ToBytes('val1')
    await trie.put(k1, v1)

    const proof = await createMerkleProof(trie, k1)
    assert.isTrue(proof.length > 0)

    const fromProofTrie = await createMPTFromProof(proof, { root: trie.root() })
    assert.deepEqual(fromProofTrie.root(), trie.root())
    const val = await fromProofTrie.get(k1)
    assert.deepEqual(val, v1)
  })

  it('covers trie methods: checkpoint, revert, commit, shallowCopy', async () => {
    const trie = new MerklePatriciaTrie({ useKeyHashing: true })
    assert.isFalse(trie.hasCheckpoints())

    trie.checkpoint()
    assert.isTrue(trie.hasCheckpoints())

    await trie.put(utf8ToBytes('tempKey'), utf8ToBytes('tempVal'))
    await trie.revert()
    assert.isFalse(trie.hasCheckpoints())
    assert.isNull(await trie.get(utf8ToBytes('tempKey')))

    trie.checkpoint()
    await trie.put(utf8ToBytes('tempKey2'), utf8ToBytes('tempVal2'))
    await trie.commit()
    assert.isFalse(trie.hasCheckpoints())
    assert.deepEqual(await trie.get(utf8ToBytes('tempKey2')), utf8ToBytes('tempVal2'))

    const copy = trie.shallowCopy()
    assert.deepEqual(copy.root(), trie.root())
  })
})
