# @tvmjs/client

`@tvmjs/client` is a local TRON development node.

It creates an independent local chain with deterministic development accounts, the TRON HTTP API, and development controls for blocks, time, and chain state. It supports immediate and interval mining.

## Installation

```sh
npm install --save-dev @tvmjs/client
```

Node.js 20 or later is required.

## Starting the client

Run the client from the command line or from a Node.js program.

### Command line

```sh
npx tvmjs
```

The client listens at `http://127.0.0.1:9090` by default.

Startup prints development-account addresses, balances, mnemonics, and private keys.

```sh
npx tvmjs --port 9091
npx tvmjs --host 127.0.0.1
npx tvmjs --init ./devnet.json
```

Read the current head block:

```sh
curl http://127.0.0.1:9090/wallet/getnowblock
```

Show every command-line option:

```sh
npx tvmjs --help
```

### Start an HTTP service from a program

```ts
import { startHttpServer, TronNode, TronProvider } from '@tvmjs/client'

const node = await TronNode.create({
  runtime: { logger: console }
})
const provider = new TronProvider(node)

const started = await startHttpServer(provider, {
  host: '127.0.0.1',
  port: 9090
})

console.log(`Client is listening at ${started.url}`)
```

### Use a node directly in a program

Use `node.tre`, `node.admin`, and `node.debug` for development controls. Use `provider.request()` to query the chain and submit transactions:

```ts
import { TronNode, TronProvider } from '@tvmjs/client'

const node = await TronNode.create()
const provider = new TronProvider(node)

await node.tre.mine(2)

const block = await provider.request({ method: 'wallet/getnowblock' })

console.log(block.block_header.raw_data.number)
```

Use `node.admin.accounts()` to retrieve the mnemonics and private keys for configured and temporary development accounts.

## Configure the local chain

The command line and programmatic APIs share the same initial-state configuration:

- From the command line, pass a JSON file with `--init ./devnet.json`.
- In a program, pass the configuration object to `TronNode.create()`.

The three initial-state properties are optional:

| Property | Effect when present |
| --- | --- |
| `mnemonic` | Configures development accounts derived from a mnemonic. |
| `accounts` | Adds accounts with specified private keys alongside the derived development accounts. |
| `chainParameters` | Overrides selected local-chain parameters. |

By default, the client derives ten development accounts from its built-in mnemonic, each with a balance of 10,000 TRX.

1 TRX = 1,000,000 sun. Write large balances as strings to preserve their exact integer value in JSON.

### Derived development accounts

Use `mnemonic` to choose the accounts the client derives at startup. It accepts either a BIP-39 mnemonic string or an object:

```json
{
  "mnemonic": {
    "phrase": "<local BIP-39 mnemonic>",
    "count": 3,
    "balance": "5000000"
  }
}
```

| Field | Required | Description |
| --- | --- | --- |
| `phrase` | Yes, for the object form | BIP-39 mnemonic used to derive the accounts. |
| `count` | No | Number of accounts to derive. Defaults to `10`; maximum `100`. |
| `balance` | No | Initial balance of each derived account, in sun. Defaults to `10000000000` (10,000 TRX). |

### Additional accounts

Use `accounts` to create accounts from private keys in addition to the derived development accounts:

```json
{
  "accounts": [
    {
      "privateKey": "<local development private key>",
      "balance": "250000000"
    }
  ]
}
```

| Field | Required | Description |
| --- | --- | --- |
| `privateKey` | Yes | 32-byte hexadecimal private key. |
| `balance` | No | Initial balance in sun. Defaults to `10000000000` (10,000 TRX). |

### Chain parameters

Use `chainParameters` to override individual local-chain settings:

```json
{
  "chainParameters": {
    "energyFee": 100,
    "freeNetLimit": 5000,
    "unfreezeDelayDays": 1
  }
}
```

`chainParameters` values must be non-negative safe integers represented as JSON numbers, at most `9007199254740991` (`Number.MAX_SAFE_INTEGER`). Each parameter's own limits also apply. Node creation rejects larger numbers because parsing them can lose precision. Parameters omitted from the configuration retain their defaults.

### Program runtime

In a program, add optional `runtime` settings alongside the initial-state properties in `TronNode.create()`:

| Property | Purpose |
| --- | --- |
| `runtime.logger` | Receives formatted node logs, including initialization and block production. Use `console` to print them to the terminal. |
| `runtime.common` | Configures supported options from `@tvmjs/common`. |

## Implemented functionality

The client currently implements:

- Account creation, account queries, balance queries, and resource queries
- Block queries, transaction construction, transaction broadcast, transaction queries, and receipt queries
- Contract deployment, contract calls, constant calls, energy estimation, and contract-information queries
- Stake 1.0 and Stake 2.0 freezing, unfreezing, withdrawal, and resource delegation
- TRC-10 issuance, transfer, queries, updates, and frozen-supply handling
- Node information, chain parameters, energy prices, and bandwidth prices
- Local mining, time control, balance changes, code changes, storage changes, and execution tracing

The following functionality is not yet implemented:

- Voting, proposals, and governance flows
- Witness management and witness-voting flows
- Exchange, market matching, and market-order flows
- Shielded-transaction and zero-knowledge-proof flows
- Historical-balance and historical-state queries

## Development JSON-RPC

`POST /tre` accepts JSON-RPC 2.0 development requests.

### Chain controls

The client mines each transaction in its own block by default. Set `tre_blockTime` to a positive number of seconds to mine at regular intervals, collecting pending transactions into each block. Set it to `0` to return to immediate mining. Use `tre_mine` to mine blocks on demand and process pending transactions.

| Method | Parameters | Behavior |
| --- | --- | --- |
| `tre_mine` | `[]` or `[{ blocks }]` | Mines 1 to 100 blocks; defaults to 1. |
| `tre_increaseTime` | `[seconds]` | Advances chain time, mines a block, and returns the new block timestamp in milliseconds. |
| `tre_blockTime` | `[seconds]` | Sets the mining interval in seconds, from 0 to 60. |

Switching to `0` drains pending transactions into separate blocks before the mode changes. If a block fails, already committed blocks remain, and the previous interval and timer stay active for the remaining queue. The JSON-RPC error uses code `-32000` and includes `data` with `requestedBlockTime`, `activeBlockTime`, `committedTransactionIds`, and `pendingTransactionIds` (64-character hexadecimal IDs without `0x`). Programmatic calls throw `BlockTimeChangeError` with the same `data` and the original `cause`. These lists describe the queue at failure; query transaction receipts before retrying because interval mining continues.

Mine three blocks:

```sh
curl http://127.0.0.1:9090/tre \
  --header 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tre_mine","params":[{"blocks":3}]}'
```

### State controls

| Method | Parameters | Behavior |
| --- | --- | --- |
| `tre_setAccountBalance` | `[account, balance]` | Sets the balance of `account` to `balance` sun, then mines a block. |
| `tre_setAccountCode` | `[account, code]` | Writes runtime code at `account`, then mines a block. |
| `tre_setAccountStorageAt` | `[account, slot, value]` | Writes `value` at `slot` for `account`, then mines a block. |
| `tre_unlockedAccounts` | `[accounts]` | Adds accounts to the unsigned-broadcast allowlist. |

`account` accepts either:

- A Base58Check address
- A hexadecimal address: a 20-byte address may be passed directly, and the `0x` prefix and `41` network prefix are each optional

`balance` is a non-negative integer in sun. It accepts a JSON number, a decimal string, or a lowercase `0x`-prefixed hexadecimal string. Use strings for balances above JavaScript's safe integer range.

In HTTP JSON-RPC requests, `code`, `slot`, and `value` are `0x`-prefixed hexadecimal strings.

### Debug methods

| Method | Parameters | Result |
| --- | --- | --- |
| `debug_traceTransaction` | `[txid]` | Execution status, VM energy usage (`gas`), return value, and opcode trace (`structLogs`). |
| `debug_storageRangeAt` | `[block, txIndex, address, startKey, limit]` | Current storage entries and a `nextKey` pagination cursor. |

In HTTP JSON-RPC requests, `txid` is a 32-byte hexadecimal string with a `0x` prefix.

`debug_storageRangeAt` reads the current chain head; `txIndex` must be `0`.

## Administration endpoints

| Path | Description |
| --- | --- |
| `GET /admin` | Returns the client name and version. |
| `GET /admin/accounts` | Returns development-account addresses, current balances, and credentials as text. |
| `GET /admin/accounts-json` | Returns mnemonics and private keys for configured and temporary development accounts as JSON. |
| `POST /admin/temporary-accounts-generation` | Creates new temporary development accounts. |
| `POST /admin/accounts-generation` | Resets all development-account balances to `mnemonic.balance` and mines a block. |

### Create temporary development accounts

`POST /admin/temporary-accounts-generation` creates a new account group from a random mnemonic, resets all development-account balances to the same value, and mines a block. Parameters remain in the query string.

| Parameter | Description |
| --- | --- |
| `accounts` | Number of accounts to create; defaults to `10`; maximum `100`. Use `0` to reset balances without adding accounts. |
| `defaultBalance` | Balance assigned to all development accounts, in whole TRX. When omitted, uses the balance configured by `mnemonic.balance` (10,000 TRX by default). |

The response is the complete text account list, including addresses, current balances, mnemonics, and private keys.

## Development credentials

CLI startup output and account-administration endpoints include development mnemonics and private keys.

Store mnemonic and private-key values in local files excluded from version control. Keep credential-bearing logs private and restrict access to account-administration endpoints.

The HTTP server exposes CORS on the standard TRON surface. Development controls under `/admin` and `/tre` accept loopback Host values by default, the configured Host when an explicit address is used, and any valid Host when `host: '*'` is selected. They still reject browser cross-origin requests. Use `TronNode` / `TronProvider`, TronBox, or another non-browser client for those controls.

## License

[MPL-2.0](./LICENSE)
