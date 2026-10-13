#!/usr/bin/env -S npx tsx
// dev entry: runs straight from src via tsx
import { reportUnexpected, runCli } from '../src/cli.ts'

await runCli().catch(reportUnexpected)
