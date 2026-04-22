[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / blobsToCommitments

# Function: blobsToCommitments()

> **blobsToCommitments**(`kzg`, `blobs`): `` `0x${string}` ``[]

Defined in: packages/util/src/blobs.ts:96

EIP-4844: Computes KZG commitments for a set of blobs.

## Parameters

### kzg

[`KZG`](../interfaces/KZG.md)

KZG implementation used to compute commitments

### blobs

`` `0x${string}` ``[]

Array of blob data as hex-prefixed strings

## Returns

`` `0x${string}` ``[]

Array of lowercase hex-prefixed KZG commitments (one per blob)
