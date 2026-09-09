#!/usr/bin/env tsx
/**
 * Simple release script for in-between releases (nightly, alpha, etc.)
 *
 * NOTE: Not applicable for official TVMJS version preparation. This script does
 * not change package versions; it only publishes package versions which do not
 * already exist in npm, under the requested tag.
 * npm does NOT allow republishing the same version even with a different tag;
 * to change the tag of an already-published version, use `npm dist-tag add`.
 * Official releases follow a manual per-package flow (npm version + npm publish).
 *
 * Usage:
 *   npm run release:simple -- <tag> [--dry-run]
 *
 * Example:
 *   npm run release:simple -- nightly --dry-run
 */

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

// Active packages from README.md
const ACTIVE_PACKAGES = [
  'binarytree',
  'block',
  'blockchain',
  'common',
  'tvm',
  'mpt',
  'rlp',
  'statemanager',
  'tx',
  'util',
  'vm',
]

interface PackageJson {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  [key: string]: unknown
}

interface PackageInfo {
  name: string
  path: string
  packageJson: PackageJson
}

interface PublishMetadata {
  name: string
  version: string
  shasum: string
  integrity: string
}

function parseArgs(): { dryRun: boolean; tag: string } {
  const args = process.argv.slice(2)

  if (
    args.length < 1 ||
    args.length > 2 ||
    (args.length === 2 && args[1] !== '--dry-run')
  ) {
    console.error('Usage: npm run release:simple -- <tag> [--dry-run]')
    console.error('Example: npm run release:simple -- latest --dry-run')
    process.exit(1)
  }

  const tag = args[0]
  if (tag.startsWith('-') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    console.error(`Invalid npm dist-tag: ${tag}`)
    console.error(
      'Tags must start with a letter or digit and contain only letters, digits, ., _, or -.',
    )
    process.exit(1)
  }

  return {
    tag,
    dryRun: args[1] === '--dry-run',
  }
}

function readPackageJson(packagePath: string): PackageJson {
  const filePath = join(packagePath, 'package.json')
  const content = readFileSync(filePath, 'utf-8')
  return JSON.parse(content) as PackageJson
}

function parseNpmJson(output: string, description: string): unknown {
  const trimmed = output.replace(/^\uFEFF/, '').trim()
  if (trimmed.length === 0) {
    throw new Error(`npm returned an empty response for ${description}`)
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    const objectStarts = [...trimmed.matchAll(/^\{/gm)].map((match) => match.index ?? 0)
    for (let index = objectStarts.length - 1; index >= 0; index--) {
      try {
        return JSON.parse(trimmed.slice(objectStarts[index]))
      } catch {
        // Try the preceding top-level JSON candidate.
      }
    }
  }

  throw new Error(`npm returned invalid JSON for ${description}`)
}

function parsePublishMetadata(output: string, packageName: string): PublishMetadata {
  const result = parseNpmJson(output, `${packageName} dry run`) as Record<
    string,
    PublishMetadata
  >
  const metadata = result[packageName]
  if (
    metadata === undefined ||
    metadata.name !== packageName ||
    typeof metadata.version !== 'string' ||
    typeof metadata.shasum !== 'string' ||
    typeof metadata.integrity !== 'string'
  ) {
    throw new Error(`npm did not return shasum and integrity for ${packageName}`)
  }
  return metadata
}

function commandErrorDetails(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return String(error)
  }
  const commandError = error as {
    message?: string
    stderr?: Buffer | string
    stdout?: Buffer | string
  }
  return [commandError.stdout, commandError.stderr, commandError.message]
    .map((value) => value?.toString().trim() ?? '')
    .filter(Boolean)
    .join('\n')
}

function isPackageVersionPublished(pkg: PackageInfo): boolean {
  const packageName = pkg.packageJson.name
  const version = pkg.packageJson.version

  let output: string
  try {
    output = execFileSync('npm', ['view', `${packageName}@${version}`, 'version', '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
      },
    })
  } catch (error: unknown) {
    const details = commandErrorDetails(error)
    if (details.includes('E404') || details.includes('404 Not Found')) {
      return false
    }
    throw new Error(`Failed to query npm for ${packageName}@${version}: ${details.trim()}`)
  }

  const publishedVersion = parseNpmJson(output, `${packageName}@${version} registry lookup`)
  if (typeof publishedVersion !== 'string') {
    throw new Error(`npm returned an unexpected version response for ${packageName}@${version}`)
  }
  return publishedVersion === version
}

function orderPackagesByDependencies(packages: PackageInfo[]): PackageInfo[] {
  const packageNames = new Set(packages.map((pkg) => pkg.packageJson.name))
  const remaining = new Set(packageNames)
  const ordered: PackageInfo[] = []

  while (remaining.size > 0) {
    let progressed = false
    for (const pkg of packages) {
      const packageName = pkg.packageJson.name
      if (!remaining.has(packageName)) continue

      const dependencies = {
        ...pkg.packageJson.dependencies,
        ...pkg.packageJson.optionalDependencies,
        ...pkg.packageJson.peerDependencies,
      }
      const unpublishedDependencies = Object.keys(dependencies).filter(
        (dependency) => packageNames.has(dependency) && remaining.has(dependency),
      )
      if (unpublishedDependencies.length === 0) {
        ordered.push(pkg)
        remaining.delete(packageName)
        progressed = true
      }
    }

    if (!progressed) {
      throw new Error(`Circular internal package dependencies: ${[...remaining].join(', ')}`)
    }
  }

  return ordered
}

function findPackagesToPublish(packages: PackageInfo[]): PackageInfo[] {
  console.log('Checking npm Registry for unpublished package versions...')
  const packagesToPublish = packages.filter((pkg) => !isPackageVersionPublished(pkg))
  console.log(
    `Found ${packagesToPublish.length} package(s) to publish; ` +
      `${packages.length - packagesToPublish.length} already published.`,
  )
  return packagesToPublish
}

function printPublishMetadataTable(metadata: PublishMetadata[]): void {
  const headers = ['Package', 'Version', 'Shasum', 'Integrity']
  const rows = metadata.map((item) => [item.name, item.version, item.shasum, item.integrity])
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  )
  const formatRow = (row: string[]) =>
    `| ${row.map((value, index) => value.padEnd(widths[index])).join(' | ')} |`

  console.log('\nPackages to be published (dry-run):\n')
  console.log(formatRow(headers))
  console.log(formatRow(widths.map((width) => '-'.repeat(width))))
  for (const row of rows) {
    console.log(formatRow(row))
  }
}

function publishPackages(packages: PackageInfo[], tag: string, dryRun: boolean): void {
  console.log(
    dryRun
      ? `\n🔍 Dry-running packages with tag "${tag}"...\n`
      : `\n🚀 Publishing packages with tag "${tag}"...\n`,
  )

  const metadataResults: PublishMetadata[] = []
  for (const pkg of packages) {
    console.log(`  ${dryRun ? 'Checking' : 'Publishing'} ${pkg.name}...`)

    try {
      if (dryRun) {
        const output = execFileSync(
          'npm',
          ['--silent', 'publish', '--access', 'public', `--tag=${tag}`, '--dry-run', '--json'],
          {
            cwd: pkg.path,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
            },
          },
        )
        const metadata = parsePublishMetadata(output, pkg.packageJson.name)
        metadataResults.push(metadata)
      } else {
        execFileSync('npm', ['publish', '--access', 'public', `--tag=${tag}`], {
          cwd: pkg.path,
          stdio: 'inherit',
          env: {
            ...process.env,
          },
        })
      }

      console.log(
        dryRun
          ? `  ✅ ${pkg.name} dry run completed\n`
          : `  ✅ ${pkg.name} published successfully\n`,
      )
    } catch (error) {
      console.error(`  ❌ Failed to ${dryRun ? 'check' : 'publish'} ${pkg.name}`)
      if (!dryRun) {
        console.error(
          '  Fix the failure and rerun the same command; published versions are skipped.',
        )
      }
      throw error
    }
  }

  if (dryRun) {
    printPublishMetadataTable(metadataResults)
  }
  console.log(dryRun ? '\n✅ Dry run completed\n' : '\n✅ All packages published\n')
}

async function main(): Promise<void> {
  const { tag, dryRun } = parseArgs()

  console.log('\n' + '='.repeat(60))
  console.log('Simple Release Script')
  console.log('='.repeat(60))
  console.log(`Tag: ${tag}`)
  console.log(`Dry run: ${dryRun}`)
  console.log('='.repeat(60) + '\n')

  const rootPath = process.cwd()
  const packagesPath = join(rootPath, 'packages')

  // Read all package.json files
  const packages: PackageInfo[] = []
  for (const packageName of ACTIVE_PACKAGES) {
    const packagePath = join(packagesPath, packageName)
    const packageJson = readPackageJson(packagePath)
    packages.push({
      name: packageName,
      path: packagePath,
      packageJson,
    })
  }

  try {
    const orderedPackages = orderPackagesByDependencies(packages)
    const packagesToPublish = findPackagesToPublish(orderedPackages)
    if (packagesToPublish.length > 0) {
      publishPackages(packagesToPublish, tag, dryRun)
    } else {
      console.log('\n✅ Nothing to publish\n')
    }

    console.log('\n' + '='.repeat(60))
    console.log('✅ Release completed successfully!')
    console.log('='.repeat(60) + '\n')
  } catch (error) {
    console.error('\n' + '='.repeat(60))
    console.error('❌ Release failed!')
    console.error('='.repeat(60))
    console.error(error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
