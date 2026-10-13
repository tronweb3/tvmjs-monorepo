import { assert, describe, it } from 'vitest'

import { resolveConfig } from '../../src/config.ts'
import { parseTronAddress } from '../../src/dialect/tron/address.ts'
import { validateForBuild } from '../../src/dialect/tron/wallet/contractAdapter.ts'
import {
  adaptWithdrawExpireUnfreeze,
  supportsMaxDelegateLockPeriod,
  transactionActivationError,
} from '../../src/dialect/tron/wallet/stake.ts'
import { INT64_MAX } from '../../src/intBounds.ts'

import type { NodeCore } from '../../src/core/node.ts'
import type { AdaptContext } from '../../src/dialect/tron/wallet/contractAdapter.ts'

describe('stake-v2 activation gates', () => {
  const withParams = (changed: Record<string, number>) => ({
    ...resolveConfig().chainParameters,
    ...changed,
  })

  it('rejects every v2-only transaction while unfreeze delay is inactive', () => {
    const inactive = withParams({ unfreezeDelayDays: 0 })
    assert.strictEqual(
      transactionActivationError(inactive, 'FreezeBalanceV2Contract'),
      'Not support FreezeV2 transaction, need to be opened by the committee',
    )
    assert.strictEqual(
      transactionActivationError(inactive, 'UnfreezeBalanceV2Contract'),
      'Not support UnfreezeV2 transaction, need to be opened by the committee',
    )
    assert.strictEqual(
      transactionActivationError(inactive, 'WithdrawExpireUnfreezeContract'),
      'Not support WithdrawExpireUnfreeze transaction, need to be opened by the committee',
    )
    assert.strictEqual(
      transactionActivationError(inactive, 'DelegateResourceContract'),
      'Not support Delegate resource transaction, need to be opened by the committee',
    )
    assert.strictEqual(
      transactionActivationError(inactive, 'UnDelegateResourceContract'),
      'Not support unDelegate resource transaction, need to be opened by the committee',
    )
    assert.strictEqual(
      transactionActivationError(inactive, 'CancelAllUnfreezeV2Contract'),
      'Not support CancelAllUnfreezeV2 transaction, need to be opened by the committee',
    )
  })

  it('keeps the resource and cancel proposal gates independent', () => {
    assert.strictEqual(
      transactionActivationError(
        withParams({ allowDelegateResource: 0 }),
        'DelegateResourceContract',
      ),
      'No support for resource delegate',
    )
    assert.strictEqual(
      transactionActivationError(
        withParams({ allowCancelAllUnfreezeV2: 0 }),
        'CancelAllUnfreezeV2Contract',
      ),
      'Not support CancelAllUnfreezeV2 transaction, need to be opened by the committee',
    )
    assert.isUndefined(transactionActivationError(withParams({}), 'FreezeBalanceV2Contract'))
  })

  it('applies an active gate while building, before adapter state is read', async () => {
    const node = {
      config: { chainParameters: withParams({ unfreezeDelayDays: 0 }) },
    } as NodeCore
    assert.strictEqual(
      await validateForBuild(node, 'DelegateResourceContract', {}),
      'Not support Delegate resource transaction, need to be opened by the committee',
    )
  })

  it('only enables caller-chosen delegation lock periods above the original period', () => {
    assert.isFalse(
      supportsMaxDelegateLockPeriod(
        withParams({ maxDelegateLockPeriod: 86_400, unfreezeDelayDays: 14 }),
      ),
    )
    assert.isTrue(supportsMaxDelegateLockPeriod(withParams({ maxDelegateLockPeriod: 86_401 })))
  })

  it('uses the runtime checkedAdd overflow wording for an expired-unfreeze withdrawal', async () => {
    const caller = parseTronAddress('4171b0af54e0a1182a5e0947d6a64f3b22740ef318')
    const adapted = adaptWithdrawExpireUnfreeze({ caller } as AdaptContext)
    if ('error' in adapted || adapted.validate === undefined) throw new Error('expected an adapter')
    const node = {
      getAccount: async () => ({}),
      withdrawableAt: () => 1n,
      head: () => ({ timestampMs: 0 }),
      getBalance: async () => INT64_MAX,
    } as unknown as NodeCore
    assert.strictEqual(await adapted.validate(node), 'long overflow')
  })
})
