[**@tvmjs/common**](../README.md)

***

[@tvmjs/common](../README.md) / BinaryTreeAccessedState

# Type Alias: BinaryTreeAccessedState

> **BinaryTreeAccessedState** = \{ `type`: `Exclude`\<[`BinaryTreeAccessedStateType`](BinaryTreeAccessedStateType.md), *typeof* [`Code`](../variables/BinaryTreeAccessedStateType.md#code) \| *typeof* [`Storage`](../variables/BinaryTreeAccessedStateType.md#storage)\>; \} \| \{ `codeOffset`: `number`; `type`: *typeof* [`Code`](../variables/BinaryTreeAccessedStateType.md#code); \} \| \{ `slot`: `bigint`; `type`: *typeof* [`Storage`](../variables/BinaryTreeAccessedStateType.md#storage); \}

Defined in: src/interfaces.ts:84
