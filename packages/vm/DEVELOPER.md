# VM development

Use Node 20.20.0 and npm 10.8.2 for the v1.2.0 regression baseline. Run installation and workspace builds from the repository root.

## Regression commands

From `packages/vm`:

```sh
npm test
npm run test:API
npm run test:browser
npm run tsc
npm run lint
npm run examples
```

`npm test` runs the complete VM API suite, so the root workspace test command now includes VM API execution. `test:API` and `test:browser` select the same files in `test/api/**/*.spec.ts`. Browser tests require the Playwright Chromium installation. No contract tests are excluded from the browser suite.

For a single file, invoke Vitest directly; adding a file argument to `test:API` still selects its entire API directory:

```sh
npx vitest run -c vitest.config.ts test/api/runTx.spec.ts
```

Coverage uses the same API scope:

```sh
npm run coverage
```

## TRON fixtures and expectations

Construct transactions with the VM's Common, sign the local TRON payload and supply account state explicitly. Execution presets do not include genesis or consensus metadata; blockchain tests must provide a genesis block. Synthetic Clique metadata tests exercise the retained utility, not TRON DPoS.

The 1559/3198 tests verify retained local transaction and block formats. They do not model bandwidth, staking or network Energy pricing. Execution Energy expectations use the pinned source and configuration recorded in `../tvm/test/testdata/tronEnergy.json`. These source-derived expectations are not live-node measurements.

`test/api/javaTronReference.spec.ts` also replays 71 externally measured java-tron reference cases through signed local transactions, with both SimpleStateManager and MerkleStateManager. It compares TVMJS execution Energy, errors, output, stack, logs and state with [the recorded results](../tvm/test/testdata/javaTronExecution.json). A zero-priced envelope isolates execution balance changes; intrinsic transaction overhead is asserted separately. The [fixed inputs](../tvm/test/testdata/javaTronExecutionInputs.json) and results record the upstream commit, configuration and provenance hashes. The external measurement used the java-tron VM engine with real repository caches and mocked empty backing stores, without live-node or full resource-model coverage. Repository tests read the fixed JSON and require no Java, Gradle or external checkout.

The tests cover all three TRON presets, exact Token IDs, address derivation, storage transitions, transient storage, call forwarding, receipts and rollback. `retiredExecution.spec.ts` verifies rejected capabilities and the absence of Ethereum system calls and block rewards. `removedBlob`, `removedBeaconRoot` and `removed7702` cover physically removed inputs.

### Solidity contract fixtures

The three sources in `test/api/tvm/solidityCode` use TRON solc **0.8.11+commit.b01f3284**, including the TRON signature intrinsics. Tests load `compiled.json` without filesystem, network or compiler access. The fixture records the compiler URL, version, SHA-256, optimizer settings and each source hash.

To regenerate after an intentional source change, obtain the compiler from the URL recorded in the fixture, save it with a `.cjs` extension and run:

```sh
npm run fixtures:compile -- /absolute/path/to/soljson.cjs
```

The generator checks the pinned compiler hash and version before compiling. Review both source and fixture changes together and run Node and Browser tests. Changing the compiler requires explicitly updating its pin; an Ethereum solc build is not a substitute for TRON intrinsics.

## Retired Ethereum infrastructure

The execution-spec fixture submodule, `test:est:*`, `test:state*`, `test:blockchain*`, and their build-integrity commands have been retired. The Ethereum fork loaders, t8n/retesteth filling tools, mainnet block benchmark and dedicated fixture-generation/analysis scripts have no TRON execution entry point and were removed together. `benchmarks`, `build:benchmarks`, `profiling` and `formatTest` are also retired.

Ethereum official execution vectors are **not executed** by this suite and are not counted as passing or skipped. The separate `packages/ethereum-tests` submodule remains unchanged. Fixed vectors still used by other packages retain their provenance; shared trace formatting is tested in `test/api/trace.spec.ts`.

EOF, Verkle, BAL and consensus-request support remain inactive in the TRON profile. Retained implementation/data helpers do not make those execution capabilities available. Use explicit rejection or no-side-effect tests rather than modifying the private capability cache to activate them.
