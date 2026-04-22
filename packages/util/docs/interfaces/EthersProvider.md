[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / EthersProvider

# Interface: EthersProvider

Defined in: packages/util/src/provider.ts:105

A partial interface for an `ethers` `JSONRPCProvider`
We only use the url string since we do raw `fetch` calls to
retrieve the necessary data

## Properties

### \_getConnection()

> **\_getConnection**: () => `object`

Defined in: packages/util/src/provider.ts:106

#### Returns

`object`

##### url

> **url**: `string`
