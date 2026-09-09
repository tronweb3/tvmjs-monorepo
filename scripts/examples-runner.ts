import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const pkg = process.argv[3]
if (!pkg) {
  throw new Error('Package argument must be passed')
}
const subDir = process.argv[4] ?? ''

const examplesPath = `../packages/${pkg}/examples/${subDir}/`
const path = join(__dirname, examplesPath)

const runExample = (fileName: string): Promise<void> => {
  const examplePath = join(path, fileName)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', examplePath], {
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      const reason = signal === null ? `exit code ${code}` : `signal ${signal}`
      reject(new Error(`Example ${fileName} failed with ${reason}`))
    })
  })
}

const main = async () => {
  const files = readdirSync(path)
    .filter((file) => extname(file) === '.cts' || extname(file) === '.ts')
    .sort()
  for (const file of files) {
    console.log(` ---- Run example: ${file} ----`)
    await runExample(file)
  }
}

void main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
