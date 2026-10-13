#!/usr/bin/env node
// installed entry: runs the built output, plain node only
import { reportUnexpected, runCli } from '../dist/esm/cli.js'

await runCli().catch(reportUnexpected)
