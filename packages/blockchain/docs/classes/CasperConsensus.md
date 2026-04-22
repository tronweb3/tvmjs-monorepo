[**@tvmjs/blockchain**](../README.md)

***

[@tvmjs/blockchain](../README.md) / CasperConsensus

# Class: CasperConsensus

Defined in: consensus/casper.ts:10

This class encapsulates Casper-related consensus functionality when used with the Blockchain class.

## Implements

- [`Consensus`](../interfaces/Consensus.md)

## Constructors

### Constructor

> **new CasperConsensus**(): `CasperConsensus`

Defined in: consensus/casper.ts:13

#### Returns

`CasperConsensus`

## Properties

### algorithm

> **algorithm**: `ConsensusAlgorithm`

Defined in: consensus/casper.ts:11

#### Implementation of

[`Consensus`](../interfaces/Consensus.md).[`algorithm`](../interfaces/Consensus.md#algorithm)

## Methods

### genesisInit()

> **genesisInit**(): `Promise`\<`void`\>

Defined in: consensus/casper.ts:17

Initialize genesis for consensus mechanism

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Consensus`](../interfaces/Consensus.md).[`genesisInit`](../interfaces/Consensus.md#genesisinit)

***

### newBlock()

> **newBlock**(): `Promise`\<`void`\>

Defined in: consensus/casper.ts:32

Update consensus on new block

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Consensus`](../interfaces/Consensus.md).[`newBlock`](../interfaces/Consensus.md#newblock)

***

### setup()

> **setup**(): `Promise`\<`void`\>

Defined in: consensus/casper.ts:19

Set up consensus mechanism

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Consensus`](../interfaces/Consensus.md).[`setup`](../interfaces/Consensus.md#setup)

***

### validateConsensus()

> **validateConsensus**(): `Promise`\<`void`\>

Defined in: consensus/casper.ts:21

Validate block consensus parameters

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Consensus`](../interfaces/Consensus.md).[`validateConsensus`](../interfaces/Consensus.md#validateconsensus)

***

### validateDifficulty()

> **validateDifficulty**(`header`): `Promise`\<`void`\>

Defined in: consensus/casper.ts:23

#### Parameters

##### header

`BlockHeader`

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Consensus`](../interfaces/Consensus.md).[`validateDifficulty`](../interfaces/Consensus.md#validatedifficulty)
