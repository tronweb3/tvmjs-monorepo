# Changelog

## Unreleased

- Reject chain parameters outside JavaScript's safe integer range during node creation and CLI configuration loading, preventing silently rounded fees and resource limits.
- Preserve the previous mining interval and scheduled tick when switching to instant mining fails. Keep earlier committed blocks and queued transactions retryable, and report their IDs through `BlockTimeChangeError` and JSON-RPC error data.

## 1.0.0

- Add a local TRON development node with deterministic accounts, mining and chain controls, a `/wallet/*` HTTP API, and programmatic `TronNode` / `TronProvider` interfaces.
- Support contract execution, transaction broadcasts, TRC-10 assets, permissions, staking, resource accounting, and development tracing on the TVMJS execution stack.
- Build on `@tvmjs/*` 1.2.0 with the TRON-only execution profile and Energy schedule. Enable Proposal 65, CLZ (EIP-7939), and Proposal 96 by default; EIP-7951/P256 verification is unavailable.
- Match protobuf last-value semantics for duplicate AssetIssue fields and decode binary `UnfreezeAssetContract` transactions locally when TronWeb cannot.
- Roll back development writes, generated accounts, and clock advances when their implicit block fails.
- Isolate `/admin` and `/tre` from browser cross-origin requests, require POST for state-changing administration routes, and cap mnemonic-derived account batches at 100.
