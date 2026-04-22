[**@tvmjs/vm**](../README.md)

***

[@tvmjs/vm](../README.md) / RunTxOpts

# Interface: RunTxOpts

Defined in: vm/src/types.ts:386

Options for the `runTx` method.

## Properties

### block?

> `optional` **block**: `Block`

Defined in: vm/src/types.ts:391

The `@tvmjs/block` the `tx` belongs to.
If omitted, a default blank block will be used.

***

### blockGasUsed?

> `optional` **blockGasUsed**: `bigint`

Defined in: vm/src/types.ts:439

To obtain an accurate tx receipt input the block gas used up until this tx.

***

### reportAccessList?

> `optional` **reportAccessList**: `boolean`

Defined in: vm/src/types.ts:428

If true, adds a generated EIP-2930 access list
to the `RunTxResult` returned.

Option works with all tx types. EIP-2929 needs to
be activated (included in `berlin` HF).

Note: if this option is used with a custom StateManager implementation
StateManager.generateAccessList must be implemented.

***

### reportPreimages?

> `optional` **reportPreimages**: `boolean`

Defined in: vm/src/types.ts:434

If true, adds a hashedKey -> preimages mapping of all touched accounts
to the `RunTxResult` returned.

***

### skipBalance?

> `optional` **skipBalance**: `boolean`

Defined in: vm/src/types.ts:404

Skip balance checks if true. Adds transaction cost to balance to ensure execution doesn't fail.

***

### skipBlockGasLimitValidation?

> `optional` **skipBlockGasLimitValidation**: `boolean`

Defined in: vm/src/types.ts:410

If true, skips the validation of the tx's gas limit
against the block's gas limit.

***

### skipHardForkValidation?

> `optional` **skipHardForkValidation**: `boolean`

Defined in: vm/src/types.ts:416

If true, skips the hardfork validation of vm, block
and tx

***

### skipNonce?

> `optional` **skipNonce**: `boolean`

Defined in: vm/src/types.ts:399

If true, skips the nonce check

***

### tx

> **tx**: `TypedTransaction`

Defined in: vm/src/types.ts:395

An `@tvmjs/tx` to run
