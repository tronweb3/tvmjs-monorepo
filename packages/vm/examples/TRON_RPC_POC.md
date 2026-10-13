# TRON RPC Client PoC

<!-- cspell:ignore getaccount getcontractinfo getnowblock runtimecode triggerconstantcontract walletsolidity -->

This experimental example exercises the minimum remote-state flow needed for a read-only TRON contract call. It is not a stable package API.

## Run

Provide a java-tron endpoint with Ethereum-compatible JSON-RPC enabled and its TRON HTTP API:

```shell
TRON_JSON_RPC_URL=http://127.0.0.1:8545 \
TRON_WALLET_URL=http://127.0.0.1:8090 \
TRON_CALLER=T... \
TRON_CONTRACT=T... \
TRON_CALLDATA=0x... \
npx tsx packages/vm/examples/runTronRPCPoc.ts
```

Optional variables:

- `TRON_PRO_API_KEY`: sent as the `TRON-PRO-API-KEY` header.
- `TRON_NETWORK`: `mainnet` (default), `nile`, or `shasta`.
- `TRON_WALLET_API_PREFIX`: `wallet` (default) or `walletsolidity`.
- `TRON_BLOCK_NUMBER`: requests a numeric JSON-RPC state tag. Many java-tron nodes support only `latest` for state reads.
- `TRON_TRANSACTION_ID`: fetches that transaction through `eth_getTransactionByHash`. When omitted, the first transaction hash in the selected block is fetched when present.

Use a deterministic view call. Calls whose result changes every block are unsuitable unless all reads stay on the same remote head.

## RPC Mapping

| Data or operation | API | Local use |
| --- | --- | --- |
| Reference block | `POST /wallet/getnowblock` | Detects whether the remote head moved during comparison. |
| TRON account | `POST /wallet/getaccount` | Exposes TRON account metadata for the selected caller. |
| TRX balance | `eth_getBalance` | Builds the local execution account. |
| Runtime code | `eth_getCode` | Loads contract bytecode lazily. |
| Contract metadata | `POST /wallet/getcontractinfo` | Cross-checks the runtime code returned by JSON-RPC. |
| Storage word | `eth_getStorageAt` | Loads 32-byte storage slots lazily during execution. |
| Block context | `eth_getBlockByNumber` | Supplies NUMBER, TIMESTAMP, COINBASE, GASLIMIT and BASEFEE. |
| Transaction | `eth_getTransactionByHash` | Demonstrates transaction field retrieval for TronBox integration. |
| Reference execution | `POST /wallet/triggerconstantcontract` | Produces the java-tron return value and Energy result. |

The adapter avoids `eth_getProof`: java-tron exposes the balance, code and storage methods needed by this PoC, but does not provide a portable EIP-1186 proof endpoint. Provider responses are trusted.

## Snapshot And State Rules

The default `latest` mode reads the reference block before and after `triggerconstantcontract`, then checks the head again after local execution. `blockStable` is true only when the wallet reference, JSON-RPC block and final head are the same height. A false value means return bytes can still be useful for stable contract state, but the run is not a strict snapshot comparison.

Supplying `TRON_BLOCK_NUMBER` requests the same numeric tag for balance, code, storage and block reads. java-tron commonly rejects numeric tags for the first three methods, so historical replay requires a node implementation that explicitly supports them.

Mainnet uses `createCurrentTronMainnetCommon()` by default. Library callers can pass an explicit `Common` to reproduce historical Proposal/EIP activation. Nile and Shasta use their network presets without guessing current governance state.

## Capability Boundary

The PoC supports one read-only call, TRX balances, lazy code/storage access, block and transaction reads, 20-byte VM addresses, Base58Check inputs, and `41`-prefixed TRON inputs. It compares return bytes and reports local Energy alongside java-tron Energy.

It does not implement state proofs, state-root verification, TRC-10 balances and issuance state, account permissions, writes, retries, rate limiting, endpoint failover, or a production cache. A call that depends on those omitted fields is outside the supported comparison boundary.

For TronBox integration, the required inputs are the network, JSON-RPC URL, wallet API URL, caller, contract, calldata and optional API key. Historical execution additionally needs a provider with consistent tagged state reads.
