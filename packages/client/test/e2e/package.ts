/**
 * What a caller receives from the registry: the tarball `npm pack` produces,
 * installed into a project of its own and exercised the four ways a caller
 * reaches it — `require`, `import`, the `tvmjs` command and the type
 * declarations. The suite beside this one runs against `src/`, so nothing in it
 * covers the build output, the `exports` map or the `bin` entry.
 *
 * Needs the network for external dependencies. Internal dependencies are packed
 * from this workspace so the check can run before the release is published.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PUBLIC_SURFACE } from '../publicSurface.ts'

const pkg = resolve(import.meta.dirname, '../..')
const root = resolve(pkg, '../..')
const workspace = mkdtempSync(join(tmpdir(), 'tvmjs-e2e-'))
let failures = 0

interface PackageManifest {
  name: string
  dependencies?: Record<string, string>
}

const step = (name: string): ((detail: string) => void) => {
  process.stdout.write(`${name.padEnd(48)}`)
  return (detail: string) => console.log(detail)
}
const fail = (name: string, why: string): void => {
  failures += 1
  console.log(`\n  ✗ ${name}\n    ${why}`)
}
const run = (command: string, args: string[], cwd: string): { code: number; out: string } => {
  const done = spawnSync(command, args, { cwd, encoding: 'utf8' })
  return { code: done.status ?? 1, out: `${done.stdout ?? ''}${done.stderr ?? ''}` }
}
const manifest = (path: string): PackageManifest =>
  JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as PackageManifest

/** Internal dependency packages in build order, followed by the client itself. */
const packageOrder = (): string[] => {
  const packagePaths = new Map<string, string>()
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, 'packages', entry.name)
    try {
      const { name } = manifest(path)
      if (name.startsWith('@tvmjs/')) packagePaths.set(name, path)
    } catch {
      // A workspace directory without a package manifest is not publishable.
    }
  }

  const ordered: string[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (path: string): void => {
    const current = manifest(path)
    if (visited.has(current.name)) return
    if (visiting.has(current.name)) throw new Error(`Circular dependency at ${current.name}`)
    visiting.add(current.name)
    for (const dependency of Object.keys(current.dependencies ?? {})) {
      const dependencyPath = packagePaths.get(dependency)
      if (dependencyPath !== undefined) visit(dependencyPath)
    }
    visiting.delete(current.name)
    visited.add(current.name)
    ordered.push(path)
  }
  visit(pkg)
  return ordered
}
/** a port the kernel just handed out and let go of again */
const freePort = async (): Promise<number> =>
  new Promise((settle) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => settle(port))
    })
  })
const reachable = async (url: string): Promise<Response | undefined> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await fetch(url)
    } catch {
      await new Promise((wake) => setTimeout(wake, 200))
    }
  }
  return undefined
}

// ---- clean, build and pack, the way publishing does ----
let note = step('clean build + pack')
const packagePaths = packageOrder()
const tarballs: string[] = []
let tarball = ''
for (const packagePath of packagePaths) {
  const packageName = manifest(packagePath).name
  const cleaned = run('npm', ['run', 'clean'], packagePath)
  if (cleaned.code !== 0) {
    fail(`clean ${packageName}`, cleaned.out.slice(-600))
    process.exit(1)
  }
  const built = run('npm', ['run', 'build'], packagePath)
  if (built.code !== 0) {
    fail(`build ${packageName}`, built.out.slice(-600))
    process.exit(1)
  }
  const packed = run('npm', ['pack', '--pack-destination', workspace, '--silent'], packagePath)
  const packedName = packed.out.trim().split('\n').pop() ?? ''
  if (packed.code !== 0 || packedName === '') {
    fail(`pack ${packageName}`, packed.out.slice(-600))
    process.exit(1)
  }
  const packedPath = join(workspace, packedName)
  tarballs.push(packedPath)
  if (packagePath === pkg) tarball = packedName
}
if (tarball === '') {
  fail('pack', 'the client tarball was not produced')
  process.exit(1)
}
note(`${tarball} + ${tarballs.length - 1} workspace dependencies`)

// ---- what the tarball carries ----
note = step('tarball holds the built entry points')
const listed = run('tar', ['tzf', join(workspace, tarball)], workspace).out
for (const entry of [
  'package/dist/cjs/index.js',
  'package/dist/cjs/index.d.ts',
  'package/dist/esm/index.js',
  'package/dist/esm/index.d.ts',
  'package/bin/cli.mjs',
  'package/src/index.ts',
]) {
  if (!listed.includes(entry)) fail('tarball', `${entry} is not in the package`)
}
note('dist/cjs, dist/esm, bin, src')

// ---- install it into a project of its own ----
note = step('install into a fresh project')
const install = join(workspace, 'consumer')
run('mkdir', ['-p', install], workspace)
run('npm', ['init', '-y'], install)
const added = run('npm', ['install', ...tarballs, '--silent'], install)
if (added.code !== 0) {
  fail('install', added.out.slice(-600))
  process.exit(1)
}
note(install)

// ---- both builds against the surface the package promises ----
note = step('require() and import() carry the whole surface')
const exposed = (label: string, args: string[]): string[] => {
  const printed = run('node', args, install)
  if (printed.code !== 0) {
    fail(label, printed.out.slice(-400))
    return PUBLIC_SURFACE
  }
  return JSON.parse(printed.out.trim()) as string[]
}
const surfaces: [string, string[]][] = [
  [
    'require',
    exposed('require', [
      '-e',
      "console.log(JSON.stringify(Object.keys(require('@tvmjs/client')).sort()))",
    ]),
  ],
  [
    'import',
    exposed('import', [
      '--input-type=module',
      '-e',
      "import * as api from '@tvmjs/client'; console.log(JSON.stringify(Object.keys(api).sort()))",
    ]),
  ],
]
for (const [label, names] of surfaces) {
  const missing = PUBLIC_SURFACE.filter((name) => !names.includes(name))
  const extra = names.filter((name) => !PUBLIC_SURFACE.includes(name))
  if (missing.length > 0) fail(label, `the build drops ${missing.join(', ')}`)
  if (extra.length > 0) fail(label, `the build adds ${extra.join(', ')}`)
}
note(`${PUBLIC_SURFACE.length} names, both builds`)

// ---- import, and a chain that answers over HTTP ----
note = step('import() serves a chain over HTTP')
writeFileSync(
  join(install, 'esm.mjs'),
  `import { TronNode, TronProvider, startHttpServer } from '@tvmjs/client'
const lines = []
const node = await TronNode.create({ runtime: { logger: { log: (line) => lines.push(line) } } })
if (lines.length !== 1 || !lines[0].endsWith('Produced block number=1 txs=0')) throw new Error('Missing initial block log')
const started = await startHttpServer(new TronProvider(node), { port: 0 })
const block = await (await fetch(\`\${started.url}/wallet/getnowblock\`)).json()
console.log(block.block_header.raw_data.number)
started.server.close()
`,
)
const esm = run('node', ['esm.mjs'], install)
const head = Number(esm.out.trim())
if (esm.code !== 0) fail('import', esm.out.slice(-400))
else if (!Number.isSafeInteger(head) || head < 1) {
  fail('import', `head number ${JSON.stringify(esm.out.trim())}`)
}
note(`head block ${esm.out.trim()}`)

// ---- the declarations a TypeScript caller compiles against ----
note = step('type declarations resolve and hold')
const compiles = `import { TronNode, TronProvider } from '@tvmjs/client'
import type { AdminApi, ClientConfig, DebugApi, NodeAccounts, NodeBlock, TreApi } from '@tvmjs/client'
const config: ClientConfig = { runtime: { logger: { log: (line: string) => {} } } }
export const node = TronNode.create(config)
export const defaultNode = TronNode.create()
export async function query() {
  const started = await node
  const provider = new TronProvider(started)
  const associated: TronNode = provider.node
  const pending = await provider.request({ method: 'wallet/getpendingsize' })
  const size: number = pending.pendingSize
  const block: NodeBlock = await started.tre.mine()
  const tre: TreApi = started.tre
  const admin: AdminApi = started.admin
  const debug: DebugApi = started.debug
  const accounts: NodeAccounts = await started.admin.accounts()
  const privateKey: string = accounts.privateKeys[0]
  const mined: NodeBlock = await tre.mine(2)
  const generated: NodeAccounts = await admin.temporaryAccountsGeneration({ accounts: 2 })
  await tre.blockTime(0)
  await admin.accountsGeneration()
  const trace = await debug.traceTransaction('0x' + '00'.repeat(32))
  const failed: boolean = trace.failed
  return provider.request({ method: 'wallet/getnowblock' })
}
`
/** a declaration that resolved to nothing would let this through */
const contradicts = `import { TronNode } from '@tvmjs/client'
export const wrong: number = TronNode.create()
`
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
for (const mode of ['nodenext', 'node16', 'bundler']) {
  writeFileSync(
    join(install, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: mode === 'bundler' ? 'esnext' : mode,
        moduleResolution: mode,
        target: 'es2022',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      files: ['consumer.ts'],
    }),
  )
  writeFileSync(join(install, 'consumer.ts'), compiles)
  const typed = run('node', [tsc, '-p', '.'], install)
  if (typed.code !== 0) fail(`types (${mode})`, typed.out.slice(-400))

  writeFileSync(join(install, 'consumer.ts'), contradicts)
  const caught = run('node', [tsc, '-p', '.'], install)
  if (caught.code === 0) {
    fail(`types (${mode})`, 'a type error went unreported: the declarations are not being read')
  }
}
note('nodenext, node16, bundler')

// ---- the command the package installs ----
note = step('the installed command serves')
const bin = join(install, 'node_modules', '.bin', 'tvmjs')
let resolved: string | undefined
try {
  resolved = realpathSync(bin)
} catch {
  resolved = undefined
}
if (resolved === undefined) fail('cli', `the package installed no command at ${bin}`)
else if (!resolved.startsWith(realpathSync(install))) {
  fail('cli', `the command resolves outside the install: ${resolved}`)
}
const genesis = join(install, 'genesis.json')
const DELAY_DAYS = 3
writeFileSync(genesis, JSON.stringify({ chainParameters: { unfreezeDelayDays: DELAY_DAYS } }))
const port = await freePort()
const cli = spawn(resolved ?? bin, ['--port', String(port), '--init', genesis], {
  cwd: install,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let banner = ''
cli.stdout.on('data', (chunk: Buffer) => {
  banner += chunk.toString()
})
cli.stderr.on('data', (chunk: Buffer) => {
  banner += chunk.toString()
})
try {
  const answered = await reachable(`http://127.0.0.1:${port}/wallet/getnowblock`)
  if (answered === undefined) fail('cli', `nothing answered on ${port}\n${banner.slice(-400)}`)
  else {
    if (
      answered.headers.get('server') !==
      `tvmjs/${JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version}`
    ) {
      fail('cli', `Server header reads ${answered.headers.get('server')}`)
    }
    // the genesis file reached the built code: a parameter it named is in force
    const parameters = (await (
      await fetch(`http://127.0.0.1:${port}/wallet/getchainparameters`)
    ).json()) as { chainParameter: { key: string; value?: number }[] }
    const delay = parameters.chainParameter.find((one) => one.key === 'getUnfreezeDelayDays')
    if (delay?.value !== DELAY_DAYS)
      fail('cli --init', `getUnfreezeDelayDays reads ${delay?.value}`)
    if (!banner.includes('Available Accounts')) fail('cli', 'the banner named no accounts')
  }
} finally {
  cli.kill('SIGKILL')
}
note(`port ${port}, --init in force`)

rmSync(workspace, { recursive: true, force: true })
console.log(
  failures === 0
    ? '\n✓ the packaged client installs, imports, types and runs'
    : `\n✗ ${failures} check${failures === 1 ? '' : 's'} failed`,
)
process.exit(failures === 0 ? 0 : 1)
