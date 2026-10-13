import { RLP } from '@tvmjs/rlp'
import { EthereumJSErrorWithoutCode } from '@tvmjs/util'

import { generateCliqueBlockExtraData } from '../consensus/clique.ts'
import { numberToHex, rejectRemovedHeaderFields, valuesArrayToHeaderData } from '../helpers.ts'
import { BlockHeader } from '../index.ts'

import type { BlockHeaderBytes, BlockOptions, HeaderData, JSONRPCBlock } from '../types.ts'

/**
 * Static constructor to create a block header from a header data dictionary
 *
 * @param headerData
 * @param opts
 */
export function createBlockHeader(headerData: HeaderData = {}, opts: BlockOptions = {}) {
  return new BlockHeader(headerData, opts)
}

/**
 * Static constructor to create a block header from an array of bytes values
 *
 * @param values
 * @param opts
 */
export function createBlockHeaderFromBytesArray(values: BlockHeaderBytes, opts: BlockOptions = {}) {
  const headerData = valuesArrayToHeaderData(values)
  const { baseFeePerGas, requestsHash } = headerData
  const header = createBlockHeader(headerData, opts)
  if (header.common.isActivatedEIP(1559) && baseFeePerGas === undefined) {
    // A serialized header must carry its fee; constructor defaults cannot repair wire data.
    throw EthereumJSErrorWithoutCode('invalid header. baseFeePerGas should be provided')
  }
  if (header.common.isActivatedEIP(7685) && requestsHash === undefined) {
    throw EthereumJSErrorWithoutCode('invalid header. requestsHash should be provided')
  }
  if (header.common.isActivatedEIP(7928) && header.blockAccessListHash === undefined) {
    throw EthereumJSErrorWithoutCode('invalid header. blockAccessListHash should be provided')
  }
  if (header.common.isActivatedEIP(7843) && header.slotNumber === undefined) {
    throw EthereumJSErrorWithoutCode('invalid header. slotNumber should be provided')
  }
  return header
}

/**
 * Static constructor to create a block header from a RLP-serialized header
 *
 * @param serializedHeaderData
 * @param opts
 */
export function createBlockHeaderFromRLP(
  serializedHeaderData: Uint8Array,
  opts: BlockOptions = {},
) {
  const values = RLP.decode(serializedHeaderData)
  if (!Array.isArray(values)) {
    throw EthereumJSErrorWithoutCode('Invalid serialized header input. Must be array')
  }
  return createBlockHeaderFromBytesArray(values as Uint8Array[], opts)
}

/**
 * Creates a Clique block header with the seal applied during instantiation.
 * @param headerData Header fields for the Clique block
 * @param cliqueSigner Private key bytes used to sign the header
 * @param opts {@link BlockOptions}
 * @returns A sealed {@link BlockHeader}
 */
export function createSealedCliqueBlockHeader(
  headerData: HeaderData = {},
  cliqueSigner: Uint8Array,
  opts: BlockOptions = {},
): BlockHeader {
  const sealedCliqueBlockHeader = new BlockHeader(headerData, {
    ...opts,
    ...{ skipConsensusFormatValidation: true },
  })
  ;(sealedCliqueBlockHeader.extraData as any) = generateCliqueBlockExtraData(
    sealedCliqueBlockHeader,
    cliqueSigner,
  )
  if (opts.skipConsensusFormatValidation === false)
    // We need to validate the consensus format here since we skipped it when constructing the block header
    sealedCliqueBlockHeader['_consensusFormatValidation']()
  return sealedCliqueBlockHeader
}

/**
 * Creates a new block header object from Ethereum JSON RPC.
 *
 * @param blockParams - Ethereum JSON RPC of block (eth_getBlockByNumber)
 * @param options - An object describing the blockchain
 */
export function createBlockHeaderFromRPC(blockParams: JSONRPCBlock, options?: BlockOptions) {
  rejectRemovedHeaderFields(blockParams)
  const {
    parentHash,
    sha3Uncles,
    miner,
    stateRoot,
    transactionsRoot,
    receiptsRoot,
    logsBloom,
    difficulty,
    number,
    gasLimit,
    gasUsed,
    timestamp,
    extraData,
    mixHash,
    nonce,
    baseFeePerGas,
    withdrawalsRoot,
    requestsHash,
    blockAccessListHash,
    slotNumber,
  } = blockParams

  const blockHeader = new BlockHeader(
    {
      parentHash,
      uncleHash: sha3Uncles,
      coinbase: miner,
      stateRoot,
      transactionsTrie: transactionsRoot,
      receiptTrie: receiptsRoot,
      logsBloom,
      difficulty: numberToHex(difficulty),
      number,
      gasLimit,
      gasUsed,
      timestamp,
      extraData,
      mixHash,
      nonce,
      baseFeePerGas,
      withdrawalsRoot,
      requestsHash,
      blockAccessListHash,
      slotNumber,
    },
    options,
  )

  return blockHeader
}
