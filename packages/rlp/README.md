# @tvmjs/rlp `1.0.0`

| [Recursive Length Prefix](https://ethereum.org/en/developers/docs/data-structures-and-encoding/rlp) encoding for Node.js and the browser. Part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, forked from [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo). |
| --- |

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
- [Browser](#browser)
- [API](#api)
- [CLI](#cli)
- [Upstream](#upstream)
- [License](#license)

## Installation

To obtain the latest version, simply require the project using `npm`:

```shell
npm install @tvmjs/rlp
```

Install with `-g` if you want to use the CLI.

## Usage

```ts
// ./examples/simple.ts

import assert from 'assert'
import { RLP } from '@tvmjs/rlp'

const nestedList = [[], [[]], [[], [[]]]]
const encoded = RLP.encode(nestedList)
const decoded = RLP.decode(encoded)
assert.deepStrictEqual(decoded, nestedList, 'decoded output does not match original')
console.log('assert.deepStrictEqual would have thrown if the decoded output did not match')

```

## Browser

We provide hybrid ESM/CJS builds for all our libraries. With the v10 breaking release round from Spring 2025, all libraries are "pure-JS" by default and we have eliminated all hard-wired WASM code. Additionally we have substantially lowered the bundle sizes, reduced the number of dependencies, and cut out all usages of Node.js-specific primitives (like the Node.js event emitter).

It is easily possible to run a browser build of one of the TVMJS libraries within a modern browser using the provided ESM build. For a setup example see [./examples/browser.html](./examples/browser.html).

## API

`RLP.encode(plain)` - RLP encodes an `Array`, `Uint8Array` or `String` and returns a `Uint8Array`.

`RLP.decode(encoded, [stream=false])` - Decodes an RLP encoded `Uint8Array`, `Array` or `String` and returns a `Uint8Array` or `NestedUint8Array`. If `stream` is enabled, it will just decode the first rlp sequence in the Uint8Array. By default, it would throw an error if there are more bytes in Uint8Array than used by the rlp sequence.

## CLI

`rlp encode <JSON string>`\
`rlp decode <0x-prefixed hex string>`

### Examples

- `rlp encode '5'` -> `0x05`
- `rlp encode '[5]'` -> `0xc105`
- `rlp encode '["cat", "dog"]'` -> `0xc88363617483646f67`
- `rlp decode 0xc88363617483646f67` -> `["cat","dog"]`

## Upstream

This package is part of the [TVMJS](https://github.com/tronweb3/tvmjs-monorepo) project, a TypeScript implementation of the TRON Virtual Machine (TVM) forked from the [EthereumJS](https://github.com/ethereumjs/ethereumjs-monorepo) monorepo. We gratefully acknowledge the EthereumJS team for building and maintaining the original implementation.

For development information, see the [developer docs](../../DEVELOPER.md) and our [code of conduct](../../CODE_OF_CONDUCT.md).
## License

[MPL-2.0](<https://tldrlegal.com/license/mozilla-public-license-2.0-(mpl-2)>)

This package is derived from the original [@ethereumjs](https://github.com/ethereumjs/ethereumjs-monorepo) implementation, licensed under MPL-2.0. All original source files retain their MPL-2.0 license.
