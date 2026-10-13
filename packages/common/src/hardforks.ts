import { Hardfork } from './enums.ts'
import { tronExecutionProfile } from './profiles.ts'

import type { HardforksDict } from './types.ts'

/** TRON execution definitions, independent of Ethereum upgrade schedules. */
export const tronHardforksDict: HardforksDict = {
  [Hardfork.Tron]: { eips: [...tronExecutionProfile.eips] },
}

export const hardforksDict = tronHardforksDict
