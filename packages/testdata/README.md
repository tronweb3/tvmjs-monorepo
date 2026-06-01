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

## TVMJS

This project is part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) monorepo — a TypeScript implementation of the TRON Virtual Machine. See the [developer docs](../../DEVELOPER.md) for an overview of current standards and tools.
