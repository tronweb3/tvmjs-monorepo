[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / bytesToHex

# Function: bytesToHex()

> **bytesToHex**(`bytes`): `` `0x${string}` ``

Defined in: packages/util/src/bytes.ts:42

Converts a Uint8Array to a [PrefixedHexString](../type-aliases/PrefixedHexString.md)

## Parameters

### bytes

`Uint8Array`

the bytes to convert

## Returns

`` `0x${string}` ``

the hex string

## Dev

Returns `0x` if provided an empty Uint8Array
