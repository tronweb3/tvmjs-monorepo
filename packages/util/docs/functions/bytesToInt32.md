[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / bytesToInt32

# Function: bytesToInt32()

> **bytesToInt32**(`bytes`, `littleEndian`): `number`

Defined in: packages/util/src/bytes.ts:475

## Parameters

### bytes

`Uint8Array`

The input Uint8Array from which to read the 32-bit integer.

### littleEndian

`boolean` = `false`

True for little-endian, undefined or false for big-endian.

## Returns

`number`

The 32-bit integer read from the input Uint8Array.

## Notice

Convert a Uint8Array to a 32-bit integer
