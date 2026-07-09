# Provider architecture

The web app communicates with the server via WebSocket using a simple JSON-RPC-style protocol:

- **Request/Response**: `{ id, method, params }` → `{ id, result }` or `{ id, error }`
- **Push events**: typed envelopes with `channel`, `sequence` (monotonic per connection), and channel-specific `data`

Push channels: `server.welcome`, `server.configUpdated`, `terminal.event`, `orchestration.domainEvent`. Payloads are schema-validated at the transport boundary (`wsTransport.ts`). Decode failures produce structured `WsDecodeDiagnostic` with `code`, `reason`, and path info.

Methods mirror the `NativeApi` interface defined in `@t3tools/contracts`:

- `providers.startSession`, `providers.sendTurn`, `providers.interruptTurn`
- `providers.respondToRequest`, `providers.stopSession`
- `shell.openInEditor`, `server.getConfig`

Codex is the only implemented provider. `claudeCode` is reserved in contracts/UI.

## Client transport

`wsTransport.ts` manages connection state: `connecting` → `open` → `reconnecting` → `closed` → `disposed`. Outbound requests are queued while disconnected and flushed on reconnect. Inbound pushes are decoded and validated at the boundary, then cached per channel. Subscribers can opt into `replayLatest` to receive the last push on subscribe.

## Server-side orchestration layers

Provider runtime events flow through queue-based workers:

1. **ProviderRuntimeIngestion** — consumes provider runtime streams, emits orchestration commands
2. **ProviderCommandReactor** — reacts to orchestration intent events, dispatches provider calls
3. **CheckpointReactor** — captures git checkpoints on turn start/complete, publishes runtime receipts

All three use `DrainableWorker` internally and expose `drain()` for deterministic test synchronization.

## Provider session reaper

`ProviderSessionReaper` periodically sweeps persisted session bindings and stops provider sessions that have been idle past a threshold. A session is spared while the thread has an active turn, while in-process runtime activity is fresher than the persisted binding, or while it has live background tasks (currently Claude-only: `task.started`/`task.completed` are mapped from the Claude SDK's task notifications; other providers always report zero live tasks). Live tasks protect an idle session only up to a hard cap so leaked task bookkeeping cannot keep a session alive forever.

Tuning env vars (all optional, resolved via `ServerConfig`; invalid values fail at startup):

- `T3CODE_SESSION_IDLE_REAP_MS`: idle duration before a session is reap-eligible. Default `1800000` (30 min). Values `<= 0` disable the reaper.
- `T3CODE_SESSION_REAPER_SWEEP_MS`: sweep interval. Default `300000` (5 min), floored at `1000`.
- `T3CODE_SESSION_REAPER_TASK_CAP_MS`: maximum idle duration a session with live background tasks is spared. Default `86400000` (24 h).
