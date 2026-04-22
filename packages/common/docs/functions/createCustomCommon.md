[**@tvmjs/common**](../README.md)

***

[@tvmjs/common](../README.md) / createCustomCommon

# Function: createCustomCommon()

> **createCustomCommon**(`partialConfig`, `baseChain`, `opts`): [`Common`](../classes/Common.md)

Defined in: src/constructors.ts:22

Creates a [Common](../classes/Common.md) object for a custom chain, based on a standard one.

It uses all the [Chain](../type-aliases/Chain.md) parameters from the [baseChain](#createcustomcommon) option except the ones overridden
in a provided chainParamsOrName dictionary. Some usage example:

```javascript
import { createCustomCommon, Mainnet } from '@tvmjs/common'

createCustomCommon({chainId: 123}, Mainnet)
```

## Parameters

### partialConfig

`Partial`\<[`ChainConfig`](../interfaces/ChainConfig.md)\>

Custom parameter dict

### baseChain

[`ChainConfig`](../interfaces/ChainConfig.md)

`ChainConfig` chain configuration taken as a base chain, e.g. `Mainnet` (exported at root level)

### opts

[`BaseOpts`](../interfaces/BaseOpts.md) = `{}`

Custom chain options to set various [BaseOpts](../interfaces/BaseOpts.md)

## Returns

[`Common`](../classes/Common.md)
