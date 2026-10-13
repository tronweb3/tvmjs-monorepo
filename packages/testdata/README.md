# @tvmjs/testdata

This package contains common test data used across TVMJS packages. It is intended to be used as a devDependency in other packages within the monorepo.

## Usage

To use this package in another package within the monorepo:

1. Add it as a devDependency in the package's `package.json`:
```json
{
  "devDependencies": {
    "@tvmjs/testdata": "workspace:*"
  }
}
```

2. Import test data in your test files:
```typescript
import { testData } from '@tvmjs/testdata'
```

## Development

This package is not published to npm and is meant to be used only within the TVMJS monorepo.

## Historical chain data

`customChainConfig`, `goerliChainConfig`, `mergeTestnetChainConfig` and `testnetMergeChainConfig` are historical Ethereum fixtures typed as `EthereumChainData`. Their data is unchanged, but they are not executable `ChainConfig` values and cannot be passed to TRON execution constructors. Use TRON presets for execution tests and supply local genesis or consensus metadata explicitly when needed.

Geth genesis fixtures remain available for pure data parsing and allocation tests. Importing their state does not enable their Ethereum hardfork schedules.

The CommonJS build uses the shared CJS compiler settings so the package's `require` entry point emits CommonJS code, alongside the separate ESM build.

## TVMJS

This project is part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) monorepo — a TypeScript implementation of the TRON Virtual Machine. See the [developer docs](../../DEVELOPER.md) for an overview of current standards and tools.
