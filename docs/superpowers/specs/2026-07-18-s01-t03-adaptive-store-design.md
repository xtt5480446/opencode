# S01-T03 Adaptive Foundation Store Design

## 1. Purpose

S01-T03 creates the first authoritative Adaptive Runtime state in SQLite. It persists Tasks, Agent process ownership, ContextManifests, and model-request audit rows so later Controllers and replacement processes can recover without relying on an Agent transcript or in-memory state.

This task owns persistence and atomic ownership only. It does not resolve models, assemble production contexts, admit model calls, supervise child processes, or implement the Roadmap.

## 2. OpenCode architecture reused

- `Database.Service` and the existing global Effect/Drizzle SQLite layer.
- Domain-local `sql.ts` declarations discovered by `drizzle.config.ts`.
- `makeGlobalNode` for Store service construction.
- `Schema.TaggedErrorClass` for expected domain failures.
- `UPDATE ... RETURNING` for conditional write success. The current Effect-Drizzle `run()` result is `readonly never[]`; it does not expose `rowsAffected`.
- `packages/core/script/migration.ts` for the migration, registry, full schema, and snapshot. Generated files are never edited manually.
- `AdaptiveTask` contracts from S01-T01 and `AdaptiveModelPolicy` integrity checks from S01-T02.

The Store is parallel to the current Session store. It does not bridge through legacy Session/Event state.

## 3. Tables

### Task

`adaptive_task` stores the canonical Task identity, original requirement, directory, mode/status, complete immutable ModelPolicy fields, Roadmap revision, base snapshot hash, and timestamps. `createTask` and `getTask` return a `TaskRecord`: the S01-T01 `AdaptiveTask.Summary` fields plus `baseSnapshotHash`, so recovery code never needs a second source for the persisted foundation state.

The Store exposes no ModelPolicy update operation. Every Task read reconstructs the policy and recomputes its hash through `AdaptiveModelPolicy.assertEqual(policy, policy)`. A malformed or stale stored hash returns a typed corruption error rather than silently loading the Task.

Database checks enforce the closed mode/status sets, positive context budgets, reserve total below the effective limit, nonnegative Roadmap revision, and canonical policy-hash length/prefix/hex format.

### Agent process

`adaptive_agent_process` stores Task/role, generation, lifecycle state, owner, PID, lease expiry, exit result, and timestamps. Generation is nonnegative; role/state are closed sets; owner/PID/lease are either all absent or all present; and owned rows have a nonempty owner plus positive PID and lease values. `starting | running` rows are owned, while `idle | stopped | lost | failed` rows are unowned.

An Agent begins as generation `0`, state `idle`, with no owner. A successful claim atomically:

1. matches `agentID + expectedGeneration`;
2. requires no owner or an expired lease;
3. increments generation to `expectedGeneration + 1`;
4. sets `starting`, owner, PID, and a lease derived from Effect Clock plus `leaseDurationMs`;
5. clears exit data left by the previous generation;
6. returns the updated row through `RETURNING`.

Heartbeat matches `agentID + generation + owner`, requires an unexpired active lease, changes `starting` to `running`, and extends the lease. Settlement matches the same identity, writes `stopped | lost | failed`, records exit data, and clears owner/PID/lease. Settlement may record the outcome after lease expiry, but it loses atomically if another owner has already claimed the next generation. A failed conditional update may perform a read only to classify NotFound versus ownership/generation conflict; it never performs a read-then-write mutation.

### ContextManifest

`adaptive_context_manifest` stores immutable, ordered JSON components for one Task/Agent generation: purpose, system strings, messages, tools, components, estimated tokens, request hash, and creation time.

The T03 boundary accepts only JSON-safe arrays and rejects unsupported values before reaching SQLite. Insert requires the supplied `taskID + agentID + generation + owner` to match an active, unexpired lease and validates those facts transactionally. The stored order and values are exact; deterministic canonicalization is not claimed here. S02-T05 extends the record with Roadmap, omissions, token-budget decisions, and provenance.

There is no Manifest update API.

### Model request

`adaptive_model_request` stores immutable request identity and the complete ModelPolicy snapshot plus mutable settlement fields. The snapshot includes provider, model, variant, effective limit, both reserves, and hash so audit code can recompute it independently. The row references Task, Agent, Manifest, optional retry parent, and records generation, status, token counts, failure, and timestamps.

Insert creates only `admitted` and rejects a Manifest whose Task/Agent/generation tuple differs from the Request; `retryOf`, when present, must reference the same Task. Settlement is a conditional one-time transition from `admitted | streaming` to `succeeded | failed | interrupted`; an unknown Request or second settlement returns a typed error. Lease authorization, Task-policy equality, retry eligibility, the `admitted -> streaming` transition, and provider-call admission are intentionally owned by S01-T05. That task extends the Store with one domain-specific atomic admission method; it does not expose a generic transaction handle or compose already-committed Store calls.

## 4. Store API and expected failures

The global `AdaptiveStore` service exposes:

- `createTask`, `getTask`;
- `createAgent`, `getAgent`, `claimAgent`, `heartbeat`, `settleAgent`;
- `putManifest`, `getManifest`;
- `insertModelRequest`, `getModelRequest`, `settleModelRequest`.

IDs are supplied by callers so Controller retries and audit correlation remain deterministic. Store methods return readonly records reconstructed from database rows.

Expected failures are typed: duplicate/not-found Task, duplicate/not-found Agent, invalid lease, Agent claim conflict, Agent ownership conflict, corrupt stored ModelPolicy, invalid/duplicate/not-found Manifest, Manifest ownership mismatch, invalid/duplicate/not-found Request, Request reference mismatch, and already-settled Request. Unexpected SQLite failures remain defects; expected duplicates use `ON CONFLICT DO NOTHING ... RETURNING`, not fragile driver-message parsing.

## 5. Transaction and restart guarantees

- Task, Agent, Manifest, and Request inserts use a single transaction whenever validation reads are required; a validation failure leaves no partial row.
- Claims, heartbeats, settlements, and request settlement use one conditional update with `RETURNING`.
- Foreign keys are enabled by `Database.Service`; Task deletion cascades to Agent/Manifest/Request rows if deletion is introduced later.
- Request retry references are self foreign keys and cannot dangle.
- Reopening a fresh `Database.layerFromPath` and `AdaptiveStore` layer over the same SQLite file returns identical records and preserves generations, leases, manifests, and request status.
- No operation depends on process-local caches.

## 6. Implementation slices

1. Declare the four tables, checks, indexes, foreign keys, generated migration, and fresh/legacy migration tests.
2. Implement Task create/get, duplicate handling, policy-integrity detection, and transaction rollback tests.
3. Implement Agent create/get plus claim/heartbeat/settle CAS with TestClock and concurrent-claim tests.
4. Implement immutable Manifest and Request persistence, one-time settlement, foreign-key/ownership tests, and real file-backed restart recovery.

These remain one Issue and one PR, with an atomic commit and focused verification after each slice.

## 7. Verification and user gate

Automated verification includes focused Store tests, migration tests, migration drift check, full Core tests, Core typecheck, formatting, exact file boundary, and repository pre-push typecheck.

Before S01-T04 begins, the user runs the focused migration/Store suite and a file-backed restart test against the merged `stage-01`. The handoff includes commands and the expected table/index/generation/request results. S01-T03 has no CLI product surface yet, so this SQLite integration run is its real acceptance surface.

## 8. Explicit non-goals

- Model resolution or provider credentials.
- Model-call admission and same-model retry policy.
- Production ContextManifest assembly or token budgeting.
- Agent process spawning or stdio RPC.
- Roadmap, Detail, Assignment, Checkpoint, or Evidence tables.
- Baseline Session/Agent/Model behavior changes.
