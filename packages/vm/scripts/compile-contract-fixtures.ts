import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const compilerPath = process.argv[2]
if (!compilerPath) throw new Error('Usage: npm run fixtures:compile -- /path/to/soljson.cjs')

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const compilerSha256 = 'cb71022d1132a3596f6e3b5341fa093dedfc753d6929bea6d7192d88c66a210f'
if (sha256(readFileSync(compilerPath)) !== compilerSha256) {
  throw new Error('Expected the pinned TRON solc 0.8.11 compiler artifact')
}
const require = createRequire(import.meta.url)
const wrapper = require('solc/wrapper') as (input: unknown) => {
  version(): string
  compile(input: string): string
}
const compiler = wrapper(require(resolve(compilerPath)))
const version = compiler.version()
if (!version.startsWith('0.8.11+commit.b01f3284')) throw new Error(`Unexpected compiler: ${version}`)

const settings = {
  optimizer: { enabled: true, runs: 200 },
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } },
}
const contracts = [
  ['batchvalidatesign001.sol', 'Demo'],
  ['ecrecover001.sol', 'EcrecoverCheck'],
  ['validatemultisign001.sol', 'validatemultisignTest'],
].map(([fileName, contractName]) => {
  const content = readFileSync(new URL(`../test/api/tvm/solidityCode/${fileName}`, import.meta.url), 'utf8')
  const output = JSON.parse(compiler.compile(JSON.stringify({ language: 'Solidity', sources: { [fileName]: { content } }, settings })))
  const errors = output.errors?.filter((error: { severity: string }) => error.severity === 'error')
  if (errors?.length) throw new Error(JSON.stringify(errors))
  const contract = output.contracts[fileName][contractName]
  return { fileName, contractName, sourceSha256: sha256(content), bytecode: contract.evm.bytecode.object, abi: contract.abi }
})

writeFileSync(new URL('../test/api/tvm/solidityCode/compiled.json', import.meta.url), JSON.stringify({
  compiler: { version, sha256: compilerSha256, url: 'https://tronprotocol.github.io/solc-bin/wasm/soljson-v0.8.11%2Bcommit.b01f3284.js' },
  settings,
  contracts,
}, null, 2) + '\n')
