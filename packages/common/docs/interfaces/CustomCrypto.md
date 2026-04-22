[**@tvmjs/common**](../README.md)

***

[@tvmjs/common](../README.md) / CustomCrypto

# Interface: CustomCrypto

Defined in: src/types.ts:76

## Properties

### ecdsaRecover()?

> `optional` **ecdsaRecover**: (`sig`, `recId`, `hash`) => `Uint8Array`

Defined in: src/types.ts:90

#### Parameters

##### sig

`Uint8Array`

##### recId

`number`

##### hash

`Uint8Array`

#### Returns

`Uint8Array`

***

### ecrecover()?

> `optional` **ecrecover**: (`msgHash`, `v`, `r`, `s`, `chainId?`) => `Uint8Array`

Defined in: src/types.ts:81

#### Parameters

##### msgHash

`Uint8Array`

##### v

`bigint`

##### r

`Uint8Array`

##### s

`Uint8Array`

##### chainId?

`bigint`

#### Returns

`Uint8Array`

***

### ecsign()?

> `optional` **ecsign**: (`message`, `secretKey`, `opts?`) => `Uint8Array`

Defined in: src/types.ts:89

#### Parameters

##### message

`Uint8Array`

##### secretKey

`Uint8Array`

##### opts?

`ECDSASignOpts`

#### Returns

`Uint8Array`

***

### keccak256()?

> `optional` **keccak256**: (`msg`) => `Uint8Array`

Defined in: src/types.ts:80

Interface for providing custom cryptographic primitives in place of `ethereum-cryptography` variants

#### Parameters

##### msg

`Uint8Array`

#### Returns

`Uint8Array`

***

### kzg?

> `optional` **kzg**: `KZG`

Defined in: src/types.ts:91

***

### sha256()?

> `optional` **sha256**: (`msg`) => `Uint8Array`

Defined in: src/types.ts:88

#### Parameters

##### msg

`Uint8Array`

#### Returns

`Uint8Array`
