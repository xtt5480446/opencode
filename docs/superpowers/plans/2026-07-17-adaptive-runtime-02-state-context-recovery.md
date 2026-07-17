# Adaptive Runtime State, Context, and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete a real single-Worker coding task after repeated loss of Worker and Coordinator process context, using only durable Roadmap/Detail/Assignment/Checkpoint/workspace/event facts.

**Architecture:** SQLite stores immutable Roadmap/Detail/Assignment/Checkpoint versions and task-scoped durable events. Before every provider turn, Context Assembler deterministically rebuilds a ContextManifest from mandatory global/assignment state plus prioritized local facts; an Agent process never owns authoritative context. Replacement Workers enter a read-only verification phase and must reconcile checkpoint claims with current HEAD/diff/key files/evidence before mutation tools are enabled.

**Tech Stack:** Effect Schema/EventV2, Drizzle SQLite, Core ToolRegistry, OpenCode LocationServiceMap, Git status/diff, `@opencode-ai/llm` messages/events, content-addressed blobs, Bun tests with fake LLM and real subprocesses.

---

## File Map

**Schema and durable events**

- Create `packages/schema/src/adaptive-roadmap.ts`: RequirementBaseline, node/index/interface/dependency/Detail references and deterministic Roadmap wire shape.
- Create `packages/schema/src/adaptive-operation.ts`: Assignment, Checkpoint, EvidenceRef, CandidateReport, recovery verification.
- Create `packages/schema/src/adaptive-event.ts`: durable Task/Agent/tool/decision/checkpoint/candidate events.
- Modify `packages/schema/src/index.ts`, `packages/schema/src/event-manifest.ts`, `packages/schema/src/durable-event-manifest.ts`.
- Test `packages/schema/test/adaptive-contract.test.ts`, `packages/schema/test/event-manifest.test.ts`.

**Core state**

- Extend `packages/core/src/adaptive/sql.ts`: Roadmap revisions, Details, Assignments, Checkpoints, blobs, and recovery fields.
- Create `packages/core/src/adaptive/roadmap-store.ts`: immutable Roadmap/Detail writes and exact-reference reads.
- Create `packages/core/src/adaptive/recovery-store.ts`: Assignment/checkpoint/recovery/process facts.
- Create `packages/core/src/adaptive/projector.ts`: replayable projections from Adaptive events.
- Create `packages/core/src/adaptive/blob-store.ts`: content-addressed large-output storage.
- Generate a Stage 2 migration and update Core migration tests.
- Test `packages/core/test/adaptive/roadmap-store.test.ts`, `recovery-store.test.ts`, `projector.test.ts`, `blob-store.test.ts`.

**Runtime**

- Create `packages/opencode/src/adaptive/context/component.ts`: component priority/provenance/token model.
- Create `packages/opencode/src/adaptive/context/render.ts`: stable Requirement/Roadmap/Assignment/Detail/checkpoint rendering.
- Create `packages/opencode/src/adaptive/context/assembler.ts`: budget, deterministic selection, eviction, manifest persistence.
- Create `packages/opencode/src/adaptive/tool/tools.ts`: canonical adaptive Tool values.
- Create `packages/opencode/src/adaptive/tool/gateway.ts`: role/generation/recovery-aware ToolRegistry execution.
- Create `packages/opencode/src/adaptive/process/agent-loop.ts`: provider-turn/tool-continuation loop.
- Create `packages/opencode/src/adaptive/recovery.ts`: orphan reconciliation, soft restart, replacement bootstrap.
- Extend `packages/opencode/src/adaptive/controller.ts`, process protocol/supervisor, CLI management commands, and AppRuntime graph.
- Test `packages/opencode/test/adaptive/context-assembler.test.ts`, `tool-gateway.test.ts`, `agent-loop.test.ts`, `worker-recovery.test.ts`, `coordinator-recovery.test.ts`.

**Integration fixture**

- Create `fixtures/adaptive/recovery-counter/REQUIREMENT.md`.
- Create `fixtures/adaptive/recovery-counter/package.json`, `src/retry.ts`, `test/retry.test.ts` with a deliberately incomplete retry implementation.
- Create `packages/opencode/test/adaptive/recovery-fixture.test.ts` to copy and run the fixture in a temporary Git repository.

## Task 1: Roadmap, Operation, and Event Contracts

**Files:**

- Create: `packages/schema/src/adaptive-roadmap.ts`
- Create: `packages/schema/src/adaptive-operation.ts`
- Create: `packages/schema/src/adaptive-event.ts`
- Modify: `packages/schema/src/index.ts`
- Modify: `packages/schema/src/event-manifest.ts`
- Modify: `packages/schema/src/durable-event-manifest.ts`
- Test: `packages/schema/test/adaptive-contract.test.ts`
- Modify: `packages/schema/test/event-manifest.test.ts`

- [ ] **Step 1: Write contract invariants as failing tests**

```ts
test("Roadmap round trip preserves complete interface index and exact Detail version", () => {
  const value = new AdaptiveRoadmap.Info({
    taskID: AdaptiveTask.ID.create(),
    revision: 3,
    requirement: new AdaptiveRoadmap.RequirementBaseline({
      objective: "implement retry",
      scope: ["src/retry.ts"],
      constraints: ["one pinned model"],
      acceptance: ["bun test"],
    }),
    nodes: [
      new AdaptiveRoadmap.Node({
        id: "retry-core",
        title: "Retry core",
        goal: "bounded cancellable retry",
        status: "running",
        interfaces: [
          new AdaptiveRoadmap.InterfaceRef({
            key: "contract:retry-api",
            name: "retry",
            kind: "function",
            signature: "retry<T>(operation, options): Promise<T>",
            version: 2,
            state: "ready",
          }),
        ],
        dependencies: [],
        details: [new AdaptiveRoadmap.DetailRef({ key: "contract:retry-api", kind: "contracts", version: 2, status: "ready" })],
        acceptance: ["bun test test/retry.test.ts"],
        risks: [],
        unresolved: [],
      }),
    ],
    risks: [],
    unresolved: [],
  })
  expect(Schema.decodeUnknownSync(AdaptiveRoadmap.Info)(Schema.encodeUnknownSync(AdaptiveRoadmap.Info)(value))).toEqual(value)
})

test("Checkpoint carries facts needed for replacement", () => {
  const checkpoint = AdaptiveOperation.Checkpoint.make({
    workerID: AdaptiveTask.AgentID.create(),
    sequence: 4,
    roadmapRevision: 3,
    nodeID: "retry-core",
    completed: ["added cancellation branch"],
    decisions: [{ key: "decision:timer", version: 1 }],
    modifiedPaths: ["src/retry.ts"],
    evidence: ["aev_test"],
    remaining: ["backoff assertion fails"],
    nextAction: "fix attempt counter",
    worktreeHead: "abc123",
    diffHash: "sha256:diff",
  })
  expect(checkpoint.nextAction).toBe("fix attempt counter")
})
```

Add an event-manifest assertion that every Adaptive durable definition is present at its versioned type and in the public latest manifest.

- [ ] **Step 2: Run and verify missing contracts**

Run: `cd packages/schema && bun test test/adaptive-contract.test.ts test/event-manifest.test.ts`

Expected: FAIL because Adaptive Roadmap/Operation/Event modules do not exist.

- [ ] **Step 3: Implement the final Roadmap index shape**

The closed fields are:

```ts
export const NodeStatus = Schema.Literals([
  "unresolved", "discovering", "blocked", "ready", "running",
  "candidate", "validating", "integrated", "failed", "conflict",
])
export const DependencyKind = Schema.Literals(["hard", "contract", "informational", "validation"])
export const DetailKind = Schema.Literals(["requirements", "contracts", "decisions", "validation"])
export const DetailStatus = Schema.Literals(["unresolved", "draft", "ready", "superseded"])

export class InterfaceRef extends Schema.Class<InterfaceRef>("AdaptiveRoadmap.InterfaceRef")({
  key: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["function", "type", "schema", "command", "file-format", "service", "other"]),
  signature: Schema.String,
  version: NonNegativeInt,
  state: DetailStatus,
}) {}

export class Dependency extends Schema.Class<Dependency>("AdaptiveRoadmap.Dependency")({
  nodeID: Schema.String,
  kind: DependencyKind,
  contractKey: Schema.String.pipe(optional),
  reason: Schema.String,
}) {}
```

`Node` includes `id`, `title`, `goal`, `status`, optional `owner`, `interfaces`, `dependencies`, `details`, `acceptance`, `risks`, and `unresolved`. `Info` includes Task ID, revision, RequirementBaseline, all nodes, global risks, and global unresolved items. Do not add chronological progress prose.

- [ ] **Step 4: Implement Assignment, Checkpoint, and recovery schemas**

`Assignment` is immutable and contains ID, Task/Worker/Node IDs, Roadmap revision, exact Detail refs, permitted path globs, base commit, acceptance commands, and generation.

`Checkpoint` contains the fields in Step 1 plus `timeCreated`.

`RecoveryVerification` contains observed head, diff hash, status lines, checked key files with content hashes, revalidated Evidence IDs, discrepancies, and boolean `consistent`.

`CandidateReport` contains assignment ID, head commit, diff hash, modified paths, claimed acceptance evidence, remaining risks, and Detail refs.

- [ ] **Step 5: Define durable task events**

All definitions aggregate on `taskID`, durable version `1`:

```ts
TaskCreated
RoadmapCommitted
DetailCommitted
AssignmentCreated
AgentGenerationStarted
AgentGenerationLost
RecoveryVerified
ToolCalled
ToolSettled
DecisionRecorded
DependencyReported
CheckpointSaved
CandidateSubmitted
ContextSplitRequired
```

Tool events store canonical tool name/call ID/bounded input or output preview/blob reference/status, never unbounded stdout. Export `DurableDefinitions`, `Definitions`, `Durable`, and `All` following `session-event.ts`.

- [ ] **Step 6: Register events in both manifests**

Add `AdaptiveEvent.Definitions` to the current public `EventManifest.Definitions`, and `AdaptiveEvent.DurableDefinitions` to `DurableEventManifest.Durable`. Also export an `AdaptiveDurable` manifest containing only Adaptive definitions for aggregate reads and projector tests.

- [ ] **Step 7: Run schema tests and typecheck**

Run: `cd packages/schema && bun test test/adaptive-contract.test.ts test/event-manifest.test.ts test/contract-hygiene.test.ts && bun typecheck`

Expected: PASS; optional fields omit `undefined`; identifiers are unique.

- [ ] **Step 8: Commit**

```bash
git add packages/schema/src/adaptive-roadmap.ts packages/schema/src/adaptive-operation.ts packages/schema/src/adaptive-event.ts packages/schema/src/index.ts packages/schema/src/event-manifest.ts packages/schema/src/durable-event-manifest.ts packages/schema/test/adaptive-contract.test.ts packages/schema/test/event-manifest.test.ts
git commit -m "feat(schema): define adaptive recovery state"
```

## Task 2: Durable Roadmap, Detail, Assignment, Checkpoint, and Blob Storage

**Files:**

- Modify: `packages/core/src/adaptive/sql.ts`
- Create: `packages/core/src/adaptive/roadmap-store.ts`
- Create: `packages/core/src/adaptive/recovery-store.ts`
- Create: `packages/core/src/adaptive/blob-store.ts`
- Generate: `packages/core/src/database/migration/20260717100000_adaptive_recovery_state.ts`
- Modify generated: `packages/core/src/database/migration.gen.ts`
- Modify generated: `packages/core/src/database/schema.gen.ts`
- Modify generated: `packages/core/schema.json`
- Test: `packages/core/test/adaptive/roadmap-store.test.ts`
- Test: `packages/core/test/adaptive/recovery-store.test.ts`
- Test: `packages/core/test/adaptive/blob-store.test.ts`
- Modify: `packages/core/test/database-migration.test.ts`

- [ ] **Step 1: Write immutable-version and exact-reference tests**

Cover these exact setup/action/assertions:

- Commit revision `1` from expected `0`, retry a different revision from expected `0`, and assert stale-revision error plus current revision/body remain `1`/original.
- Insert `contract:x@1`, attempt different body at the same key/version, and assert immutable-Detail error and original content hash.
- Commit a Roadmap pointing to absent `contract:x@2`, assert missing-reference error and no Roadmap/event write.
- Save checkpoint sequences `1` and `2`, reopen the DB, and assert latest returns sequence `2` while sequence `1` remains addressable.
- Save with stale Agent generation and wrong observed HEAD/diff hash, assert the corresponding typed error and unchanged checkpoint sequence.
- Put identical bytes twice, assert equal SHA-256, one metadata row/file, verified read bytes; mutate stored bytes and assert `BlobCorruptError`.

- [ ] **Step 2: Run focused tests and verify missing services**

Run: `cd packages/core && bun test test/adaptive/roadmap-store.test.ts test/adaptive/recovery-store.test.ts test/adaptive/blob-store.test.ts`

Expected: FAIL because the services do not exist.

- [ ] **Step 3: Add normalized immutable tables**

Add these tables:

- `adaptive_roadmap_revision`: `(task_id, revision)` primary key; encoded Requirement/Roadmap JSON, content hash, source Agent/generation, event sequence, created time.
- `adaptive_detail`: `(task_id, key, version)` primary key; node ID, kind, status, body, content hash, source Agent/generation, created time.
- `adaptive_assignment`: assignment ID primary key; Task/Worker/Node, generation, Roadmap revision, Detail refs JSON, permitted paths JSON, base commit, acceptance commands JSON, superseded time.
- `adaptive_checkpoint`: `(worker_id, sequence)` primary key; Assignment ID, generation, Roadmap revision, encoded checkpoint, worktree head, diff hash, created time.
- `adaptive_blob`: SHA-256 hash primary key; media type, byte count, relative storage path, created time, last-access time.

Extend `adaptive_agent_process` with `node_id`, `tool_session_id`, `assignment_id`, `event_cursor`, `checkpoint_sequence`, `recovery_state`, and `restart_required`. Extend ContextManifest with Roadmap revision, turn, omitted components, and generation restart reason.

- [ ] **Step 4: Generate and inspect the migration**

Run: `cd packages/core && bun script/migration.ts --name adaptive_recovery_state`, rename the generated migration to `src/database/migration/20260717100000_adaptive_recovery_state.ts`, then run `bun script/migration.ts` to refresh the registry.

Expected: one migration with foreign keys/indexes and no destructive change to Stage 1 tables.

Run: `cd packages/core && bun script/migration.ts --check`

Expected: `No schema changes, nothing to migrate`.

- [ ] **Step 5: Implement stores with one-transaction event commits**

`AdaptiveRoadmapStore.commit` takes expected revision, complete next Roadmap, new Detail versions, source Agent/generation, and uses `EventV2.publish(AdaptiveEvent.RoadmapCommitted, ..., { commit })`. The commit callback inserts Details and Roadmap revision and updates Task current revision in the same transaction.

`AdaptiveRecoveryStore.saveCheckpoint` verifies current Agent generation, Assignment ID, Roadmap revision not newer than Task, and actual worktree head/diff hash supplied by Controller before appending `CheckpointSaved` and updating current checkpoint sequence.

- [ ] **Step 6: Implement content-addressed blobs**

Store files below `<Global.Path.data>/adaptive/blobs/sha256/<first-two>/<digest>`. Write to a same-directory temp file, fsync, rename, then insert metadata. On read, verify byte count and SHA-256; quarantine a corrupt file and return `BlobCorruptError`. Enforce create-new semantics and a per-Task reference quota later in Stage 6.

- [ ] **Step 7: Extend migration tests and run all focused tests**

Run: `cd packages/core && bun test test/adaptive/roadmap-store.test.ts test/adaptive/recovery-store.test.ts test/adaptive/blob-store.test.ts test/database-migration.test.ts && bun typecheck`

Expected: PASS; reopening the same DB preserves all versions; corruption test returns typed error.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/adaptive packages/core/src/database packages/core/schema.json packages/core/test/adaptive packages/core/test/database-migration.test.ts
git commit -m "feat(core): persist adaptive recovery state"
```

## Task 3: Replayable Adaptive Projector

**Files:**

- Create: `packages/core/src/adaptive/projector.ts`
- Test: `packages/core/test/adaptive/projector.test.ts`

- [ ] **Step 1: Write replay parity and idempotency tests**

Create a Task with Roadmap, Detail, Assignment, checkpoint, decision, and candidate events. Snapshot all Adaptive projection rows; delete projections without deleting Event rows; replay the task aggregate; assert deep equality. Replay the same serialized event twice and assert no duplicate row or cursor advance.

- [ ] **Step 2: Run and verify the missing projector failure**

Run: `cd packages/core && bun test test/adaptive/projector.test.ts`

Expected: FAIL because `AdaptiveProjector` is absent.

- [ ] **Step 3: Implement one projector per durable state boundary**

Register projectors through `EventV2.Service.project`. Each projector validates Task/Agent/generation/revision relationships and updates only its normalized table. Live-only progress is not projected. Projector initialization must finish before Controller accepts adaptive work.

- [ ] **Step 4: Run projector/Event tests**

Run: `cd packages/core && bun test test/adaptive/projector.test.ts test/event.test.ts && bun typecheck`

Expected: PASS; replay output equals original projection.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adaptive/projector.ts packages/core/test/adaptive/projector.test.ts
git commit -m "feat(core): replay adaptive task projections"
```

## Task 4: Deterministic Context Components and Rendering

**Files:**

- Create: `packages/opencode/src/adaptive/context/component.ts`
- Create: `packages/opencode/src/adaptive/context/render.ts`
- Test: `packages/opencode/test/adaptive/context-render.test.ts`

- [ ] **Step 1: Write golden stable-render tests**

Use a Roadmap with nodes intentionally supplied in reverse order. Assert exact output order:

```text
# Requirement Baseline
Objective: ...
Scope:
- ...
Constraints:
- ...
Acceptance:
- ...

# Roadmap r3
## retry-core [running]
Goal: ...
Interfaces:
- retry | function | retry<T>(operation, options): Promise<T> | contract:retry-api@2 [ready]
Dependencies:
- hard: timer-core - timer behavior must be integrated
Details:
- contracts: contract:retry-api@2 [ready]
Acceptance:
- bun test test/retry.test.ts
```

Render identical values twice and compare bytes and SHA-256.

- [ ] **Step 2: Run and verify missing renderer**

Run: `cd packages/opencode && bun test test/adaptive/context-render.test.ts`

Expected: FAIL because renderer modules are absent.

- [ ] **Step 3: Define ContextComponent**

```ts
export type Priority = "mandatory" | "strong" | "requested" | "ephemeral"
export type Kind =
  | "role-instructions" | "requirement" | "roadmap" | "assignment" | "contract"
  | "detail" | "checkpoint" | "workspace" | "failed-validation" | "risk"
  | "repo-map" | "tool-event" | "local-tail"

export type Component = {
  readonly key: string
  readonly kind: Kind
  readonly priority: Priority
  readonly sourceRevision: string
  readonly text: string
  readonly estimatedTokens: number
  readonly evictable: boolean
}
```

The constructor computes tokens with `Token.estimate` and rejects duplicate keys.

- [ ] **Step 4: Implement stable semantic renderers**

Sort Roadmap nodes by ID, interfaces by key/name, dependencies by kind/node, Detail refs by kind/key/version, checkpoint arrays lexicographically, and workspace paths by normalized relative path. Preserve Requirement prose exactly; do not summarize it.

- [ ] **Step 5: Run render tests and typecheck**

Run: `cd packages/opencode && bun test test/adaptive/context-render.test.ts && bun typecheck`

Expected: PASS; golden output is byte-stable.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/adaptive/context/component.ts packages/opencode/src/adaptive/context/render.ts packages/opencode/test/adaptive/context-render.test.ts
git commit -m "feat(adaptive): render stable context components"
```

## Task 5: Context Assembler Budget and Manifest

**Files:**

- Create: `packages/opencode/src/adaptive/context/assembler.ts`
- Test: `packages/opencode/test/adaptive/context-assembler.test.ts`

- [ ] **Step 1: Write budget, eviction, and provenance tests**

Required cases and assertions:

- Assemble with a tight but valid budget and assert component keys contain Requirement, every Roadmap node, Assignment, and every direct contract ref/version.
- Reduce budget one component at a time and assert omission order is successful output, old tail, RepoMap, requested Detail, then strong context, with reason/token counts.
- Include old successful command and newer failed validation under pressure; assert failure remains and successful body is omitted first.
- Make fixed tools plus global mandatory prefix exceed budget; assert `CONTEXT_BUDGET_UNSATISFIABLE`, no Manifest row, and no Gateway request.
- Assemble identical DB/worktree state twice; assert byte-equal system/messages/tools, component order, estimates, and request hash.
- Change only diff, then only referenced Detail version; assert source revision/request hash changes in each case.
- Checkpoint at event cursor `10`; assemble events `11..15`; assert no event `<=10`, no duplicate ID, and stable sequence order.

- [ ] **Step 2: Run and verify missing assembler**

Run: `cd packages/opencode && bun test test/adaptive/context-assembler.test.ts`

Expected: FAIL because `AdaptiveContextAssembler` is absent.

- [ ] **Step 3: Implement the input budget calculation**

```ts
const inputBudget = policy.effectiveContextLimit - policy.outputReserve - policy.safetyReserve
const fixedCost = Token.estimate(JSON.stringify({ system, tools }))
const remaining = inputBudget - fixedCost
```

Reject non-positive remaining budget. Include all mandatory components first. Add other components in priority order and stable key order. If a component does not fit, record `{ key, kind, tokens, reason: "budget" }`; never truncate its text. Re-estimate the complete `LLM.request` serialization before persisting. Keep fixed role instructions, exact Requirement, and complete Roadmap as the first three stable system parts, and set a Task-derived provider prompt-cache key without relying on cache state for correctness.

- [ ] **Step 4: Implement role-specific assembly inputs**

For Implementation Worker assemble:

```text
fixed role instructions
+ exact Requirement Baseline
+ complete Roadmap
+ exact Assignment
+ all direct dependency contract Details
+ current node requirements/decisions/validation Details
+ latest checkpoint
+ current HEAD/status/diff summary
+ invalid/failed validation evidence
+ unresolved risks
+ Worker-opened optional Detail keys
+ lightweight RepoMap excerpt
+ events after checkpoint cursor
+ bounded local model/tool tail
```

For Coordinator bootstrap in this stage, replace Assignment with its cycle input and include no implementation diff unless an event references it. Stage 3 expands Coordinator cycles.

- [ ] **Step 5: Persist exact manifest content**

Persist ordered system parts, canonical messages, canonical tool definitions, components, omissions, estimated tokens, Roadmap revision, Agent generation, turn, and SHA-256 request hash before gateway admission. ContextManifest rows are immutable.

- [ ] **Step 6: Implement soft-restart signal**

Set `restartRequired` when estimated tokens exceed 80% of input budget, local tail reaches 24 provider turns, or events after checkpoint exceed 256 entries. The current turn may finish, but another ordinary turn cannot start until a fresh checkpoint is saved and Supervisor launches a new generation. If mandatory current-node context does not fit, emit durable `ContextSplitRequired` with reason code `CONTEXT_SPLIT_REQUIRED`, keep the Assignment/Agent admission-blocked, and wake Coordinator to commit a Roadmap revision that marks the node `blocked` or replaces it with smaller nodes. Fail the Task with `CONTEXT_BUDGET_UNSATISFIABLE` only when Requirement plus complete Roadmap and fixed tool/output reserves cannot fit, or three globally unchanged repair cycles reproduce the same global boundary error.

- [ ] **Step 7: Run assembler tests and typecheck**

Run: `cd packages/opencode && bun test test/adaptive/context-assembler.test.ts test/adaptive/context-render.test.ts && bun typecheck`

Expected: PASS; no test uses a real provider.

- [ ] **Step 8: Commit**

```bash
git add packages/opencode/src/adaptive/context/assembler.ts packages/opencode/test/adaptive/context-assembler.test.ts
git commit -m "feat(adaptive): rebuild bounded turn contexts"
```

## Task 6: Adaptive Tools and Recovery-Aware Tool Gateway

**Files:**

- Create: `packages/opencode/src/adaptive/tool/tools.ts`
- Create: `packages/opencode/src/adaptive/tool/gateway.ts`
- Create: `packages/opencode/src/adaptive/tool/permission.ts`
- Modify: `packages/core/src/location-services.ts`
- Test: `packages/opencode/test/adaptive/tool-gateway.test.ts`

- [ ] **Step 1: Write permissions and state-transition tests**

Cover these exact cases:

- Store Detail versions `1` and `2`, open `2`, and assert body/hash/version `2` rather than current-by-key ambiguity.
- Invoke `decision.record`; immediately query Detail/event and assert summary, reason, evidence IDs, source Agent/generation before another model turn.
- Supply checkpoint diff hash different from Controller inspection; assert `ToolFailure`, no checkpoint/event/current-sequence change.
- Invoke `report.submit`; assert node becomes `candidate` only, never `integrated|completed`.
- Start replacement in `verifying`; assert edit/write/apply_patch/bash definitions are absent and stale direct calls settle as denied without side effects.
- Submit recovery confirmation with stale HEAD or missing assigned key-file hash; assert verifying state remains.
- Materialize Coordinator catalog and assert every repository mutation/shell tool name is absent.
- Configure an `allow` PermissionV2 rule, invoke its matching tool, and assert no `permission.asked` event and exactly one tool side effect/settlement.
- Configure a `deny` rule, invoke the tool, and assert `PermissionV2.BlockedError`, no permission prompt, no side effect, and one denied `ToolSettled` event.
- In normal interactive mode leave the action as `ask`; assert the request names the synthetic Session/Task/Agent/action/resources, tool execution remains blocked, and replies `once`, `always`, and `reject` respectively execute once, persist the existing project-scoped saved rule, and settle without mutation.
- After an `always` reply, replace the Worker generation/synthetic Session and assert the saved project rule permits the same resource without another prompt. A role-level explicit `deny` must still override the saved allow.
- In benchmark mode evaluate an `ask` action and assert it is converted to a deterministic denial before terminal/API input, records `benchmark_permission_denied`, performs no side effect, and never calls another model to decide permission.
- Kill Controller while a normal permission is pending, restart, and assert Core finalization settles the Tool call `interrupted`, no side effect occurred, the call is not automatically replayed, and replacement context receives the interruption fact.

- [ ] **Step 2: Run and verify missing tools**

Run: `cd packages/opencode && bun test test/adaptive/tool-gateway.test.ts`

Expected: FAIL because Adaptive tools/gateway are absent.

- [ ] **Step 3: Implement canonical Tool values**

Register through Core `Tools.Service`, never through a second registry:

- `detail.open({ key, version })`
- `decision.record({ nodeID, key, summary, reason, evidence })`
- `dependency.report({ nodeID, targetNodeID, currentKind, proposedKind, reason, blocksCorrectness })`
- `workspace.inspect({ keyFiles })`
- `recovery.confirm(RecoveryVerification)`
- `checkpoint.save(CheckpointInput)`
- `report.submit(CandidateReportInput)`

Every execute closure resolves Adaptive Agent from the synthetic tool Session ID, verifies generation/Assignment, and publishes a durable Adaptive event.

- [ ] **Step 4: Implement Tool Gateway materialization and settlement**

```ts
export interface Interface {
  readonly catalog: (input: AgentInvocation) => Effect.Effect<Catalog>
  readonly settle: (input: {
    invocation: AgentInvocation
    assistantMessageID: SessionMessage.ID
    call: ToolCall
  }) => Effect.Effect<ToolRegistry.Settlement, Error>
}
```

Controller creates one synthetic V2 Session per Agent with Task/Agent metadata. It is only ToolRegistry permission/output identity. Gateway obtains the worktree Location ToolRegistry, materializes role permissions, records tool call before settlement, executes once, then records bounded result/blob reference. Context Assembler reads Adaptive events, not synthetic Session history.

`permission.ts` adapts the existing Core `PermissionV2.Service`; it does not define a second permission engine or ruleset. Normal TTY/API execution preserves `permission.asked`/`permission.replied` and project-scoped `always` behavior. Benchmark execution changes any otherwise-`ask` result to deny before a pending request exists. Stage 5 wires TTY, non-TTY, and HTTP presentation/reply behavior.

- [ ] **Step 5: Enforce replacement recovery phase**

When `recovery_state = verifying`, catalog exposes read/glob/grep, `workspace.inspect`, `detail.open`, and `recovery.confirm`. It excludes shell/edit/write/apply_patch/report. `workspace.inspect` is Controller implemented and returns actual HEAD, porcelain status, diff hash, and hashes of requested repository-relative key files. Only matching `recovery.confirm` changes state to `ready`.

- [ ] **Step 6: Run tool and canonical registry regressions**

Run: `cd packages/opencode && bun test test/adaptive/tool-gateway.test.ts`

Run: `cd packages/core && bun test test/application-tools.test.ts test/session-runner-tool-registry.test.ts test/tool-bash.test.ts`

Expected: PASS; one canonical ToolRegistry remains.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/adaptive/tool packages/core/src/location-services.ts packages/opencode/test/adaptive/tool-gateway.test.ts
git commit -m "feat(adaptive): expose durable worker tools"
```

## Task 7: Agent Turn/Tool Continuation Loop

**Files:**

- Create: `packages/opencode/src/adaptive/process/agent-loop.ts`
- Modify: `packages/opencode/src/adaptive/process/agent-entry.ts`
- Modify: `packages/opencode/src/adaptive/process/protocol.ts`
- Modify: `packages/opencode/src/adaptive/process/supervisor.ts`
- Test: `packages/opencode/test/adaptive/agent-loop.test.ts`

- [ ] **Step 1: Write scripted LLM loop tests**

Script fake responses for:

1. read tool call -> result -> edit tool call -> result -> checkpoint -> report.submit;
2. two tool calls in one turn settle concurrently, then one continuation;
3. model text says complete without `report.submit` and Task remains running;
4. same call ID repeated after settlement returns recorded result without side effect replay;
5. provider failure stops generation and preserves partial events;
6. soft-restart signal permits checkpoint only, then exits with `restart_required`.

- [ ] **Step 2: Run and verify no role loop**

Run: `cd packages/opencode && bun test test/adaptive/agent-loop.test.ts`

Expected: FAIL because `runAgentLoop` is absent.

- [ ] **Step 3: Extend RPC methods**

Add `context.assemble`, `model.stream`, `tool.settle`, `generation.status`, and `process.complete`. Every request carries Task/Agent/generation. Stream events are correlated by request ID and bounded by 32 active calls.

- [ ] **Step 4: Implement the child-owned loop**

Pseudo-code that must match the implementation:

```ts
while (true) {
  const manifest = await rpc.contextAssemble()
  const events = await rpc.modelStream(manifest.id)
  const calls = events.filter(isLocalToolCall)
  if (calls.length === 0) {
    if (await rpc.generationStatus() === "restart_required") throw RestartRequired
    continue
  }
  await Promise.all(calls.map((call) => rpc.toolSettle(call)))
  const status = await rpc.generationStatus()
  if (status === "candidate" || status === "restart_required" || status === "stopped") break
}
await rpc.processComplete()
```

Provider-executed tools are recorded but never settled locally. Local tool call/results become the next assembled local tail. No in-process unbounded message array survives between turns; only the current stream frame buffer is held.

- [ ] **Step 5: Run loop/protocol/gateway tests**

Run: `cd packages/opencode && bun test test/adaptive/agent-loop.test.ts test/adaptive/process-protocol.test.ts test/adaptive/model-gateway.test.ts && bun typecheck`

Expected: PASS; tool side-effect count is exactly one for duplicate call replay.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/adaptive/process packages/opencode/test/adaptive/agent-loop.test.ts
git commit -m "feat(adaptive): run rebuilt provider turns"
```

## Task 8: Forced Worker and Coordinator Recovery

**Files:**

- Create: `packages/opencode/src/adaptive/recovery.ts`
- Modify: `packages/opencode/src/adaptive/controller.ts`
- Modify: `packages/opencode/src/cli/cmd/adaptive.ts`
- Test: `packages/opencode/test/adaptive/worker-recovery.test.ts`
- Test: `packages/opencode/test/adaptive/coordinator-recovery.test.ts`

- [ ] **Step 1: Define deterministic crash-point tests**

Worker crash points:

```text
after workspace.inspect
after first read result
after first edit result
after decision.record commit
after failed test result
after checkpoint event commit but before process acknowledgement
after candidate event commit but before process exit
```

Coordinator bootstrap crash points:

```text
before reading pending event cursor
after manifest creation before model admission
after model response before durable result commit
after durable result commit before cursor acknowledgement
```

Each test uses a Deferred/fault hook keyed by persisted event, kills the real process group, starts a replacement, and asserts final state plus no duplicate side effects.

- [ ] **Step 2: Run and verify recovery is absent**

Run: `cd packages/opencode && bun test test/adaptive/worker-recovery.test.ts test/adaptive/coordinator-recovery.test.ts`

Expected: FAIL because orphan reconciliation/replacement is absent.

- [ ] **Step 3: Implement orphan reconciliation**

At Controller startup:

1. Expire leases owned by another/dead Controller.
2. Mark associated `running` Tool calls interrupted; never call settle again.
3. Inspect worktree HEAD/status/diff and compare with latest Assignment/checkpoint.
4. Preserve partial files and Tool output blobs.
5. Start a new generation with `recovery_state = verifying` and record the cause.

When a candidate/checkpoint event already committed before death, accept the committed state and do not require the child acknowledgement.

- [ ] **Step 4: Implement deliberate soft restart**

When Assembler sets restart required, Gateway refuses a normal next turn. Controller asks the existing generation for a fresh checkpoint; after `CheckpointSaved`, Supervisor stops it, increments generation, and launches recovery. If checkpoint plus node/contract context cannot fit, keep its Assignment admission-blocked, emit `CONTEXT_SPLIT_REQUIRED`, and wake Coordinator to split it or reduce semantic dependencies; the next Roadmap revision uses node status `blocked` until replacement nodes are legal. Only an unsplittable global Requirement/Roadmap boundary enters typed `CONTEXT_BUDGET_UNSATISFIABLE` failure; no compaction model is called.

- [ ] **Step 5: Add operational restart/resume commands**

`opencode adaptive agent restart <task-id> --role <role>` requests a checkpoint when process is responsive, then stops/replaces it. `--force` kills immediately and relies on last checkpoint/events. `opencode adaptive resume <task-id>` reconciles all leases and runs until candidate/needs_input/failure. `status --json` includes generations, recovery phase, checkpoint sequence, HEAD/diff hash, and last manifest ID.

- [ ] **Step 6: Run forced-loss tests repeatedly**

Run: `cd packages/opencode && bun test test/adaptive/worker-recovery.test.ts test/adaptive/coordinator-recovery.test.ts --rerun-each 10`

If Bun does not support `--rerun-each` at execution time, run the two-file command in a shell loop of ten iterations and stop on first nonzero exit.

Expected: 10/10 PASS with no timeout, leaked process, duplicate tool effect, or divergent final diff.

- [ ] **Step 7: Run full focused suite and typecheck**

Run: `cd packages/opencode && bun test test/adaptive/context-assembler.test.ts test/adaptive/tool-gateway.test.ts test/adaptive/agent-loop.test.ts test/adaptive/worker-recovery.test.ts test/adaptive/coordinator-recovery.test.ts && bun typecheck`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/opencode/src/adaptive/recovery.ts packages/opencode/src/adaptive/controller.ts packages/opencode/src/cli/cmd/adaptive.ts packages/opencode/test/adaptive/worker-recovery.test.ts packages/opencode/test/adaptive/coordinator-recovery.test.ts
git commit -m "feat(adaptive): recover agents from durable facts"
```

## Task 9: Real Single-Worker Coding Fixture and G2 Gate

**Files:**

- Create: `fixtures/adaptive/recovery-counter/REQUIREMENT.md`
- Create: `fixtures/adaptive/recovery-counter/package.json`
- Create: `fixtures/adaptive/recovery-counter/src/retry.ts`
- Create: `fixtures/adaptive/recovery-counter/test/retry.test.ts`
- Create: `packages/opencode/test/adaptive/recovery-fixture.test.ts`
- Modify: `packages/opencode/src/adaptive/controller.ts`
- Modify: `docs/superpowers/acceptance/adaptive-runtime-v1.md`

- [ ] **Step 1: Create a behaviorally meaningful fixture**

`REQUIREMENT.md` requires:

```text
Implement retry<T>(operation, options) with maxAttempts >= 1, exponential delay capped by maxDelayMs, AbortSignal cancellation before an attempt and during delay, no retry after success, and propagation of the final operation error. The injected sleep(ms, signal) function is the only clock. Preserve the exported RetryOptions signature. Acceptance is `bun test test/retry.test.ts` and `bun typecheck`.
```

The initial `src/retry.ts` retries forever, ignores AbortSignal, and uses uncapped delay. Tests cover success, max attempts, cap, cancellation before attempt, cancellation during delay, and final error identity.

- [ ] **Step 2: Write an end-to-end test that initially fails**

The test copies the fixture into a temp Git repo, creates a static one-node Roadmap and Assignment from the requirement, scripts the fake LLM to work through real read/edit/bash/checkpoint/report tools, injects process deaths after half-edit and failed test, resumes, and runs the fixture acceptance command on the candidate commit.

Expected final assertions:

```ts
expect(acceptance.exitCode).toBe(0)
expect(generations).toBeGreaterThanOrEqual(3)
expect(modelIdentities).toEqual(["test/test-model/default"])
expect(recoveryConfirmations).toHaveLength(generations - 1)
expect(oldConversationReplayCount).toBe(0)
```

- [ ] **Step 3: Run and verify the fixture fails before controller wiring**

Run: `cd packages/opencode && bun test test/adaptive/recovery-fixture.test.ts`

Expected: FAIL at Task execution or final acceptance, while the fixture's initial direct `bun test` also fails.

- [ ] **Step 4: Wire the single-node fast path**

For one-node Tasks, Controller creates a Roadmap from the exact Requirement without asking Coordinator to paraphrase it, discovers acceptance only from explicit `--acceptance-command` or repository package commands, creates Assignment, tool Session, worktree, and Implementation Worker, and runs to candidate. It does not let Coordinator edit code.

- [ ] **Step 5: Run fixture and complete package regressions**

```bash
cd packages/opencode && bun test test/adaptive/recovery-fixture.test.ts
cd packages/schema && bun test && bun typecheck
cd packages/core && bun test && bun typecheck
cd packages/opencode && bun test && bun typecheck
cd packages/opencode && bun run build --single --skip-embed-web-ui
```

Expected: all exit `0`; packaged offline doctor still passes.

- [ ] **Step 6: Request independent code review**

Use `requesting-code-review`. The reviewer must specifically inspect context provenance, mandatory budget handling, event/projector atomicity, duplicate tool settlement, checkpoint validation, recovery mutation lock, and fixture validity. Resolve findings and repeat Step 5.

- [ ] **Step 7: Commit the fixture and gate evidence hooks**

```bash
git add fixtures/adaptive/recovery-counter packages/opencode/test/adaptive/recovery-fixture.test.ts packages/opencode/src/adaptive/controller.ts docs/superpowers/acceptance/adaptive-runtime-v1.md
git commit -m "test(adaptive): prove forced context reconstruction"
```

- [ ] **Step 8: Pause for G2 user trial**

Give the user the packaged binary, fixture path, and Program Gate G2 commands. Do not begin Roadmap/Coordinator implementation until the user inspects the candidate code, export, replacement ContextManifests, and marks G2 `accepted`.
