# Adaptive Runtime Roadmap and Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a software requirement and repository facts into a globally coherent, versioned Roadmap index that drives restartable Coordinator cycles, focused Discovery, and precise Detail retrieval.

**Architecture:** Each Coordinator wake is a transaction-like cycle over one Roadmap revision and one pending-event range. The model can inspect the complete Roadmap and open Details, but changes state only through a typed `coordinator.commit` proposal; deterministic validation and compare-and-swap commit the next revision, Detail versions, dispatch intents, and event cursor atomically. Discovery and Roadmap Review are fresh-context read-only Agent processes using the same immutable ModelPolicy.

**Tech Stack:** Effect services, immutable SQLite projections, Adaptive EventV2 events, Context Assembler, Core ToolRegistry, OpenCode filesystem/search/LSP navigation facts, Bun tests and real repository fixtures.

---

## File Map

**Schema/Core**

- Modify `packages/schema/src/adaptive-operation.ts`: CoordinatorCycle/Proposal, DispatchPlan, DiscoveryReport, RoadmapReview.
- Modify `packages/schema/src/adaptive-event.ts`: cycle, review, discovery, and dispatch events.
- Extend `packages/core/src/adaptive/sql.ts`: Coordinator cycle and dispatch plan tables.
- Create `packages/core/src/adaptive/roadmap-validator.ts`: global invariants and impact classification.
- Create `packages/core/src/adaptive/coordinator-store.ts`: cycle lease, CAS commit, event cursor.
- Extend `packages/core/src/adaptive/projector.ts` and database migration tests.
- Test `packages/core/test/adaptive/roadmap-validator.test.ts`, `coordinator-store.test.ts`, `projector.test.ts`.

**OpenCode runtime**

- Create `packages/opencode/src/adaptive/coordinator/prompt.ts`: stable role/R0/revision/reviewer instructions.
- Create `packages/opencode/src/adaptive/coordinator/tools.ts`: commit and review/report tools.
- Create `packages/opencode/src/adaptive/coordinator/cycle.ts`: wake/assemble/run/commit/retry logic.
- Create `packages/opencode/src/adaptive/coordinator/roadmap-init.ts`: R0, unresolved/discovery, review gate, single-node fast path.
- Create `packages/opencode/src/adaptive/discovery.ts`: focused read-only Agent lifecycle.
- Create `packages/opencode/src/adaptive/repo-map.ts`: deterministic navigation facts only.
- Extend `controller.ts`, `context/assembler.ts`, `tool/gateway.ts`, CLI and API-facing schemas.
- Test `packages/opencode/test/adaptive/coordinator-cycle.test.ts`, `roadmap-init.test.ts`, `discovery.test.ts`, `repo-map.test.ts`.

**Fixture**

- Create `fixtures/adaptive/roadmap-service` with an existing service, incomplete integration documentation, and a batch-import requirement.
- Create `packages/opencode/test/adaptive/roadmap-fixture.test.ts`.

## Task 1: Coordinator Cycle and Proposal Contracts

**Files:**

- Modify: `packages/schema/src/adaptive-operation.ts`
- Modify: `packages/schema/src/adaptive-event.ts`
- Modify: `packages/schema/test/adaptive-contract.test.ts`
- Modify: `packages/schema/test/event-manifest.test.ts`

- [ ] **Step 1: Write failing round-trip tests**

```ts
test("CoordinatorProposal binds exact revision and event range", () => {
  const proposal = new AdaptiveOperation.CoordinatorProposal({
    cycleID: "acy_test",
    taskID: AdaptiveTask.ID.create(),
    expectedRoadmapRevision: 4,
    eventRange: { after: 18, through: 23 },
    roadmap: roadmapAt(5),
    details: [],
    dispatches: [
      new AdaptiveOperation.DispatchPlan({
        id: "adp_test",
        nodeID: "batch-import",
        role: "implementation",
        reason: "hard dependencies integrated",
        roadmapRevision: 5,
        detailRefs: [],
      }),
    ],
  })
  expect(Schema.decodeUnknownSync(AdaptiveOperation.CoordinatorProposal)(
    Schema.encodeUnknownSync(AdaptiveOperation.CoordinatorProposal)(proposal),
  )).toEqual(proposal)
})
```

Also assert a proposal cannot encode a Roadmap revision other than `expected + 1`, an empty discovery question, or reviewer approval containing unresolved error findings.

- [ ] **Step 2: Run and observe missing schema members**

Run: `cd packages/schema && bun test test/adaptive-contract.test.ts test/event-manifest.test.ts`

Expected: FAIL because Coordinator proposal/cycle definitions are absent.

- [ ] **Step 3: Add operation contracts**

Define:

```ts
export class DetailWrite extends Schema.Class<DetailWrite>("AdaptiveOperation.DetailWrite")({
  key: Schema.String,
  version: PositiveInt,
  nodeID: Schema.String,
  kind: AdaptiveRoadmap.DetailKind,
  status: AdaptiveRoadmap.DetailStatus,
  body: Schema.String,
}) {}

export class DispatchPlan extends Schema.Class<DispatchPlan>("AdaptiveOperation.DispatchPlan")({
  id: Schema.String.check(Schema.isStartsWith("adp_")),
  nodeID: Schema.String,
  role: AdaptiveTask.Role,
  reason: Schema.String,
  roadmapRevision: NonNegativeInt,
  detailRefs: Schema.Array(AdaptiveRoadmap.DetailRef),
}) {}
```

`CoordinatorProposal` contains cycle/Task/revision/event range, the complete next Roadmap, Detail writes, and dispatch plans. `DiscoveryReport` contains the exact question, inspected paths/symbols/commands, answer, evidence blob refs, remaining unknowns, and proposed Detail writes. `RoadmapReview` contains severity-tagged findings referencing requirement/node/interface/acceptance paths; it cannot mutate Roadmap.

- [ ] **Step 4: Add durable events**

Add `CoordinatorCycleStarted`, `CoordinatorCycleCommitted`, `CoordinatorCycleRejected`, `RoadmapReviewSubmitted`, `DiscoveryRequested`, `DiscoverySubmitted`, and `DispatchPlanned`, all Task-aggregated. Register in manifests and assert versioned names.

- [ ] **Step 5: Run schema tests and commit**

Run: `cd packages/schema && bun test test/adaptive-contract.test.ts test/event-manifest.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/schema/src/adaptive-operation.ts packages/schema/src/adaptive-event.ts packages/schema/test/adaptive-contract.test.ts packages/schema/test/event-manifest.test.ts
git commit -m "feat(schema): define coordinator cycles"
```

## Task 2: Roadmap Global Invariants and Impact Classification

**Files:**

- Create: `packages/core/src/adaptive/roadmap-validator.ts`
- Test: `packages/core/test/adaptive/roadmap-validator.test.ts`

- [ ] **Step 1: Write one test for each invariant**

Required failures:

```text
Requirement Baseline hash or semantic fields changed
Roadmap revision is not exactly previous + 1
Roadmap estimated size exceeds configured 50k budget
duplicate node ID or interface key
dependency target missing
hard/contract dependency cycle
ready/running node lacks acceptance
contract dependency lacks ready contract Detail and InterfaceRef
InterfaceRef points at wrong Detail version/kind/status
integrated node is moved backward without invalidation reason
dispatch references a non-ready or mismatched revision node
```

Required successes include unresolved nodes with explicit unknowns and informational dependencies whose Detail is not ready.

- [ ] **Step 2: Run and verify the validator is missing**

Run: `cd packages/core && bun test test/adaptive/roadmap-validator.test.ts`

Expected: FAIL because `AdaptiveRoadmapValidator` is absent.

- [ ] **Step 3: Implement deterministic validation**

```ts
export interface ValidationInput {
  readonly previous?: AdaptiveRoadmap.Info
  readonly next: AdaptiveRoadmap.Info
  readonly requirementHash: string
  readonly details: ReadonlyMap<string, AdaptiveRoadmapStore.DetailRecord>
  readonly dispatches: readonly AdaptiveOperation.DispatchPlan[]
  readonly roadmapTokenBudget: number
}

export type Impact = "L0_EVIDENCE" | "L1_LOCAL" | "L2_CONTRACT" | "L3_REQUIREMENT"

export interface Result {
  readonly impact: Impact
  readonly affectedNodes: readonly string[]
  readonly invalidatedNodes: readonly string[]
}
```

Use RequirementBaseline canonical hash, not model judgment, to detect mutation. Detect dependency cycles using only `hard` and `contract`; `informational` and `validation` edges do not block readiness. Return all invariant errors in stable path/code order so Coordinator can repair them in one cycle.

- [ ] **Step 4: Implement impact rules**

- L0: validation evidence/status refresh with no contract/dependency/acceptance change.
- L1: local node goal/risk/Detail refinement with no consumer-visible change.
- L2: frozen interface, dependency, permitted scope, or acceptance change; affected nodes pause and evidence invalidates in later stages.
- L3: Requirement Baseline mutation or a Roadmap direction that cannot satisfy the immutable Requirement; Stage 5 turns this into Conflict.

- [ ] **Step 5: Run tests/typecheck and commit**

Run: `cd packages/core && bun test test/adaptive/roadmap-validator.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/core/src/adaptive/roadmap-validator.ts packages/core/test/adaptive/roadmap-validator.test.ts
git commit -m "feat(core): validate roadmap invariants"
```

## Task 3: Coordinator Cycle Persistence and CAS Commit

**Files:**

- Modify: `packages/core/src/adaptive/sql.ts`
- Create: `packages/core/src/adaptive/coordinator-store.ts`
- Modify: `packages/core/src/adaptive/projector.ts`
- Generate: `packages/core/src/database/migration/20260717110000_adaptive_coordinator_cycles.ts`
- Modify generated: `packages/core/src/database/migration.gen.ts`
- Modify generated: `packages/core/src/database/schema.gen.ts`
- Modify generated: `packages/core/schema.json`
- Test: `packages/core/test/adaptive/coordinator-store.test.ts`
- Modify: `packages/core/test/adaptive/projector.test.ts`
- Modify: `packages/core/test/database-migration.test.ts`

- [ ] **Step 1: Write crash-boundary and CAS tests**

- Begin twice at the same Task/revision/cursor; assert both return one cycle ID and one open DB row.
- Advance Roadmap through another cycle, commit the old proposal, and assert stale-revision rejection without cursor/Detail/dispatch writes.
- Commit a valid proposal and assert Roadmap, Details, dispatch rows, cycle status, and cursor appear atomically after reopen.
- Reopen after commit and assert next begin starts from committed revision/next event cursor with no open predecessor.
- Abandon before commit, begin again, and assert identical event range with no Roadmap/state change.
- Retry identical proposal hash after acknowledgement loss and assert prior commit result plus exactly one dispatch row.

- [ ] **Step 2: Run and verify missing storage**

Run: `cd packages/core && bun test test/adaptive/coordinator-store.test.ts`

Expected: FAIL because cycle storage is absent.

- [ ] **Step 3: Add cycle and dispatch tables**

`adaptive_coordinator_cycle`: cycle ID, Task ID, Coordinator Agent/generation, expected revision, event after/through cursor, manifest ID, proposal hash/body, status `open|committed|rejected|abandoned`, rejection codes, created/settled time. Unique partial index permits one open cycle per Task.

`adaptive_dispatch_plan`: dispatch ID, Task/node/role, Roadmap revision, exact Detail refs, reason, status `planned|assigned|cancelled`, source cycle ID, created/settled time. Unique `(task_id, node_id, roadmap_revision, role)`.

- [ ] **Step 4: Generate migration and implement store**

Run: `cd packages/core && bun script/migration.ts --name adaptive_coordinator_cycles`, rename the generated migration to `src/database/migration/20260717110000_adaptive_coordinator_cycles.ts`, then run `bun script/migration.ts` to refresh the registry.

`commit` must call RoadmapValidator, then append `CoordinatorCycleCommitted` with a commit callback that inserts Details/Roadmap/dispatches, advances Task Roadmap revision and Coordinator event cursor, and settles the cycle. A validation or stale failure appends `CoordinatorCycleRejected` without advancing the cursor.

- [ ] **Step 5: Extend projector and migration coverage**

Replay must rebuild cycle terminal state and dispatch rows. Fresh and Stage 2 database upgrades preserve counts/hashes.

- [ ] **Step 6: Run tests and commit**

Run: `cd packages/core && bun script/migration.ts --check && bun test test/adaptive/coordinator-store.test.ts test/adaptive/projector.test.ts test/database-migration.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/core/src/adaptive packages/core/src/database packages/core/schema.json packages/core/test/adaptive packages/core/test/database-migration.test.ts
git commit -m "feat(core): commit coordinator cycles atomically"
```

## Task 4: Coordinator Tools and Restartable Cycle Runtime

**Files:**

- Create: `packages/opencode/src/adaptive/coordinator/prompt.ts`
- Create: `packages/opencode/src/adaptive/coordinator/tools.ts`
- Create: `packages/opencode/src/adaptive/coordinator/cycle.ts`
- Modify: `packages/opencode/src/adaptive/context/assembler.ts`
- Modify: `packages/opencode/src/adaptive/tool/gateway.ts`
- Test: `packages/opencode/test/adaptive/coordinator-cycle.test.ts`
- Modify: `packages/opencode/test/adaptive/coordinator-recovery.test.ts`

- [ ] **Step 1: Write cycle behavior and recovery tests**

Cover:

- Seed three Roadmap nodes and events around the cursor; inspect Manifest and assert every node plus only `(after, through]` events.
- Script `detail.open` then `coordinator.commit`; assert exact Detail version was returned and Roadmap revision increments once.
- Return only plain model text; assert Roadmap/cursor unchanged and cycle remains uncommitted until bounded failure handling.
- Submit invalid dependency cycle, assert stable invariant paths/codes in replacement Manifest, then repaired proposal commits.
- Kill after model response before commit, resume, and assert same event range with no projection change.
- Kill immediately after durable commit, resume, and assert next cursor/revision plus one dispatch.
- Assemble same revision/event range twice and assert byte-identical Manifest/request hash.

- [ ] **Step 2: Run and verify missing cycle runtime**

Run: `cd packages/opencode && bun test test/adaptive/coordinator-cycle.test.ts test/adaptive/coordinator-recovery.test.ts`

Expected: FAIL because Coordinator cycle runtime/tools are absent.

- [ ] **Step 3: Implement fixed Coordinator instructions**

The prompt must state:

```text
The Requirement Baseline is immutable. The complete Roadmap is the global navigation index and must remain self-consistent. Use unresolved nodes for facts not yet known. Open only Details needed for the pending events. You may propose one complete next Roadmap, immutable Detail versions, and dispatch intents through coordinator.commit. Text does not change state. Never edit repository files, select another model, or summarize away a contract signature.
```

- [ ] **Step 4: Implement Coordinator tools**

Coordinator catalog contains `detail.open`, `coordinator.commit`, `dependency.report`, and `conflict.raise` (the last records a proposed conflict but Stage 5 handles user interaction). It excludes edit/write/apply_patch/bash. `coordinator.commit` validates schema and stores proposal on the open cycle; it does not commit directly from the Tool execute closure.

- [ ] **Step 5: Implement one-cycle execution**

`wake(taskID)`:

1. Reconcile or begin cycle at Task current revision and Coordinator cursor.
2. Snapshot events through current latest Task sequence.
3. Assemble exact Requirement, full Roadmap, pending event summaries, referenced Details, and previous rejection codes.
4. Run a Coordinator process until it submits a proposal or a bounded 12-turn allowance is reached.
5. Ask CoordinatorStore to commit; on stale revision discard the proposal and begin a fresh cycle.
6. On invariant rejection start a fresh generation/cycle with stable errors; after three identical invalid proposals fail Task with `coordinator_invalid_proposal_loop`.

- [ ] **Step 6: Run cycle and forced-loss tests**

Run: `cd packages/opencode && bun test test/adaptive/coordinator-cycle.test.ts test/adaptive/coordinator-recovery.test.ts --timeout 60000 && bun typecheck`

Expected: PASS; no duplicate dispatch/event consumption.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/adaptive/coordinator packages/opencode/src/adaptive/context/assembler.ts packages/opencode/src/adaptive/tool/gateway.ts packages/opencode/test/adaptive/coordinator-cycle.test.ts packages/opencode/test/adaptive/coordinator-recovery.test.ts
git commit -m "feat(adaptive): run transactional coordinator cycles"
```

## Task 5: R0, Roadmap Reviewer, and Single-Node Fast Path

**Files:**

- Create: `packages/opencode/src/adaptive/coordinator/roadmap-init.ts`
- Modify: `packages/opencode/src/adaptive/controller.ts`
- Test: `packages/opencode/test/adaptive/roadmap-init.test.ts`

- [ ] **Step 1: Write initialization decision tests**

Required cases:

```text
empty workspace -> Roadmap may contain unresolved/discovery, no fabricated existing modules
simple one-file requirement -> deterministic single node, reviewer skipped
multi-module requirement -> Coordinator R0 then fresh Roadmap Reviewer
high-risk migration/security/public contract -> Reviewer even with one node
unknown that blocks interface/acceptance -> focused Discovery request
unknown that does not block a ready node -> unresolved item, implementation may proceed
reviewer finding errors -> Coordinator revision required before dispatch
```

- [ ] **Step 2: Run and verify initializer absent**

Run: `cd packages/opencode && bun test test/adaptive/roadmap-init.test.ts`

Expected: FAIL because `AdaptiveRoadmapInit` is absent.

- [ ] **Step 3: Implement R0 system inputs**

R0 receives exact user requirement, task mode/budgets, workspace type, project instructions, lightweight top-level repository facts, and no historical chat. It must use `coordinator.commit` with revision `1`. Unknowns use `NodeStatus.unresolved` or Roadmap unresolved entries.

- [ ] **Step 4: Implement deterministic fast-path criteria**

Fast path applies only when all are true: one observable deliverable, no public/cross-module contract, no data/security/build migration, no ambiguous acceptance, and permitted scope can be one node. It still creates full RequirementBaseline, one-node Roadmap, Detail refs, Assignment, ContextManifests, Validator later, and model audit. Coordinator never edits code.

- [ ] **Step 5: Implement fresh-context Roadmap Reviewer**

Reviewer sees Requirement, complete proposed Roadmap, ready contract Details, and workspace facts. It uses `roadmap.review.submit` with findings only. Error findings block dispatch; warnings are persisted as risk/unresolved. The same model policy is enforced by Gateway.

- [ ] **Step 6: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/roadmap-init.test.ts test/adaptive/coordinator-cycle.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/coordinator/roadmap-init.ts packages/opencode/src/adaptive/controller.ts packages/opencode/test/adaptive/roadmap-init.test.ts
git commit -m "feat(adaptive): initialize reviewed roadmaps"
```

## Task 6: Focused Discovery Workers

**Files:**

- Create: `packages/opencode/src/adaptive/discovery.ts`
- Modify: `packages/opencode/src/adaptive/tool/tools.ts`
- Modify: `packages/opencode/src/adaptive/tool/gateway.ts`
- Modify: `packages/opencode/src/adaptive/coordinator/cycle.ts`
- Test: `packages/opencode/test/adaptive/discovery.test.ts`

- [ ] **Step 1: Write read-only scope and reporting tests**

- Inspect Discovery Manifest and assert complete Roadmap plus exactly the Assignment question, blocking reason, and suggested starting facts.
- Inspect tool definitions and assert read/glob/grep/LSP/detail/report present while edit/write/apply_patch/bash absent.
- Submit a report and assert inspected paths/symbols/commands, answer, evidence refs, and remaining unknowns persist.
- Create an unbounded multi-question scan assignment and assert typed rejection before Agent launch/model call.
- Submit proposed Detail writes; assert only `DiscoverySubmitted` exists until Coordinator commits a new Detail/Roadmap revision.
- Kill after one read, replace generation, and assert reconstruction from Assignment/events with no old model tail.

- [ ] **Step 2: Run and verify Discovery runtime absent**

Run: `cd packages/opencode && bun test test/adaptive/discovery.test.ts`

Expected: FAIL because `AdaptiveDiscovery` is absent.

- [ ] **Step 3: Implement focused Discovery Assignment**

Assignment requires one question, why it blocks node/interface/acceptance, starting Detail keys, suggested paths/symbols, and completion evidence. Reject empty, multi-question, or repository-wide wording unless the workspace itself has fewer than 100 files and the question names the expected output.

- [ ] **Step 4: Implement read-only lifecycle**

Catalog exposes read/glob/grep, LSP symbol/reference navigation, `detail.open`, and `discovery.report`. It excludes bash because read-only shell cannot be guaranteed by string inspection. Discovery may request a Controller-run read-only command as a structured report field; Controller allowlists `git status`, `git diff --stat`, and manifest inspection without invoking a shell.

- [ ] **Step 5: Route report through Coordinator**

`discovery.report` appends `DiscoverySubmitted`; it cannot write Detail or Roadmap. Coordinator wakes, reads the report/evidence, commits exact Detail versions and resolves or expands unresolved nodes.

- [ ] **Step 6: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/discovery.test.ts test/adaptive/coordinator-cycle.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/discovery.ts packages/opencode/src/adaptive/tool/tools.ts packages/opencode/src/adaptive/tool/gateway.ts packages/opencode/src/adaptive/coordinator/cycle.ts packages/opencode/test/adaptive/discovery.test.ts
git commit -m "feat(adaptive): answer focused discovery questions"
```

## Task 7: Lightweight RepoMap Navigation Facts

**Files:**

- Create: `packages/opencode/src/adaptive/repo-map.ts`
- Modify: `packages/opencode/src/adaptive/context/assembler.ts`
- Test: `packages/opencode/test/adaptive/repo-map.test.ts`

- [ ] **Step 1: Write fact-boundary tests**

Assert RepoMap includes directory/package/file, manifest build/test commands, explicit import/export strings, and symbol definition locations. Assert it does not contain inferred semantic dependencies, scheduling dependency kinds, risk, ownership, or acceptance. Empty directory returns a valid empty map. Changing one file updates only affected entries and map revision.

- [ ] **Step 2: Run and verify missing RepoMap**

Run: `cd packages/opencode && bun test test/adaptive/repo-map.test.ts`

Expected: FAIL because `AdaptiveRepoMap` is absent.

- [ ] **Step 3: Implement bounded deterministic scanning**

Use OpenCode FileSystem/Search/LSP services, repository ignore rules, and package manifests. Persist normalized relative paths and content hashes. Initial scan limits individual source files to 1 MiB and total parsed text to 50 MiB; oversized/binary entries remain file facts without content parsing. Sort by package/path/symbol.

- [ ] **Step 4: Implement explicit import/export extraction**

Use language parsers/LSP document symbols when available. For unsupported languages record only file and manifest facts. Never convert an import edge into a Roadmap dependency; Coordinator must cite code/test evidence when adding semantic edges.

- [ ] **Step 5: Add optional Context component**

Context Assembler includes a query-focused RepoMap excerpt as `requested` priority after direct Details. Full RepoMap is never mandatory and never replaces source reads.

- [ ] **Step 6: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/repo-map.test.ts test/adaptive/context-assembler.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/repo-map.ts packages/opencode/src/adaptive/context/assembler.ts packages/opencode/test/adaptive/repo-map.test.ts
git commit -m "feat(adaptive): index repository navigation facts"
```

## Task 8: Informational Detail Semantics and Management Views

**Files:**

- Modify: `packages/opencode/src/adaptive/tool/tools.ts`
- Modify: `packages/opencode/src/adaptive/coordinator/cycle.ts`
- Modify: `packages/opencode/src/cli/cmd/adaptive.ts`
- Test: `packages/opencode/test/adaptive/informational-detail.test.ts`
- Test: `packages/opencode/test/cli/adaptive-process.test.ts`

- [ ] **Step 1: Write missing-informational-Detail tests**

Three outcomes are required:

1. Worker records `not_ready`, continues unrelated work, and does not claim content was loaded.
2. Worker reports that correctness depends on the missing information; its Assignment remains admission-blocked, and Coordinator commits node status `blocked` plus an upgraded `contract` or `hard` dependency with reason.
3. Worker asks a nonblocking question; Coordinator may create Discovery while other ready nodes continue.

- [ ] **Step 2: Run and verify semantics are incomplete**

Run: `cd packages/opencode && bun test test/adaptive/informational-detail.test.ts`

Expected: FAIL because missing Detail handling is not explicit.

- [ ] **Step 3: Return typed availability from `detail.open`**

```ts
type DetailOpenResult =
  | { status: "ready"; key: string; version: number; kind: string; body: string; contentHash: string }
  | { status: "not_ready"; key: string; roadmapRevision: number; unresolvedBy: string[] }
  | { status: "superseded"; key: string; requestedVersion: number; currentVersion: number }
```

Record the exact result in the Tool event/local tail.

- [ ] **Step 4: Implement useful CLI views**

`adaptive roadmap <task> --format tree|json` prints complete nodes, status, owner, interfaces/signatures, dependencies, risks/unresolved, acceptance, and Detail keys. `adaptive detail <task> <key> [--version] --format markdown|json` prints full body/hash/source/references. No command emits raw model reasoning.

- [ ] **Step 5: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/informational-detail.test.ts test/cli/adaptive-process.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/tool/tools.ts packages/opencode/src/adaptive/coordinator/cycle.ts packages/opencode/src/cli/cmd/adaptive.ts packages/opencode/test/adaptive/informational-detail.test.ts packages/opencode/test/cli/adaptive-process.test.ts
git commit -m "feat(adaptive): expose roadmap and detail state"
```

## Task 9: Roadmap Fixture and G3 Gate

**Files:**

- Create: `fixtures/adaptive/roadmap-service/package.json`
- Create: `fixtures/adaptive/roadmap-service/REQUIREMENT.md`
- Create: `fixtures/adaptive/roadmap-service/src/import/service.ts`
- Create: `fixtures/adaptive/roadmap-service/src/storage/records.ts`
- Create: `fixtures/adaptive/roadmap-service/src/cli/import.ts`
- Create: `fixtures/adaptive/roadmap-service/test/import.test.ts`
- Create: `packages/opencode/test/adaptive/roadmap-fixture.test.ts`
- Modify: `docs/superpowers/acceptance/adaptive-runtime-v1.md`

- [ ] **Step 1: Build a fixture with a real blocking unknown**

The requirement asks for idempotent batch import, a public service contract, and CLI acceptance. Existing storage exports a transaction/idempotency primitive from a non-obvious file; project docs do not name it. Correct R0 should create a focused Discovery question for transaction/idempotency semantics, retain the CLI node as unresolved/blocked as appropriate, and avoid inventing a dependency graph from imports.

- [ ] **Step 2: Write end-to-end Roadmap assertions**

The test runs R0 + reviewer + Discovery + Coordinator revision and asserts:

```ts
expect(roadmap.nodes.map((x) => x.id)).toEqual(expect.arrayContaining(["batch-contract", "batch-service", "batch-cli"]))
expect(discoveryAssignments).toHaveLength(1)
expect(discoveryAssignments[0].question).toContain("idempotency")
expect(contractDetail.body).toContain("parameters")
expect(contractDetail.body).toContain("errors")
expect(autoSemanticDependencies).toEqual([])
expect(reviewErrorsAfterRevision).toEqual([])
```

- [ ] **Step 3: Run and fix only production failures**

Run: `cd packages/opencode && bun test test/adaptive/roadmap-fixture.test.ts`

Expected after implementation: PASS. If it fails, fix production behavior; do not weaken fixture assertions to accept vague Roadmaps.

- [ ] **Step 4: Run Stage 3 regression and packaged build**

```bash
cd packages/schema && bun test && bun typecheck
cd packages/core && bun script/migration.ts --check && bun test && bun typecheck
cd packages/opencode && bun test && bun typecheck
cd packages/opencode && bun run build --single --skip-embed-web-ui
```

Expected: all exit `0`.

- [ ] **Step 5: Request independent review**

Use `requesting-code-review`; focus on Requirement immutability, Roadmap completeness, exact Detail versions, cycle atomicity, cursor recovery, Discovery scope, reviewer independence, and RepoMap fact boundaries. Resolve findings and rerun Step 4.

- [ ] **Step 6: Commit fixture/gate evidence hooks**

```bash
git add fixtures/adaptive/roadmap-service packages/opencode/test/adaptive/roadmap-fixture.test.ts docs/superpowers/acceptance/adaptive-runtime-v1.md
git commit -m "test(adaptive): gate roadmap coordination"
```

- [ ] **Step 7: Pause for G3 user trial**

Provide the packaged binary and Program Gate G3 commands. Do not begin multi-Worker/workspace/contract implementation until the user has inspected tree and full contract Detail output, restarted Coordinator, and marked G3 `accepted`.
