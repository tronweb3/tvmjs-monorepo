import {
  eip4844GethGenesis,
  goerliGethGenesis,
  invalidSpuriousDragonGethGenesis,
  kilnGethGenesis,
  postMergeGethGenesis,
  shanghaiTimeGethGenesis,
} from '@tvmjs/testdata'
import { assert, describe, it } from 'vitest'

import { parseGethGenesisState } from '../src/gethGenesis.ts'
import { Common, Hardfork, parseGethGenesis } from '../src/index.ts'

describe('[Common/genesis]', () => {
  it('parses the historical deposit contract allocation without executing it', () => {
    const genesisState = parseGethGenesisState(kilnGethGenesis)
    // just check for deposit contract inclusion
    assert.exists(genesisState['0x4242424242424242424242424242424242424242'][1])
    assert.strictEqual(
      genesisState['0x4242424242424242424242424242424242424242'][1].includes(
        // sample data check
        '0x60806040526004361061003',
      ),
      true,
      'should have deposit contract',
    )
  })

  it('normalizes allocation data while preserving balances above the safe integer range', () => {
    const genesis = {
      ...postMergeGethGenesis,
      alloc: {
        '00000000000000000000000000000000000000aB': {
          balance: '9007199254740993',
          code: '6000',
          nonce: '0a',
          storage: { '00': '01', '0x02': '0x03' },
        },
        '0x00000000000000000000000000000000000000CD': { balance: '0x10' },
      },
    }
    const before = JSON.stringify(genesis)
    assert.deepEqual(parseGethGenesisState(genesis), {
      '0x00000000000000000000000000000000000000ab': [
        '0x20000000000001',
        '0x6000',
        [
          ['0x00', '0x01'],
          ['0x02', '0x03'],
        ],
        '0x0a',
      ],
      '0x00000000000000000000000000000000000000cd': ['0x10', undefined, undefined, undefined],
    })
    assert.strictEqual(JSON.stringify(genesis), before)
  })
})

describe('[Utils/Parse]', () => {
  it('should parse geth params file', () => {
    // This historical fixture exercises raw data parsing, not Blob execution.
    const params = parseGethGenesis(eip4844GethGenesis)
    assert.strictEqual(
      params.genesis.nonce,
      '0x0000000000000042',
      'nonce should be correctly formatted',
    )
  })

  it('should throw with invalid Spurious Dragon blocks', () => {
    const f = () => {
      parseGethGenesis(invalidSpuriousDragonGethGenesis, 'bad_params')
    }
    assert.throws(f, undefined, undefined, 'should throw')
  })

  it('should import poa network params correctly', () => {
    let params = parseGethGenesis(goerliGethGenesis, 'poa')
    assert.strictEqual(params.genesis.nonce, '0x0000000000000000', 'nonce is formatted correctly')
    assert.deepEqual(
      params.consensus,
      { type: 'poa', algorithm: 'clique', clique: { period: 15, epoch: 30000 } },
      'consensus config matches',
    )
    const poaCopy = Object.assign({}, goerliGethGenesis)
    poaCopy.nonce = '00'
    params = parseGethGenesis(poaCopy, 'poa')
    assert.strictEqual(
      params.genesis.nonce,
      '0x0000000000000000',
      'non-hex prefixed nonce is formatted correctly',
    )
    assert.strictEqual(
      params.hardfork,
      Hardfork.Istanbul,
      'should correctly infer current hardfork',
    )
  })

  it('preserves an explicit base fee in raw genesis data', () => {
    const params = parseGethGenesis(postMergeGethGenesis, 'post-merge')
    assert.strictEqual(params.genesis.baseFeePerGas, postMergeGethGenesis.baseFeePerGas)
  })

  it('should successfully parse genesis file with no extraData', () => {
    const params = parseGethGenesis({ ...postMergeGethGenesis, extraData: '' }, 'noExtraData')
    assert.strictEqual(params.genesis.extraData, '0x', 'extraData set to 0x')
    assert.strictEqual(params.genesis.nonce, '0x0000000000000042', 'nonce parsed correctly')
  })

  it('rejects Ethereum genesis as an execution configuration', () => {
    for (const genesis of [eip4844GethGenesis, goerliGethGenesis, postMergeGethGenesis]) {
      const chain = parseGethGenesis(genesis)
      assert.notProperty(chain, 'execution')
      assert.throws(
        // @ts-expect-error Raw Ethereum network data is not an execution configuration.
        () => new Common({ chain }),
        /Only TRON execution configurations/,
      )
      assert.throws(
        () =>
          new Common({
            // @ts-expect-error Selecting TRON options does not make Ethereum data executable.
            chain,
            hardfork: Hardfork.Tron,
            activatedProposals: [95, 96],
          }),
        /Only TRON execution configurations/,
      )
    }
  })

  it.each(['cancun', 'prague', 'tron', 'unknown', 'empty'])(
    'explicitly rejects a %s blob schedule in raw data parsing',
    (name) => {
      const blobSchedule =
        name === 'empty' ? {} : { [name]: { target: 3, max: 6, baseFeeUpdateFraction: 3338477 } }
      const genesis = {
        ...postMergeGethGenesis,
        config: { ...postMergeGethGenesis.config, blobSchedule },
      }
      const message = /blobSchedule is not supported by TRON configuration parsing/
      assert.throws(() => parseGethGenesis(genesis), message)
    },
  )

  it('preserves timestamp schedules as raw data without mutating the input', () => {
    const genesis = {
      ...shanghaiTimeGethGenesis,
      config: {
        ...shanghaiTimeGethGenesis.config,
        cancunTime: shanghaiTimeGethGenesis.config.shanghaiTime! + 1000,
      },
    }
    const before = JSON.stringify(genesis)
    const parsed = parseGethGenesis(genesis, 'raw-timestamp-data')
    assert.strictEqual(parsed.name, 'raw-timestamp-data')
    assert.strictEqual(parsed.hardfork, Hardfork.Cancun)
    assert.deepEqual(parsed.hardforks.slice(-2), [
      { name: Hardfork.Shanghai, block: null, timestamp: genesis.config.shanghaiTime! },
      { name: Hardfork.Cancun, block: null, timestamp: genesis.config.cancunTime },
    ])
    assert.notProperty(parsed, 'execution')
    assert.strictEqual(JSON.stringify(genesis), before)
  })
})
