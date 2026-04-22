[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / bytesToUnprefixedHex

# ~~Variable: bytesToUnprefixedHex()~~

> `const` **bytesToUnprefixedHex**: (`bytes`) => `string` = `bytesToUnprefixedHexNoble`

Defined in: packages/util/src/bytes.ts:18

Convert byte array to hex string. Uses built-in function, when available.

## Parameters

### bytes

`Uint8Array`

## Returns

`string`

## Example

```ts
bytesToHex(Uint8Array.from([0xca, 0xfe, 0x01, 0x23])) // 'cafe0123'
```

## Deprecated
