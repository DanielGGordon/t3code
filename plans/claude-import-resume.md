# Plan: Import & resume Claude Code conversations in T3

## Goal

A `t3 import claude <session>` CLI subcommand that takes an existing Claude Code
conversation (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`) and makes it
appear in T3 as a thread you can **read** and **continue** — where continuing
brings the Claude agent back with its full original context.

## Why this shape (settled by research)

- **Writer runs in-process** (a CLI subcommand in `apps/server`), because every seam
  it needs — internal message commands, `provider_session_runtime` upsert,
  `thread.session.set` — is server-internal and not exposed on the public API.
- **Two independent halves.** The agent's context on resume comes entirely from
  Claude's own `.jsonl` via the SDK `resume` option; T3's display events do **not**
  feed it. So resume works with even a minimal T3 display. That decouples:
  - **Phase A — resumable import** (small): create thread + seed resume cursor.
  - **Phase B — faithful display** (the parsing slog): reproduce full history in the UI.
- **Backdating is free.** `thread.message-sent` / `thread.activity-appended` take
  `createdAt` from the command payload; projections store and sort by it. Deterministic
  `commandId`s make re-import an idempotent no-op.
- **Parser is a portable module** (backend-agnostic reader); only the writer touches
  T3 internals. If T3 is ever dropped, the parser survives.

Same-machine constraint confirmed: the Claude sessions and the repos live on the same
host T3 runs on, so `cwd` namespacing and "agent needs the repo present" both hold.

---

## Phase A — Resumable import (tracer bullet first)

### A0. Tracer bullet: resume ONE hardcoded session end-to-end

Prove the whole resume chain works before generalizing. Manually pick one real
session id + cwd, hand-create a thread, seed the cursor, open it in T3, send a turn,
confirm the agent has full context. This validates the riskiest assumptions (cursor
seeding, `thread.session` status needed for routing, fork behavior) before writing
any parser.

### A1. Add `forkSession` (+ `resumeSessionAt`) forwarding to the Claude adapter

- File: `apps/server/src/provider/Layers/ClaudeAdapter.ts`, `queryOptions` block (~2998–3023).
- Today only `resume`/`sessionId` are forwarded; `resumeSessionAt` is stored in the
  cursor but never passed, and `forkSession` is unused.
- Add `forkSession: true` (gated by a flag/setting) so **continuing an imported session
  in T3 forks to a new `.jsonl` instead of mutating the user's original interactive
  session file.** Optionally forward `resumeSessionAt` to resume at a specific point.
- Decide: always fork on imported-resume, or make it a setting. Default = fork.

### A2. Add a `thread.message.import` internal command

- Cleaner than reusing `thread.message.assistant.delta` (streaming:true) /
  `.complete` (empty text). New command emits a single `thread.message-sent` with
  `streaming:false`, arbitrary `role` (user/assistant/system), full `text`, and a
  backdated `createdAt`.
- Files: add struct to `InternalOrchestrationCommand` (`packages/contracts/src/orchestration.ts:754`),
  add a `case` in `apps/server/src/orchestration/decider.ts`. No store/projection
  changes (it emits the existing `thread.message-sent` event).

### A3. Minimal parser module (`reader`)

- Standalone module (portable). For Phase A, extract only what resume + a minimal
  display need:
  - `sessionId` (from filename), `cwd` (from any line's `cwd` field — **do not** decode
    the dir name; it's lossy), `gitBranch`, title (`ai-title`/`custom-title`, else first
    user prompt), session start time (first line `timestamp`).
  - A linear list of user/assistant **text** turns in file order (defer tree-walking,
    tool calls, sub-agents to Phase B). Filter `isMeta`, `isCompactSummary`,
    `isVisibleInTranscriptOnly`, and non-conversation line types.

### A4. The `t3 import claude` CLI subcommand

- File: new `apps/server/src/cli/import.ts`; register in `apps/server/src/bin.ts`
  (subcommands at ~45–51).
- Steps (all via `orchestrationEngine.dispatch`, in chronological order, deterministic
  `commandId`s):
  1. Resolve session file + `cwd`. Resolve the target **Claude provider instance**
     (providerName / adapterKey / providerInstanceId) — see Open Question 1.
  2. `project.create` if no project for that `workspaceRoot` (= cwd) exists.
  3. `thread.create` (backdated to session start; title from A3).
  4. Write display messages via `thread.message.import` (Phase A: text turns only).
  5. Seed resume: upsert a `provider_session_runtime` row for the thread via
     `ProviderSessionDirectory.upsert` — `providerName`/`adapterKey`/`providerInstanceId`
     set, `status: "stopped"`, `resumeCursor = { resume: "<session-uuid>" }`
     (must be a valid UUID).
  6. Dispatch `thread.session.set` (cf. `ProviderCommandReactor.setThreadSession`,
     `:256`) so the read-model session is routable/recoverable — see Open Question 2.

### A5. Verify Phase A

- Open the imported thread in T3 → it lists. Send a new turn → agent responds **with
  full original context**, and writes to a **forked** `.jsonl` (original untouched).
- Re-run the import → idempotent no-op (no duplicate thread/messages).

---

## Phase B — Full-faithful display

Flesh out the parser so the imported thread also _reads_ perfectly in the UI.

- **Tree → linear path.** `parentUuid`→`uuid` is a tree with branch points and multiple
  roots (edits/retries/forks/compaction). Walk back from the active leaf (last line /
  `last-prompt` `leafUuid`) to a root; drop abandoned branches. (File order is the
  pragmatic fallback.)
- **Tool calls → activities.** Map `tool_use` blocks (assistant) paired with
  `tool_result` (user-type lines, linked by `tool_use_id`) to `thread.activity-appended`
  (`tone:"tool"`, `kind`, `summary`, `payload`, backdated `createdAt`). Add a
  `thread.activity.import` internal command if needed (mirror of A2).
- **Sub-agents.** Splice `<session-id>/subagents/agent-*.jsonl` at their parent `Agent`
  tool-call id (`meta.json` `toolUseId`) as nested activity.
- **Attachments/images** (`tool_result` with base64 `image` blocks): decide store vs
  strip vs reference.
- **Noise/markers:** `compact_boundary` + `isCompactSummary`, `local_command`,
  `file-history-snapshot`, `queue-operation`, hook system lines — filter or render
  distinctly.
- **Multiple lines per turn** sharing one `message.id` — group when reconstructing.

---

## Cross-cutting

- **Idempotency / commandId scheme.** Derive deterministic `commandId`s from the source
  message `uuid` (and a stable thread id from `sessionId`) so partial/repeated imports
  converge instead of duplicating.
- **Batch import.** `t3 import claude --all <project-dir>` to import every session in a
  project, or a single session by id/path.

## Open questions to resolve during implementation

1. **Provider-instance resolution.** Which configured Claude instance to bind the
   imported thread to (providerName / adapterKey / providerInstanceId)? Look up existing
   provider instances/settings; pick default or add a `--instance` flag.
2. **Exact `thread.session` status for routing.** Research said the recovery path keys
   off the directory binding, but `ensureSessionForThread` wants a non-null/non-stopped
   read-model session to treat it as routable. Determine the precise status to set in
   step A4.6 so the first turn triggers `recoverSessionForThread` → SDK `resume`.
3. **Fork semantics.** Confirm SDK `forkSession` behavior (new session id? where written?)
   and how the new id should be written back into the cursor after the first forked turn.

## Verification checklist

- [ ] A0 tracer: hand-seeded session resumes with full context.
- [ ] Imported thread appears with correct title + backdated timestamp.
- [ ] Continuing the thread: agent has context; original `.jsonl` untouched (forked).
- [ ] Re-import is an idempotent no-op.
- [ ] (Phase B) Tool calls, sub-agents, and ordering render faithfully in the UI.
