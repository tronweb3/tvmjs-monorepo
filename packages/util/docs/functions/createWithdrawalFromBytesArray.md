[**@tvmjs/util**](../README.md)

***

[@tvmjs/util](../README.md) / createWithdrawalFromBytesArray

# Function: createWithdrawalFromBytesArray()

> **createWithdrawalFromBytesArray**(`withdrawalArray`): [`Withdrawal`](../classes/Withdrawal.md)

Defined in: packages/util/src/withdrawal.ts:127

Creates a validator withdrawal request to be submitted to the consensus layer from
an RLP list

## Parameters

### withdrawalArray

[`WithdrawalBytes`](../type-aliases/WithdrawalBytes.md)

decoded RLP list of withdrawal data elements

## Returns

[`Withdrawal`](../classes/Withdrawal.md)

a [Withdrawal](../classes/Withdrawal.md) object
