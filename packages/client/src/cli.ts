import { readFileSync } from 'node:fs'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { CLIENT_VERSION, parseInitialConfig } from './config.ts'
import { TronNode } from './node.ts'
import { TronProvider } from './provider.ts'
import { startHttpServer } from './transport/httpServer.ts'

import type { InitialConfigInput } from './config.ts'

const NAME_VERSION = `TVMJS v${CLIENT_VERSION}`
const IDENTITY = `${NAME_VERSION} - a TRON dev node`

/** one row per flag; the parser options and the help text both derive from it */
interface Flag {
  long: string
  short?: string
  value?: string
  desc: string
  preset?: string
}

const FLAGS: readonly Flag[] = [
  { long: 'port', short: 'p', value: '<port>', desc: 'HTTP port to listen on', preset: '9090' },
  {
    long: 'host',
    value: '<host>',
    desc: "Address to bind; '*' binds all interfaces",
    preset: '127.0.0.1',
  },
  {
    long: 'init',
    value: '<file>',
    desc: "Initialize the chain's birth state with the given JSON file",
  },
  { long: 'help', short: 'h', desc: 'Print help' },
  { long: 'version', short: 'v', desc: 'Print version' },
]

function flagLabel(flag: Flag): string {
  const short = flag.short === undefined ? '    ' : `-${flag.short}, `
  const value = flag.value === undefined ? '' : ` ${flag.value}`
  return `${short}--${flag.long}${value}`
}

function usage(): string {
  const width = Math.max(...FLAGS.map((flag) => flagLabel(flag).length))
  const lines = FLAGS.map((flag) => {
    const preset = flag.preset === undefined ? '' : ` (default: ${flag.preset})`
    return `  ${flagLabel(flag).padEnd(width)}  ${flag.desc}${preset}`
  })
  return `${IDENTITY}\n\nUsage: tvmjs [options]\n\nOptions:\n${lines.join('\n')}\n`
}

function parseCliArgs(argv: string[]) {
  const options: Record<string, { type: 'string' | 'boolean'; short?: string; default?: string }> =
    {}
  for (const flag of FLAGS) {
    options[flag.long] = {
      type: flag.value === undefined ? 'boolean' : 'string',
      ...(flag.short === undefined ? {} : { short: flag.short }),
      ...(flag.preset === undefined ? {} : { default: flag.preset }),
    }
  }
  return parseArgs({ args: argv, options }).values as {
    port: string
    host: string
    init?: string
    help?: boolean
    version?: boolean
  }
}

/** a refusal of user input or environment; anything else is a bug and keeps its stack */
class CliError extends Error {
  readonly hint: string | undefined
  readonly origin: string | undefined
  constructor(message: string, hint?: string, origin?: string) {
    super(message)
    this.hint = hint
    this.origin = origin
  }
}

function fail(refusal: CliError): void {
  if (refusal.origin === undefined) {
    console.error(`Error: ${refusal.message}`)
  } else {
    console.error(`Error: ${refusal.origin}`)
    console.error(refusal.message)
  }
  if (refusal.hint !== undefined) {
    console.error(refusal.hint)
  }
  console.error('')
  console.error(NAME_VERSION)
  process.exitCode = 1
}

export function reportUnexpected(err: unknown): void {
  console.error('An unexpected error occurred:')
  console.error(err)
  console.error('')
  console.error(NAME_VERSION)
  process.exitCode = 1
}

/** Read the initial state using the same parser as programmatic startup. */
function readInitFile(path: string): InitialConfigInput {
  const refuse: (message: string) => never = (message) => {
    throw new CliError(message, undefined, `--init ${path}`)
  }

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    const fault = err as NodeJS.ErrnoException
    // the human phrase sits between the code and the syscall in libuv messages
    const phrase =
      fault.code === undefined || fault.syscall === undefined
        ? fault.message
        : fault.message.slice(`${fault.code}: `.length).split(`, ${fault.syscall}`)[0]
    return refuse(`${phrase}${fault.code === undefined ? '' : ` (${fault.code})`}`)
  }
  let held: unknown
  try {
    held = JSON.parse(text)
  } catch (err) {
    return refuse(`Not valid JSON: ${(err as Error).message}`)
  }
  return parseInitialConfig(held)
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  let values: ReturnType<typeof parseCliArgs>
  try {
    values = parseCliArgs(argv)
  } catch (err) {
    return fail(new CliError((err as Error).message, "Try 'tvmjs --help'"))
  }

  if (values.help === true) {
    console.log(usage())
    return
  }
  if (values.version === true) {
    console.log(CLIENT_VERSION)
    return
  }

  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return fail(new CliError(`Invalid value "${values.port}" for --port`))
  }

  let node: TronNode
  try {
    const initial = values.init === undefined ? {} : readInitFile(values.init)
    node = await TronNode.create({ ...initial, runtime: { logger: console } })
  } catch (err) {
    return fail(
      err instanceof CliError
        ? err
        : new CliError(
            (err as Error).message,
            undefined,
            values.init === undefined ? undefined : `--init ${values.init}`,
          ),
    )
  }
  const provider = new TronProvider(node)
  let boundPort: number
  try {
    ;({ port: boundPort } = await startHttpServer(provider, {
      port,
      host: values.host,
    }))
  } catch (err) {
    // listen-time system errors (EADDRINUSE, EACCES, ENOTFOUND) are refusals
    if (err instanceof Error && 'syscall' in err) {
      return fail(new CliError(err.message))
    }
    throw err
  }

  console.log(IDENTITY)
  console.log('')
  const accounts = await provider.request({ method: 'admin/accounts' })
  console.log(accounts.trimEnd())
  console.log('')
  console.log(`Listening on ${values.host}:${boundPort}`)
  console.log('')
}
