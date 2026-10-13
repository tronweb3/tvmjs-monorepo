import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { assert, describe, it } from 'vitest'
import { RLP } from '../src/index.ts'
import { rlpTestData } from './fixture/rlptest.ts'

const cliPath = fileURLToPath(new URL('../bin/rlp.cjs', import.meta.url))
const runCLI = (...args: string[]) =>
  execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' }).trim()

describe('RLP CLI', () => {
  it('encodes a scalar', () => {
    assert.strictEqual(runCLI('encode', '5'), '0x05')
  })

  it('decodes a scalar to JSON', () => {
    assert.strictEqual(JSON.parse(runCLI('decode', '0x05')), '05')
  })

  it('encodes a list', () => {
    assert.strictEqual(runCLI('encode', '[5]'), '0xc105')
  })

  // The CLI takes JSON, which cannot represent the fixture's #bigint notation.
  // Those vectors remain covered by the pure RLP encoding suite.
  for (const [name, vector] of Object.entries(rlpTestData.tests)) {
    if (typeof vector.in === 'string' && vector.in.startsWith('#')) continue
    it(`encodes the official ${name} vector`, () => {
      assert.strictEqual(runCLI('encode', JSON.stringify(vector.in)), vector.out.toLowerCase())
    })
  }
})

it('encodes arrays from another Node VM context', () => {
  const encoded = runInNewContext(
    "Array.from(RLP.encode(['dog', 'god', 'cat'])).map(n => n.toString(16).padStart(2, '0')).join('')",
    { RLP },
  )
  assert.strictEqual(encoded, 'cc83646f6783676f6483636174')
})
