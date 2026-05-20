# V2 Storage Service

This note inventories the current SQLite/Drizzle query shapes used by opencode and sketches a swappable Effect service boundary for V2 storage. The goal is not to expose a generic SQL abstraction. The goal is to collect the domain operations we actually need behind an Effect service so the implementation can remain Drizzle SQLite today and move to Drizzle Effect SQLite, Effect SQL, a remote store, or a test implementation later.

## Current Shape

The current database module is `packages/opencode/src/storage/db.ts`.

It provides:

- `Database.Client()` as a lazy singleton Drizzle client.
- `Database.use(callback)` as an ambient callback against the current transaction or global client.
- `Database.transaction(callback, { behavior })` for synchronous SQLite transactions.
- `Database.effect(fn)` for side effects queued until after the surrounding transaction.
- SQLite lifecycle concerns: path selection, PRAGMAs, migrations, close/reset.

This API is convenient but leaks the concrete database everywhere. Most call sites import Drizzle operators and tables directly, build SQL in feature modules, and depend on synchronous callback execution.

## Tables In Scope

The regularly queried tables are:

- `project`: project identity, worktree, sandbox list, commands, icon metadata.
- `workspace`: workspace records associated with projects.
- `session`: session metadata, hierarchy, workspace/project links, usage totals, archive/revert/permission fields.
- `message`: legacy V2 message rows with JSON payloads.
- `part`: legacy V2 message part rows with JSON payloads.
- `session_message`: new V2 event-derived session message rows.
- `todo`: ordered per-session todo rows.
- `event_sequence`: per-aggregate high-water mark and owner claim.
- `event`: ordered sync/event history rows.
- `account` and `account_state`: auth accounts and singleton active account state.
- `permission`: project-scoped permission rules.
- `session_share`: share records by session.
- `data_migration`: resumable data migration completion markers.

## Query Shapes

### Lifecycle And Migrations

- Open database at the channel/user-selected path.
- Apply SQLite PRAGMAs for WAL, sync mode, busy timeout, cache size, foreign keys, and checkpointing.
- Apply schema migrations from bundled or dev migration files.
- Run data migrations in resumable background fibers.
- Run high-throughput JSON import using bulk inserts and explicit transactions.
- Provide a readonly/raw admin path for `opencode db` diagnostics.

### Transactions

- Run synchronous transactions with SQLite behavior options: `deferred`, `immediate`, `exclusive`.
- Preserve transaction context across nested helpers and projectors.
- Queue post-commit side effects for bus/global event publication.
- Need write-lock semantics for event sequencing. `SyncEvent.run` depends on `immediate` to avoid another writer changing the aggregate sequence between read and write.

### Event Store

- Read latest sequence and owner by aggregate id.
- Claim an aggregate by updating `event_sequence.owner_id`.
- Remove all sync state for an aggregate by deleting `event_sequence` and `event` rows transactionally.
- Append a projected event:
  - read latest sequence inside an immediate transaction,
  - run the domain projector,
  - upsert `event_sequence`,
  - insert `event`,
  - publish only after commit.
- Read sync fence state for all aggregates or a supplied aggregate id set.
- Read event history with per-aggregate high-water exclusions.
- Read replay history for one aggregate ordered by sequence.

### Sessions

- Get one session by id.
- List sessions with dynamic filters:
  - project id,
  - workspace id,
  - directory,
  - path or path prefix,
  - root sessions only,
  - updated since timestamp,
  - title search,
  - archived/non-archived,
  - cursor pagination by `(time_updated, id)`,
  - asc/desc order and previous/next page direction.
- List child sessions by parent id.
- List global sessions, then hydrate project metadata for distinct project ids.
- Create/update/delete sessions through event projectors.
- Update session usage counters using atomic increments.
- Patch sessions with partial row updates and read the updated row.

### Messages And Parts

- Page legacy `message` rows by session, descending by `(time_created, id)`, with `limit + 1` pagination.
- Hydrate page results with all `part` rows for returned message ids ordered by `(message_id, id)`.
- Get one message by `(session_id, message_id)`.
- Get one part by `(session_id, message_id, part_id)`.
- List parts by message id ordered by id.
- Upsert messages by id, updating JSON payload on conflict.
- Upsert parts by id, updating JSON payload on conflict.
- Delete messages and parts by session-scoped keys.
- Read previous part usage before update/delete so usage counters can be adjusted.
- Ignore late writes that fail foreign-key constraints when the session/message has already been removed.

### Session Message Timeline

- List session messages by session id with cursor pagination by `(time_created, id)`.
- Load context since latest compaction:
  - read latest `type = compaction` message,
  - read all messages after or at that compaction boundary ordered ascending.
- Read current assistant/compaction/shell messages by session and type, newest first, then apply in-memory predicates.
- Update message JSON data by `(id, session_id, type)`.
- Append session message rows.
- Update session metadata for agent/model switch events.

### Projects And Workspaces

- Upsert projects by id.
- List all projects and get one project by id.
- Update project fields and return the updated row.
- Update initialized timestamp.
- Mutate JSON-ish sandbox arrays by read/update-returning.
- Repair global sessions into a discovered project by matching `(project_id = global, directory = worktree)`.
- Workspace CRUD by project and workspace id.
- Read sessions associated with a workspace.
- Read distinct workspaces for a project when needed by control-plane flows.

### Accounts, Permissions, Shares, Todos

- Account repository:
  - read active singleton state then active account,
  - list accounts,
  - upsert account,
  - upsert singleton active state,
  - update tokens,
  - transactionally clear state and delete account.
- Permissions:
  - load rules by project id during per-instance state initialization.
  - persist rules when approval state changes.
- Shares:
  - get share by session id,
  - upsert share by session id,
  - delete share by session id.
- Todos:
  - transactionally replace all todos for a session with ordered rows,
  - list todos by session ordered by position.

### Imports And Admin

- Import sessions/messages/parts idempotently using `onConflictDoNothing`.
- Import sessions with conflict update for project/directory/path.
- Run CLI diagnostics:
  - readonly raw SQL query,
  - sqlite shell for local SQLite backend,
  - print database path.

## Proposed Boundary

Use concrete service interfaces at the level higher services actually consume. We do not need a broad abstract hierarchy of sub-interfaces up front.

For V2, the first useful boundary is a session storage service consumed by `SessionV2.Service`:

```ts
export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<SessionRow | undefined, StorageError>
  readonly list: (input: SessionListInput) => Effect.Effect<SessionRow[], StorageError>
  readonly messages: (input: SessionMessageListInput) => Effect.Effect<SessionMessageRow[], StorageError>
  readonly context: (sessionID: SessionID) => Effect.Effect<SessionMessageRow[], StorageError>
}
```

That interface should be shaped by `v2/session.ts`, not by the underlying tables. Internally it can use whatever helpers make sense: Drizzle query builders, transaction helpers, mapper functions, or smaller private modules. Those internals do not need to be stable service boundaries until another higher-level service needs to consume them.

The important design choice is that public boundaries are domain-level and demand-driven. The implementation may still use Drizzle internally, but V2 session code should stop importing Drizzle tables/operators for normal app behavior.

## Service Breakdown

We can safely break this into multiple services when there is a real consumer boundary, but we should not invent a full repository graph before the higher services ask for it. Start with the services that map to product/domain services, then let implementation helpers stay private.

### Foundation Helper

`StorageConnection` can exist as an implementation helper that owns the backend and cross-cutting mechanics:

- open/close lifecycle,
- migrations,
- transaction context,
- transaction behavior (`deferred`, `immediate`, `exclusive`),
- post-commit callbacks,
- backend capabilities such as raw SQL or sqlite shell support.

This should be the only place that knows whether the implementation is current Drizzle SQLite, future Drizzle Effect SQLite, Effect SQL, or something else. It does not necessarily need to be exposed directly to feature services.

### Public Services

Public services should map to higher-level consumers:

- `SessionV2Storage`: the first public storage service for `v2/session.ts` reads and eventually V2 session writes.
- `SyncEventStorage`: later, if we extract event sequencing/projection out of `sync/index.ts`.
- `StorageAdmin`: later, if CLI diagnostics need a backend-neutral story.
- Smaller stores only when their current owner service needs a swappable dependency.

Splitting this way is safe because public services share one internal connection/transaction helper. A transaction can compose operations across implementation helpers without each public service opening its own client.

The unsafe split would be one independent service per table with independent clients/lifecycles. That would make cross-table transactions, event projection, and post-commit publication harder to reason about.

## V2 Session Today

`packages/opencode/src/v2/session.ts` is currently a thin experimental service. It mixes domain API shape, row decoding, cursor query construction, and event publishing.

Implemented methods:

- `get(sessionID)`: reads `session` by id and maps the row to `SessionV2.Info`.
- `list(input)`: lists sessions from `session` with filters and cursor pagination by `(time_updated, id)`.
- `messages(input)`: lists projected `session_message` rows with cursor pagination by `(time_created, id)` and decodes them to `SessionMessage.Message`.
- `context(sessionID)`: finds the latest compaction message, then returns all `session_message` rows at or after that boundary ordered ascending.
- `switchAgent(input)`: publishes `SessionEvent.AgentSwitched` through `EventV2Bridge`.
- `switchModel(input)`: publishes `SessionEvent.ModelSwitched` through `EventV2Bridge`.
- `subagent(input)`: partially implemented orchestration that calls `create`, `prompt`, `wait`, and `messages`.

Stubbed or incomplete methods:

- `create`: currently returns `{}` via `any`.
- `prompt`: currently returns `{}` via `any`.
- `shell`: no-op.
- `skill`: no-op.
- `compact`: no-op.
- `wait`: no-op.

Current direct storage needs for implemented reads:

- Get session row by id.
- List sessions with filters: directory, path prefix, workspace id, roots-only, updated-start, title search.
- Cursor sessions by `(time_updated, id)` with `previous`/`next` page semantics.
- List session messages by session id with cursor by `(time_created, id)`.
- Load active context since latest compaction.

Current write path for implemented commands:

- V2 session commands publish core `SessionEvent` definitions through `EventV2Bridge`.
- `EventV2Bridge` maps versioned aggregate events to legacy `SyncEvent.run`.
- `SyncEvent.run` applies `session/projectors-next.ts`, which updates `session` and `session_message` transactionally.

That means V2 session reads and V2 event projection are coupled through storage, but they are two distinct seams.

## Best First Slice

The best first storage service to extract is `SessionV2Storage`, scoped to what `v2/session.ts` currently needs, not a general storage layer.

Reasons:

- It is central to the new V2 API.
- It has a small current query surface: `get`, `list`, `messages`, `context`.
- It is shaped by the V2 session service API, not by table names.
- It can replace all direct Drizzle reads in `v2/session.ts` without touching legacy `message`/`part` yet.
- It can grow to include V2 writes (`create`, `prompt`, `compact`, etc.) as those methods become real.

Possible first interface:

```ts
export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<SessionRow | undefined, StorageError>
  readonly list: (input: SessionListInput) => Effect.Effect<SessionRow[], StorageError>
  readonly messages: (input: SessionMessageListInput) => Effect.Effect<SessionMessageRow[], StorageError>
  readonly context: (sessionID: SessionID) => Effect.Effect<SessionMessageRow[], StorageError>
}
```

The second slice should be the write side for V2 session behavior once the currently stubbed methods are designed:

- `create`,
- `prompt`,
- `shell`,
- `skill`,
- `compact`,
- `wait`.

The third slice should be event sequencing/projection if the V2 write path continues to publish through `EventV2Bridge` and `SyncEvent.run`. That is more valuable but riskier, so doing `SessionV2Storage` first gives us the service pattern before touching event sequencing.

Recommended sequence:

1. Add `SessionV2Storage` implemented with current Drizzle SQLite internals.
2. Refactor `V2Session.get`, `V2Session.list`, `V2Session.messages`, and `V2Session.context` to use it.
3. Keep private implementation helpers for session rows, session-message rows, cursor predicates, and row decoding near the storage implementation.
4. Add write methods to `SessionV2Storage` only as `V2Session.create/prompt/shell/skill/compact/wait` become real.
5. Extract `SyncEventStorage` later if event sequencing/projection needs its own swappable boundary.

## Suggested Sub-Interfaces

### `EventStore`

```ts
interface EventStore {
  readonly getSequence: (
    aggregateID: string,
  ) => Effect.Effect<{ seq: number; ownerID?: string } | undefined, StorageError>
  readonly claim: (aggregateID: string, ownerID: string) => Effect.Effect<void, StorageError>
  readonly removeAggregate: (aggregateID: string) => Effect.Effect<void, StorageError>
  readonly appendProjected: <A, E>(input: {
    definition: SyncDefinition
    aggregateID: string
    data: unknown
    project: Effect.Effect<A, E, Transaction>
    publish: Effect.Effect<void>
  }) => Effect.Effect<A, E | StorageError>
  readonly fence: (aggregateIDs?: string[]) => Effect.Effect<Record<string, number>, StorageError>
  readonly history: (input: { since?: Record<string, number> }) => Effect.Effect<StoredEvent[], StorageError>
  readonly replay: (aggregateID: string) => Effect.Effect<StoredEvent[], StorageError>
}
```

This is the most important seam. It owns sequence correctness, immediate transaction behavior, and post-commit publication.

### `SessionStore`

```ts
interface SessionStore {
  readonly get: (id: SessionID) => Effect.Effect<SessionRow | undefined, StorageError>
  readonly list: (input: SessionListInput) => Effect.Effect<SessionRow[], StorageError>
  readonly listGlobal: (
    input: GlobalSessionListInput,
  ) => Effect.Effect<Array<{ session: SessionRow; project?: ProjectSummary }>, StorageError>
  readonly children: (parentID: SessionID) => Effect.Effect<SessionRow[], StorageError>
  readonly insert: (row: SessionInsert) => Effect.Effect<void, StorageError>
  readonly patch: (id: SessionID, patch: SessionPatch) => Effect.Effect<SessionRow | undefined, StorageError>
  readonly delete: (id: SessionID) => Effect.Effect<void, StorageError>
  readonly incrementUsage: (id: SessionID, usage: UsageDelta) => Effect.Effect<void, StorageError>
}
```

This removes query construction from `session.ts` and projectors while preserving the list semantics that clients rely on.

### `MessageStore`

```ts
interface MessageStore {
  readonly page: (
    input: MessagePageInput,
  ) => Effect.Effect<{ rows: MessageRow[]; more: boolean; cursor?: MessageCursor }, StorageError>
  readonly hydrate: (
    rows: MessageRow[],
  ) => Effect.Effect<Array<{ message: MessageRow; parts: PartRow[] }>, StorageError>
  readonly get: (input: {
    sessionID: SessionID
    messageID: MessageID
  }) => Effect.Effect<MessageRow | undefined, StorageError>
  readonly parts: (messageID: MessageID) => Effect.Effect<PartRow[], StorageError>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
  }) => Effect.Effect<PartRow | undefined, StorageError>
  readonly upsertMessage: (row: MessageInsert) => Effect.Effect<void, StorageError | ForeignKeyError>
  readonly upsertPart: (row: PartInsert) => Effect.Effect<{ previous?: PartRow }, StorageError | ForeignKeyError>
  readonly deleteMessage: (input: {
    sessionID: SessionID
    messageID: MessageID
  }) => Effect.Effect<PartRow[], StorageError>
  readonly deletePart: (input: {
    sessionID: SessionID
    partID: PartID
  }) => Effect.Effect<PartRow | undefined, StorageError>
}
```

The delete/update methods expose previous rows where callers need usage compensation.

### `SessionMessageStore`

```ts
interface SessionMessageStore {
  readonly list: (input: SessionMessageListInput) => Effect.Effect<SessionMessageRow[], StorageError>
  readonly context: (sessionID: SessionID) => Effect.Effect<SessionMessageRow[], StorageError>
  readonly currentByType: (input: {
    sessionID: SessionID
    type: SessionMessage.Type
  }) => Effect.Effect<SessionMessageRow[], StorageError>
  readonly append: (row: SessionMessageInsert) => Effect.Effect<void, StorageError>
  readonly updateData: (input: {
    id: SessionMessage.ID
    sessionID: SessionID
    type: SessionMessage.Type
    data: SessionMessageData
  }) => Effect.Effect<void, StorageError>
}
```

This gives the V2 message updater a storage adapter without exposing Drizzle.

### Smaller Stores

- `ProjectStore`: upsert, get, list, patch-returning, set initialized, sandbox mutation, repair global sessions.
- `WorkspaceStore`: create/update/delete/get/list by project, list session ids, distinct project workspaces.
- `AccountStore`: active, list, get row, persist account, persist token, use account/org, remove.
- `PermissionStore`: load and save project rules.
- `ShareStore`: get, upsert, delete by session id.
- `TodoStore`: replace all for session, list by session.
- `MigrationStore`: completed marker get/insert, data migration helpers, JSON import helpers.
- `AdminStore`: path, readonly raw query, local sqlite shell support flag.

## Transaction Model

There are two viable implementations.

### Option A: One Top-Level Service With Fiber-Local Transaction

The service exposes stores directly. Store methods inspect a fiber-local/current transaction and use it if present. `transaction(effect)` installs the transaction in that context.

Pros:

- Closest to current `Database.use` semantics.
- Domain services do not need explicit transaction parameters.
- Projectors can call the same store methods inside and outside transactions.

Cons:

- Requires careful implementation of fiber-local context and post-commit queues.
- More ambient than explicit dependency passing.

### Option B: Explicit `Transaction` Service

`transaction(effect)` provides a separate `Transaction` context. Projector-only methods require `Transaction` in their environment.

Pros:

- More explicit. A method that must be transactional says so in the type.
- Easier to prevent accidental out-of-transaction writes for projectors.

Cons:

- More churn at call sites.
- Some methods may need both transactional and non-transactional variants.

Recommendation: start with Option A for migration ergonomics, but keep the internal implementation structured so projector methods can later move to explicit `Transaction` if needed.

## Error Model

Use typed storage errors at the boundary:

- `StorageError`: unknown backend failure, includes cause.
- `NotFoundError`: domain-specific absence only where absence is exceptional.
- `ConflictError`: uniqueness or stale write conflicts, if exposed.
- `ForeignKeyError`: late event/projector writes where parent rows are already gone.
- `UnsupportedAdminOperation`: non-SQLite backend cannot open sqlite shell or run raw SQL.

Avoid leaking Drizzle or SQLite error codes above the storage implementation. For current behavior, `ForeignKeyError` should allow projectors to keep ignoring late message/part updates intentionally.

## Migration Strategy

1. Add the storage service as a thin wrapper over existing Drizzle SQLite.
2. Move V2 session/session-message read APIs behind `SessionStorage`. This is the smallest reversible slice and establishes the service pattern.
3. Add write methods to `SessionStorage` only as `V2Session.create/prompt/shell/skill/compact/wait` become real.
4. Move event-store operations after the read seam is proven. This is higher value but riskier because it owns sequencing, transactions, and post-commit side effects.
5. Move projector writes behind stores, preserving transaction semantics.
6. Move small repositories: share, todo, permission, account.
7. Leave CLI/admin raw SQL as an explicit `AdminStore` escape hatch.
8. Only after the domain boundary is in place, evaluate replacing the implementation with Drizzle Effect SQLite or another backend.

## Open Questions

- Should V2 storage be per instance/workspace via `InstanceState`, or global per data directory like the current DB?
- Should event projection become the only write path for sessions/messages, or should import/migration retain direct write APIs permanently?
- Do we need a remote-capable store soon? If yes, raw admin SQL and SQLite shell must stay backend-specific from day one.
- Should `session_message` replace legacy `message`/`part` for V2 context entirely, or do both need first-class APIs for the medium term?
- Should cursor encoding live in the storage service or stay in domain modules while storage accepts decoded cursor structs?

## Initial Implementation Target

The first implementation PR should be small and reversible:

- Add `packages/opencode/src/v2/session/storage.ts` with the `SessionStorage` service shape.
- Implement SQL and in-memory read backends for `get`, `list`, `messages`, and `context`.
- Refactor `v2/session.ts` to consume `SessionStorage.Service` instead of raw Drizzle calls.
- Keep table schemas and existing migrations unchanged.
- Add generic contract tests that run against both storage implementations.

That gives us a concrete swappable seam without forcing every event/session/project/account query to move at once. Event-store extraction remains the next broader storage slice.
