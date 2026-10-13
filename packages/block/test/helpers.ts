import { Common, ConsensusAlgorithm, ConsensusType, TronMainnet } from '@tvmjs/common'
import { createLegacyTx } from '@tvmjs/tx'
import { hexToBytes } from '@tvmjs/util'

import { createBlock, genTransactionsTrieRoot } from '../src/index.ts'

import type { HeaderData } from '../src/index.ts'

// Explicit local metadata exercises retained consensus tools, not a TRON network's consensus.
export function powCommon(chainId = TronMainnet.chainId) {
  return new Common({
    chain: {
      ...TronMainnet,
      chainId,
      consensus: { type: ConsensusType.ProofOfWork, algorithm: ConsensusAlgorithm.Ethash },
    },
  })
}

export function cliqueCommon(chainId = TronMainnet.chainId) {
  return new Common({
    chain: {
      ...TronMainnet,
      chainId,
      consensus: {
        type: ConsensusType.ProofOfAuthority,
        algorithm: ConsensusAlgorithm.Clique,
        clique: { period: 15, epoch: 30000 },
      },
    },
  })
}

export const signingKey = hexToBytes(`0x${'20'.repeat(32)}`)

export async function signedBlock(
  common = new Common({ chain: TronMainnet }),
  header: HeaderData = {},
) {
  const tx = createLegacyTx(
    {
      to: `0x${'11'.repeat(20)}`,
      gasLimit: 21000n,
      gasPrice: 7n,
      tokenId: 9007199254740993n,
      tokenValue: 7n,
    },
    { common },
  ).sign(signingKey)
  return createBlock(
    {
      header: { transactionsTrie: await genTransactionsTrieRoot([tx]), ...header },
      transactions: [tx],
    },
    { common },
  )
}
