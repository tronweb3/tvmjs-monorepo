[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / Lock

# Class: Lock

Defined in: packages/util/src/lock.ts:2

## Constructors

### Constructor

> **new Lock**(): `Lock`

#### Returns

`Lock`

## Methods

### acquire()

> **acquire**(): `Promise`\<`boolean`\>

Defined in: packages/util/src/lock.ts:10

Returns a promise used to wait for a permit to become available. This method should be awaited on.

#### Returns

`Promise`\<`boolean`\>

A promise that gets resolved when execution is allowed to proceed.

***

### release()

> **release**(): `void`

Defined in: packages/util/src/lock.ts:25

Increases the number of permits by one. If there are other functions waiting, one of them will
continue to execute in a future iteration of the event loop.

#### Returns

`void`
