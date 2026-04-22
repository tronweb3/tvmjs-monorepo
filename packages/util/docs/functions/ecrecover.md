[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / ecrecover

# Function: ecrecover()

> **ecrecover**(`msgHash`, `v`, `r`, `s`, `chainId?`): `Uint8Array`

Defined in: packages/util/src/signature.ts:45

ECDSA public key recovery from signature.
NOTE: Accepts `v === 0 | v === 1` for EIP1559 transactions

## Parameters

### msgHash

`Uint8Array`

### v

`bigint`

### r

`Uint8Array`

### s

`Uint8Array`

### chainId?

`bigint`

## Returns

`Uint8Array`

Recovered public key
