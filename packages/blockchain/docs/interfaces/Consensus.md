[**@tvmjs/blockchain**](../README.md)

***

[@tvmjs/blockchain](../README.md) / Consensus

# Interface: Consensus

Defined in: types.ts:217

Interface that a consensus class needs to implement.

## Properties

### algorithm

> **algorithm**: `string`

Defined in: types.ts:218

## Methods

### genesisInit()

> **genesisInit**(`genesisBlock`): `Promise`\<`void`\>

Defined in: types.ts:223

Initialize genesis for consensus mechanism

#### Parameters

##### genesisBlock

`Block`

genesis block

#### Returns

`Promise`\<`void`\>

***

### newBlock()

> **newBlock**(`block`, `commonAncestor?`, `ancientHeaders?`): `Promise`\<`void`\>

Defined in: types.ts:244

Update consensus on new block

#### Parameters

##### block

`Block`

new block

##### commonAncestor?

`BlockHeader`

common ancestor block header (optional)

##### ancientHeaders?

`BlockHeader`[]

array of ancestor block headers (optional)

#### Returns

`Promise`\<`void`\>

***

### setup()

> **setup**(`__namedParameters`): `Promise`\<`void`\>

Defined in: types.ts:228

Set up consensus mechanism

#### Parameters

##### \_\_namedParameters

[`ConsensusOptions`](ConsensusOptions.md)

#### Returns

`Promise`\<`void`\>

***

### validateConsensus()

> **validateConsensus**(`block`): `Promise`\<`void`\>

Defined in: types.ts:234

Validate block consensus parameters

#### Parameters

##### block

`Block`

block to be validated

#### Returns

`Promise`\<`void`\>

***

### validateDifficulty()

> **validateDifficulty**(`header`): `Promise`\<`void`\>

Defined in: types.ts:236

#### Parameters

##### header

`BlockHeader`

#### Returns

`Promise`\<`void`\>
