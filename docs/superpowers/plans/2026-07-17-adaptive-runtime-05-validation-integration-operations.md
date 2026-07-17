# Adaptive Runtime Validation, Integration, and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete adaptive Tasks only through reproducible independent validation and integration evidence, while providing recoverable terminal/API conflict and operations workflows.

**Architecture:** Candidate commits first pass Controller-run predeclared acceptance and a fresh Validator Agent that sees requirement/contracts/diff/evidence but not Implementation Worker history. Integration uses an operation journal and exclusive worktree; code conflicts go to a constrained Integration Worker, semantic/contract conflicts return to Coordinator, and L3 Requirement/Roadmap conflicts stop the entire normal-mode Task. Typed CLI/HttpApi surfaces expose the same durable state and conflict IDs.

**Tech Stack:** Effect services/HttpApi, Drizzle SQLite, AppProcess/Git worktrees, Adaptive Agent processes, generated TypeScript clients, content-addressed evidence blobs, Bun tests and subprocess/API fixtures.

---

## File Map

**Schema/Core**

- Modify `packages/schema/src/adaptive-operation.ts`: Evidence, ValidationReport, IntegrationOperation, Conflict, FinalResult.
- Modify `packages/schema/src/adaptive-event.ts`: validation/integration/conflict/completion events.
- Extend `packages/core/src/adaptive/sql.ts`: evidence, validation report, integration operation, conflict tables.
- Create `packages/core/src/adaptive/evidence-store.ts`: binding/invalidation/query.
- Create `packages/core/src/adaptive/conflict-store.ts`: open/resolve and mode rules.
- Create `packages/core/src/adaptive/completion.ts`: deterministic completion predicate.
- Extend projector/migrations/tests.

**Runtime**

- Create `packages/opencode/src/adaptive/validation/command-runner.ts`.
- Create `packages/opencode/src/adaptive/validation/validator.ts`.
- Create `packages/opencode/src/adaptive/validation/invalidation.ts`.
- Replace `integration-clean.ts` with `integration/operation.ts`, `integration/worker.ts`, `integration/materialize.ts` while preserving clean path.
- Create `packages/opencode/src/adaptive/conflict.ts`.
- Create `packages/opencode/src/adaptive/export.ts`.
- Extend Controller, Coordinator, Context Assembler, Tool Gateway, communication, recovery, CLI.

**HTTP/API/client**

- Create `packages/opencode/src/server/routes/instance/httpapi/groups/adaptive.ts`.
- Create `packages/opencode/src/server/routes/instance/httpapi/handlers/adaptive.ts`.
- Modify `packages/opencode/src/server/routes/instance/httpapi/api.ts` and `server.ts`.
- Modify `packages/opencode/test/server/httpapi-exercise/index.ts` for complete route/auth/effect coverage.
- Create `packages/opencode/test/server/httpapi-adaptive.test.ts`.
- Regenerate `packages/client/src/generated/client-error.ts`, `client.ts`, `index.ts`, and `types.ts` through `packages/client/script/build.ts`.
- Regenerate `packages/client/src/generated-effect/client-error.ts`, `client.ts`, and `index.ts` through the same script.
- Extend `packages/opencode/test/server/httpapi-sdk.test.ts`.

**Fixture**

- Create `fixtures/adaptive/integration-conflict` and `packages/opencode/test/adaptive/integration-conflict-fixture.test.ts`.

## Task 1: Evidence, Validation, Integration, Conflict, and Final Result Contracts

**Files:**

- Modify: `packages/schema/src/adaptive-operation.ts`
- Modify: `packages/schema/src/adaptive-event.ts`
- Modify: `packages/schema/test/adaptive-contract.test.ts`
- Modify: `packages/schema/test/event-manifest.test.ts`

- [ ] **Step 1: Write failing wire-contract tests**

```ts
test("Evidence binds exact code, Roadmap, contracts, and command inputs", () => {
  const evidence = new AdaptiveOperation.Evidence({
    id: "aev_test",
    taskID: AdaptiveTask.ID.create(),
    nodeID: "api",
    kind: "command",
    status: "valid",
    commit: "abc123",
    roadmapRevision: 7,
    contractHashes: ["sha256:contract"],
    inputHash: "sha256:input",
    command: "bun test test/api.test.ts",
    exitCode: 0,
    stdoutBlob: "sha256:stdout",
    stderrBlob: "sha256:stderr",
    timeCreated: 1,
  })
  expect(evidence.status).toBe("valid")
})

test("L3 conflict exposes evidence, impact, and concrete choices", () => {
  const conflict = AdaptiveOperation.Conflict.make({
    id: "acf_test",
    taskID: AdaptiveTask.ID.create(),
    level: "L3_REQUIREMENT",
    status: "open",
    title: "Requirement contradicts frozen public behavior",
    claims: ["Requirement requires X", "accepted interface requires not-X"],
    evidence: ["aev_test"],
    affectedNodes: ["api", "cli"],
    choices: [
      { id: "keep-requirement", label: "Keep requirement", consequence: "replace interface" },
      { id: "keep-roadmap", label: "Keep roadmap", consequence: "requirement cannot be met" },
    ],
  })
  expect(conflict.choices).toHaveLength(2)
})
```

- [ ] **Step 2: Run and verify missing contracts**

Run: `cd packages/schema && bun test test/adaptive-contract.test.ts test/event-manifest.test.ts`

Expected: FAIL because evidence/conflict/final result schemas are absent.

- [ ] **Step 3: Define final operational contracts**

`Evidence` kind is `command|build|test|runtime|validator|contract|integration|model-audit`; status is `valid|failed|invalidated`; fields include exact commit, Roadmap revision, sorted contract hashes, input hash, command/exit where applicable, bounded summary, stdout/stderr/blob refs, invalidation reason/time.

`ValidationReport` has Validator Agent/generation, candidate commit, requirement/contract/diff/evidence input hashes, findings with severity `error|warning|note`, omitted-context manifest, and verdict `accept|rework|escalate`.

`IntegrationOperation` has candidate/integration base/current heads, operation state, conflicted paths, resolution Worker, result commit, pre/post evidence, and journal ID.

`Conflict` has ID, level L2/L3, mode, claims, evidence, affected nodes, concrete choices, status `open|resolved|cancelled`, resolution source/reason/times.

`FinalResult` has Task/result commit/materialized directory, Roadmap revision, required-node status, global Evidence IDs, model validity proof, unresolved risks, export hash, and status `completed|failed|invalid`.

- [ ] **Step 4: Add durable events**

Add `EvidenceRecorded`, `EvidenceInvalidated`, `ValidationRequested`, `ValidationSubmitted`, `IntegrationStarted`, `IntegrationConflictDetected`, `IntegrationCommitted`, `ConflictOpened`, `ConflictResolved`, `MaterializationStarted`, `MaterializationCommitted`, `MaterializationRolledBack`, `TaskStopped`, `TaskResumed`, `TaskCancelled`, and `TaskCompleted`.

- [ ] **Step 5: Run and commit**

Run: `cd packages/schema && bun test test/adaptive-contract.test.ts test/event-manifest.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/schema/src/adaptive-operation.ts packages/schema/src/adaptive-event.ts packages/schema/test/adaptive-contract.test.ts packages/schema/test/event-manifest.test.ts
git commit -m "feat(schema): define adaptive validation operations"
```

## Task 2: Evidence Store and Deterministic Invalidation

**Files:**

- Modify: `packages/core/src/adaptive/sql.ts`
- Create: `packages/core/src/adaptive/evidence-store.ts`
- Create: `packages/core/src/adaptive/completion.ts`
- Modify: `packages/core/src/adaptive/projector.ts`
- Generate: `packages/core/src/database/migration/20260717130000_adaptive_validation_state.ts`
- Modify generated: `packages/core/src/database/migration.gen.ts`
- Modify generated: `packages/core/src/database/schema.gen.ts`
- Modify generated: `packages/core/schema.json`
- Test: `packages/core/test/adaptive/evidence-store.test.ts`
- Test: `packages/core/test/adaptive/completion.test.ts`
- Modify: `packages/core/test/adaptive/projector.test.ts`
- Modify: `packages/core/test/database-migration.test.ts`

- [ ] **Step 1: Write binding/invalidation/completion tests**

Cover these exact setup/action/assertions:

- Insert valid command evidence for canonical input hash `H1`, request the same command at the same commit/Roadmap/contracts/environment policy, and assert the same Evidence ID is returned without executing the command or appending another evidence event.
- Starting from valid evidence, independently change candidate commit, acceptance text/hash, one contract hash, normalized command, and environment-policy hash; assert five separate invalidation reason codes and that none of the old Evidence IDs are reusable.
- Change node A's local acceptance while node B has evidence with no dependency on A; assert only A and its declared consumers invalidate and B remains `valid` with the same ID.
- Store failed evidence, rerun the exact input successfully, and assert two immutable records with different IDs/statuses; the failed record's blobs, exit code, and timestamp do not change.
- Evaluate completion for five fixtures that differ only by candidate-not-integrated node, open conflict, active Agent/lease, invalid model proof, or stale global evidence; assert five stable rejection codes and no `TaskCompleted`/FinalResult.
- Mark every required node integrated at head `I7`, settle all Agents, provide valid global evidence bound to `I7` and a valid model proof, and assert one completed FinalResult whose commit/evidence/node set exactly matches those inputs.

- [ ] **Step 2: Run and verify missing services**

Run: `cd packages/core && bun test test/adaptive/evidence-store.test.ts test/adaptive/completion.test.ts`

Expected: FAIL because EvidenceStore/completion predicate are absent.

- [ ] **Step 3: Add tables**

`adaptive_evidence`: Evidence ID primary key; Task/node/kind/status, commit, Roadmap revision, contract hashes JSON, input hash, command, exit code, summary, blob refs, invalidation fields/times. Index by Task/node/status and Task/commit.

`adaptive_validation_report`: report ID primary key; Task/node/candidate, Validator Agent/generation, manifest ID, input hashes, findings/verdict, created time.

`adaptive_integration_operation`: operation ID primary key; Task/node/candidate/base/current/result commits, state, conflict paths, Worker, journal, evidence refs, times.

`adaptive_conflict`: Conflict ID primary key; Task/level/mode/status, encoded claims/evidence/nodes/choices/resolution, times.

- [ ] **Step 4: Generate migration and implement stores**

Run: `cd packages/core && bun script/migration.ts --name adaptive_validation_state`, rename the generated migration to `src/database/migration/20260717130000_adaptive_validation_state.ts`, then run `bun script/migration.ts` to refresh the registry.

Evidence input hash uses canonical JSON of command, working directory, selected environment policy hash, commit, Roadmap revision, acceptance text, contract hashes, and relevant configuration files. Invalidation appends one event per affected evidence and never mutates its original result fields.

- [ ] **Step 5: Implement completion predicate as a pure check**

Return all stable reason codes, including `TASK_STOPPED`, `TASK_CANCELLED`, `REQUIRED_NODE_NOT_INTEGRATED`, `OPEN_CONFLICT`, `ACTIVE_AGENT`, `PENDING_PERMISSION`, `PENDING_MESSAGE`, `STALE_GLOBAL_EVIDENCE`, `WORKSPACE_NOT_MATERIALIZED`, and `INVALID_MODEL_MIXING`. No model participates.

- [ ] **Step 6: Extend replay/migration tests and commit**

Run: `cd packages/core && bun script/migration.ts --check && bun test test/adaptive/evidence-store.test.ts test/adaptive/completion.test.ts test/adaptive/projector.test.ts test/database-migration.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/core/src/adaptive packages/core/src/database packages/core/schema.json packages/core/test/adaptive packages/core/test/database-migration.test.ts
git commit -m "feat(core): bind and invalidate adaptive evidence"
```

## Task 3: Controlled Acceptance Command Runner

**Files:**

- Create: `packages/opencode/src/adaptive/validation/command-runner.ts`
- Test: `packages/opencode/test/adaptive/validation-command-runner.test.ts`

- [ ] **Step 1: Write real-process command evidence tests**

Cover success, nonzero exit, timeout/process group cleanup, stdout/stderr truncation to blob, executable/config input hash, source command from Roadmap versus Worker-added command, immutable worktree commit check, and command modifying tracked files. Any validation command that changes the worktree must fail with `VALIDATION_MUTATED_WORKTREE` and preserve diff evidence.

- [ ] **Step 2: Run and verify runner absent**

Run: `cd packages/opencode && bun test test/adaptive/validation-command-runner.test.ts`

Expected: FAIL because command runner is absent.

- [ ] **Step 3: Implement command selection and execution**

Only commands present in Requirement/Roadmap acceptance or Controller-approved repository build/test discovery count as authoritative. Worker-added tests may be included as supplementary commands but cannot replace an authoritative command.

Run through AppProcess in candidate/integration directory with stdin ignored, process group detached on POSIX, per-command timeout, 1MiB in-memory preview, full bounded blob capture, sanitized deterministic environment, and no provider credentials.

- [ ] **Step 4: Bind evidence to clean commit**

Record pre-run HEAD/status/diff hash, execute, record post-run facts, and reject evidence as invalid if commit or tracked worktree changes. Persist stdout/stderr blobs and Evidence before returning verdict.

- [ ] **Step 5: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/validation-command-runner.test.ts ../core/test/process/process.test.ts && bun typecheck`

Expected: PASS; timeout leaves no child process.

```bash
git add packages/opencode/src/adaptive/validation/command-runner.ts packages/opencode/test/adaptive/validation-command-runner.test.ts
git commit -m "feat(adaptive): run authoritative acceptance commands"
```

## Task 4: Fresh Independent Validator

**Files:**

- Create: `packages/opencode/src/adaptive/validation/validator.ts`
- Modify: `packages/opencode/src/adaptive/context/assembler.ts`
- Modify: `packages/opencode/src/adaptive/tool/tools.ts`
- Modify: `packages/opencode/src/adaptive/tool/gateway.ts`
- Modify: `packages/opencode/src/adaptive/controller.ts`
- Test: `packages/opencode/test/adaptive/validator.test.ts`

- [ ] **Step 1: Write independence and verdict tests**

Cover these exact setup/action/assertions:

- Assemble Validator input for one candidate and assert Requirement Baseline, complete Roadmap, direct contract versions/artifact hashes, candidate base/head diff, predeclared acceptance, command Evidence IDs/summaries, and known risks are present.
- Seed an Implementation checkpoint, decision rationale tail, and local model messages with unique sentinel strings; assert none occurs in Validator system/messages/components or request-hash provenance.
- Launch Validator after Implementation generation `3`; assert a distinct Agent ID/generation/session identity while every model audit field provider/model/variant/policy hash/effective limit equals the immutable Task policy.
- Return plain assistant text saying `accept` without `validation.report`; assert candidate stays `validating`, no ValidationReport exists, and bounded missing-report handling starts a fresh generation or fails explicitly.
- Submit an `error` finding with exact path/evidence; assert verdict `rework`, prior Assignment becomes stale, node returns to `ready`, evidence invalidates, and a new Assignment references the finding.
- Submit a finding that changes a frozen contract's meaning; assert verdict `escalate`, no code integration, and one Coordinator event contains contract key/version and affected consumers.
- Submit a typed accept report while a required Controller command is failed or absent; assert report persists but completion/integration remains blocked with `required_evidence_missing`.

- [ ] **Step 2: Run and verify Validator absent**

Run: `cd packages/opencode && bun test test/adaptive/validator.test.ts`

Expected: FAIL because Validator runtime is absent.

- [ ] **Step 3: Implement Validator context**

Mandatory components: fixed adversarial Validator instructions, exact Requirement, full Roadmap, current node requirements/contracts/acceptance, candidate diff, changed file contents as requested, Controller command evidence, unresolved risks, and integration base. Exclude Implementation Worker checkpoint, local messages/tail, decision prose not promoted to Detail, and tool chronology.

- [ ] **Step 4: Implement read-only Validator tool set**

Expose read/glob/grep, `detail.open`, `workspace.inspect`, `evidence.open`, and `validation.report`. Exclude every mutation/shell/report.submit tool. `validation.report` validates that each error finding names requirement/contract/file/evidence and a reproducible consequence.

- [ ] **Step 5: Wire candidate gate**

Candidate -> Controller commands -> fresh Validator -> verdict. `rework` writes findings/evidence into validation Detail and redispatches Implementation from candidate/integration as Coordinator decides. `escalate` wakes Coordinator. `accept` changes node to validating but does not integrate until merge/post-merge checks pass.

- [ ] **Step 6: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/validator.test.ts test/adaptive/context-assembler.test.ts test/adaptive/tool-gateway.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/validation/validator.ts packages/opencode/src/adaptive/context/assembler.ts packages/opencode/src/adaptive/tool/tools.ts packages/opencode/src/adaptive/tool/gateway.ts packages/opencode/src/adaptive/controller.ts packages/opencode/test/adaptive/validator.test.ts
git commit -m "feat(adaptive): validate candidates independently"
```

## Task 5: Evidence Invalidation Runtime

**Files:**

- Create: `packages/opencode/src/adaptive/validation/invalidation.ts`
- Modify: `packages/opencode/src/adaptive/coordinator/cycle.ts`
- Modify: `packages/opencode/src/adaptive/contracts.ts`
- Modify: `packages/opencode/src/adaptive/controller.ts`
- Test: `packages/opencode/test/adaptive/evidence-invalidation.test.ts`

- [ ] **Step 1: Write cross-component invalidation tests**

Start with valid candidate/integration evidence, then independently change code commit, frozen contract, acceptance command, Requirement-conflict resolution, validation dependency, and environment policy. Assert affected evidence invalidates before scheduler/completion; unrelated evidence remains valid. Restart between change and invalidation handler and assert startup reconciliation reaches the same result.

- [ ] **Step 2: Run and verify runtime invalidation absent**

Run: `cd packages/opencode && bun test test/adaptive/evidence-invalidation.test.ts`

Expected: FAIL because changes do not invalidate evidence end to end.

- [ ] **Step 3: Implement event-driven invalidation**

Subscribe to Roadmap/contract/integration/workspace/policy events. Compute new input hashes for evidence candidates, invalidate mismatches transactionally before waking Scheduler, and persist reason/source event. Startup scans valid evidence whose stored dependencies no longer match current state.

- [ ] **Step 4: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/evidence-invalidation.test.ts test/adaptive/contracts.test.ts test/adaptive/coordinator-cycle.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/validation/invalidation.ts packages/opencode/src/adaptive/coordinator/cycle.ts packages/opencode/src/adaptive/contracts.ts packages/opencode/src/adaptive/controller.ts packages/opencode/test/adaptive/evidence-invalidation.test.ts
git commit -m "feat(adaptive): invalidate stale validation evidence"
```

## Task 6: Integration Operation Journal and Integration Worker

**Files:**

- Create: `packages/opencode/src/adaptive/integration/operation.ts`
- Create: `packages/opencode/src/adaptive/integration/worker.ts`
- Remove after migration: `packages/opencode/src/adaptive/integration-clean.ts`
- Modify: `packages/opencode/src/adaptive/controller.ts`
- Modify: `packages/opencode/src/adaptive/recovery.ts`
- Test: `packages/opencode/test/adaptive/integration.test.ts`

- [ ] **Step 1: Write clean/code/semantic conflict and crash tests**

Use real temporary repositories and cover these exact setup/action/assertions:

- Clean-merge a validated candidate, record affected and global commands, and assert the node becomes `integrated` only after both command sets pass on the resulting integration commit and Evidence binds that exact commit.
- Create a textual conflict in `src/adapter.ts`, start integration, and assert an isolated resolution worktree has the unmerged index, an Integration Assignment limited to conflicted paths, relevant contracts, and the same ModelPolicy.
- In that Integration Worker attempt to edit `src/unrelated.ts`; assert Tool Gateway denial, unchanged bytes/index entry, and a durable denied `ToolSettled` event.
- Construct a conflict whose alternatives change a frozen interface signature; assert merge is aborted, no Integration Worker launches, operation becomes `semantic_conflict`, and Coordinator receives exact contract/consumer evidence.
- Make post-merge global acceptance fail; assert the integration operation records failure and restores its operation head to the prior integration commit without moving the user's branch/worktree.
- Inject process death after each journal state `prepared`, `merge_started`, `merged`, `verified`, and `state_committed`; reopen each fixture and assert one terminal operation, at most one result commit/trailer, correct evidence, and no active resolution workspace/lease.

- [ ] **Step 2: Run and verify only clean integration exists**

Run: `cd packages/opencode && bun test test/adaptive/integration.test.ts`

Expected: FAIL on conflict/validation/journal cases.

- [ ] **Step 3: Implement journaled operation states**

States: `prepared -> merge_attempted -> conflict|merged -> post_validation -> committed|reverted|escalated`. Persist expected integration head and operation ID before Git mutation. Every merge/result commit includes `Adaptive-Operation` trailer. Reconciliation compares journal, commit graph, worktree merge state, and evidence.

- [ ] **Step 4: Implement constrained Integration Worker**

On code conflict, create resolution worktree from current integration head, attempt candidate merge leaving conflict markers, and assign only conflicted paths plus relevant contracts/requirements. Worker gets edit/read/grep and controlled test tools, not arbitrary path permissions. It submits a resolution commit; Controller verifies no conflict markers/unmerged index, reruns Validator/commands, then integrates.

- [ ] **Step 5: Distinguish semantic conflict**

If conflicting changes alter frozen interface artifacts, incompatible behavior tests, Requirement interpretation, or acceptance, abort merge worktree and emit `dependency.report`/Coordinator event. Model cannot classify an L3 conflict by prose alone; Controller uses Roadmap Validator impact plus Coordinator proposal, then ConflictStore in Task 7.

- [ ] **Step 6: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/integration.test.ts test/adaptive/validator.test.ts test/adaptive/evidence-invalidation.test.ts --timeout 90000 && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/integration packages/opencode/src/adaptive/integration-clean.ts packages/opencode/src/adaptive/controller.ts packages/opencode/src/adaptive/recovery.ts packages/opencode/test/adaptive/integration.test.ts
git commit -m "feat(adaptive): integrate validated worker changes"
```

## Task 7: Requirement/Roadmap Conflict Stop and Resolution

**Files:**

- Create: `packages/core/src/adaptive/conflict-store.ts`
- Create: `packages/opencode/src/adaptive/conflict.ts`
- Modify: `packages/opencode/src/adaptive/coordinator/cycle.ts`
- Modify: `packages/opencode/src/adaptive/controller.ts`
- Modify: `packages/opencode/src/cli/cmd/adaptive.ts`
- Test: `packages/core/test/adaptive/conflict-store.test.ts`
- Test: `packages/opencode/test/adaptive/conflict.test.ts`
- Test: `packages/opencode/test/cli/adaptive-conflict-process.test.ts`

- [ ] **Step 1: Write stop/resume and mode tests**

Normal mode: open L3 stops/interrupts all Agent generations, releases no state that prevents recovery, sets Task `needs_input`, returns Conflict ID, and no provider/tool request starts until resolution. TTY displays claims/evidence/impact/choices and reads one choice. Non-TTY emits JSON/exit code `2`. API remains resumable.

Benchmark mode: never reads terminal input, asks same-model Coordinator for one typed choice/reason, commits it, and resumes autonomously. Every choice is audit-visible.

- [ ] **Step 2: Run and verify conflict workflow absent**

Run: `cd packages/core && bun test test/adaptive/conflict-store.test.ts`

Run: `cd packages/opencode && bun test test/adaptive/conflict.test.ts test/cli/adaptive-conflict-process.test.ts`

Expected: FAIL because ConflictStore/runtime are absent.

- [ ] **Step 3: Implement ConflictStore**

`open` is idempotent by Task/claims/evidence/affected-node hash, atomically marks Task `needs_input`, and records conflict event. `resolve` accepts one declared choice, resolver `user|benchmark-coordinator`, reason, expected open status, and expected Roadmap revision. A second/divergent resolution fails.

- [ ] **Step 4: Implement runtime stop barrier**

Controller stops scheduling, prevents Gateway admission and Tool Gateway mutation, requests checkpoints where safe, then stops all processes. Status shows no active leases. On resolution, Coordinator creates a new globally valid Roadmap revision, invalidation runs, and Scheduler resumes only legal nodes.

- [ ] **Step 5: Implement terminal commands**

```text
opencode adaptive conflict show <task> <conflict> [--json]
opencode adaptive conflict resolve <task> <conflict> --choice <id> [--reason <text>]
```

Interactive `run` uses the same service and choices; it does not require a full-screen TUI. Terminal input is forbidden in benchmark/non-TTY.

- [ ] **Step 6: Run tests and commit**

Run: `cd packages/core && bun test test/adaptive/conflict-store.test.ts`

Run: `cd packages/opencode && bun test test/adaptive/conflict.test.ts test/cli/adaptive-conflict-process.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/core/src/adaptive/conflict-store.ts packages/core/test/adaptive/conflict-store.test.ts packages/opencode/src/adaptive/conflict.ts packages/opencode/src/adaptive/coordinator/cycle.ts packages/opencode/src/adaptive/controller.ts packages/opencode/src/cli/cmd/adaptive.ts packages/opencode/test/adaptive/conflict.test.ts packages/opencode/test/cli/adaptive-conflict-process.test.ts
git commit -m "feat(adaptive): stop on requirement conflicts"
```

## Task 8: Atomic Workspace Materialization and Rollback

**Files:**

- Create: `packages/opencode/src/adaptive/integration/materialize.ts`
- Modify: `packages/opencode/src/adaptive/workspace/service.ts`
- Modify: `packages/opencode/src/adaptive/controller.ts`
- Modify: `packages/opencode/src/cli/cmd/adaptive.ts`
- Test: `packages/opencode/test/adaptive/materialize.test.ts`

- [ ] **Step 1: Write real-filesystem atomicity tests**

Cover create/update/delete/mode/symlink, current source drift before start, drift after preview, injected crash after each write, rollback, restart reconciliation, dirty Git index preservation, and empty-workspace apply. Hash source before/after failed operations; no partial result may remain.

- [ ] **Step 2: Run and verify Stage 4 apply lacks rollback**

Run: `cd packages/opencode && bun test test/adaptive/materialize.test.ts`

Expected: FAIL on injected crash/rollback/drift reconciliation.

- [ ] **Step 3: Implement journal and preflight**

Persist operation ID, base/result/current manifest hashes, ordered file operations, backup blob refs, and state before first write. Require current manifest equals Task base and preview hash. For clean Git require source HEAD still equals captured HEAD and worktree clean.

- [ ] **Step 4: Implement apply/rollback**

Backup affected files/modes/symlinks to BlobStore, write temp sibling + fsync + rename, apply modes, delete last, fsync parent directories. On any error restore backups in reverse order. Startup completes rollback for nonterminal journals before Task can resume.

Expose apply as `opencode adaptive materialize <task> --apply --preview-hash <hash>` and the typed Task materialize endpoint. Both call the same journal service; apply without the exact current preview hash fails before the first write. `--preview` remains read-only.

- [ ] **Step 5: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/materialize.test.ts test/adaptive/workspace-managed.test.ts test/adaptive/workspace-git.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/integration/materialize.ts packages/opencode/src/adaptive/workspace/service.ts packages/opencode/src/adaptive/controller.ts packages/opencode/src/cli/cmd/adaptive.ts packages/opencode/test/adaptive/materialize.test.ts
git commit -m "feat(adaptive): materialize results atomically"
```

## Task 9: Typed Adaptive HTTP API and Generated Clients

**Files:**

- Create: `packages/opencode/src/server/routes/instance/httpapi/groups/adaptive.ts`
- Create: `packages/opencode/src/server/routes/instance/httpapi/handlers/adaptive.ts`
- Create: `packages/opencode/src/adaptive/management.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/api.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/server.ts`
- Modify: `packages/opencode/test/server/httpapi-exercise/index.ts`
- Create: `packages/opencode/test/server/httpapi-adaptive.test.ts`
- Create: `packages/opencode/test/adaptive/management.test.ts`
- Modify: `packages/opencode/test/server/httpapi-sdk.test.ts`
- Generate: `packages/client/src/generated/client-error.ts`
- Generate: `packages/client/src/generated/client.ts`
- Generate: `packages/client/src/generated/index.ts`
- Generate: `packages/client/src/generated/types.ts`
- Generate: `packages/client/src/generated-effect/client-error.ts`
- Generate: `packages/client/src/generated-effect/client.ts`
- Generate: `packages/client/src/generated-effect/index.ts`

- [ ] **Step 1: Write API auth/contract/effect tests before routes**

Endpoints:

```text
POST   /adaptive/task
GET    /adaptive/task?status=&directory=&cursor=&limit=
GET    /adaptive/task/:taskID
POST   /adaptive/task/:taskID/resume
POST   /adaptive/task/:taskID/stop
POST   /adaptive/task/:taskID/cancel
GET    /adaptive/task/:taskID/roadmap
GET    /adaptive/task/:taskID/detail/:key?version=N
GET    /adaptive/task/:taskID/events          (SSE)
GET    /adaptive/task/:taskID/conflict/:id
POST   /adaptive/task/:taskID/conflict/:id/resolve
GET    /adaptive/task/:taskID/permission/:id
POST   /adaptive/task/:taskID/permission/:id/reply
POST   /adaptive/task/:taskID/agent/:agentID/restart
POST   /adaptive/task/:taskID/materialize
GET    /adaptive/task/:taskID/export
```

Test workspace routing, missing Task/Detail/Conflict/Permission errors, invalid choice/reply, normal/benchmark input rules, SSE replay cursor, auth, concurrent resume/stop/cancel idempotency, and exact SDK decoding.

Management-service assertions are explicit:

- Create Tasks in every status and two directories; list with status/directory/cursor/limit and assert stable `(timeUpdated desc, id)` pagination with no duplicates or cross-directory leakage.
- Stop a running Task during an idle turn and during a running tool; assert scheduling/Gateway admission closes, Agent process groups settle, the running tool becomes `interrupted` without replay, active leases reach zero, Task becomes `stopped`, and `resume` creates only legal replacement generations.
- Cancel a running, stopped, and `needs_input` Task; assert one terminal `cancelled` transition, all pending conflicts/permissions/processes settle, `resume` and materialization reject with `AdaptiveInvalidState`, and status/export/evidence remain readable.
- In normal API mode trigger PermissionV2 `ask`, fetch it only through its owning Task, reply `once|always|reject`, and assert the existing Core request settles exactly once. A wrong Task/request pair returns not found without leaking request metadata.
- In benchmark mode trigger the same tool and assert no pending PermissionV2 request/endpoints appear, denial is audit-visible, and no human reply can alter the run.

- [ ] **Step 2: Run and verify routes are missing**

Run: `cd packages/opencode && bun test test/adaptive/management.test.ts test/server/httpapi-adaptive.test.ts`

Expected: FAIL with 404 or missing `AdaptiveApi`.

- [ ] **Step 3: Declare typed group and explicit errors**

Use `HttpApiGroup.make("adaptive").add(...)`; define stable public `AdaptiveTaskNotFound`, `AdaptiveDetailNotFound`, `AdaptiveConflictNotFound`, `AdaptiveInvalidState`, and `AdaptiveRevisionConflict` Schema.ErrorClass wire contracts. Do not expose storage/domain exceptions directly.

- [ ] **Step 4: Implement deterministic Task management**

`management.ts` implements paginated list/get and compare-and-swap `resume`, `stop`, and `cancel`, appending `TaskStopped`, `TaskResumed`, or `TaskCancelled` in the same status-update transaction. `stop` is recoverable: close admissions, request a checkpoint only if no tool side effect is in flight, mark any running tool interrupted, settle process groups/leases, then persist `stopped`. `cancel` is terminal and idempotent: perform the same barrier, cancel open conflicts, reject/finalize pending PermissionV2 waits, retain durable state/export, and reject future resume/materialize. Neither operation deletes worktrees or evidence inline.

Task-scoped permission get/reply maps the synthetic Session back to the current Task/Agent and delegates to Core `PermissionV2.Service`; it never copies or reimplements rule evaluation. Normal API mode may leave `ask` pending for a client reply. Benchmark mode and non-interactive CLI mode never create a human wait.

- [ ] **Step 5: Implement handlers by yielding stable services once**

Use `HttpApiBuilder.group(InstanceHttpApi, "adaptive", ...)`. Handler closures call Controller/Store/Conflict/Export services; no `Effect.provide` in endpoint callbacks. SSE returns `HttpServerResponse.stream` and includes Task event sequence IDs for resume.

- [ ] **Step 6: Assemble routes and complete exercise matrix**

Add Adaptive group to `InstanceHttpApi`, handler layer to `instanceApiRoutes`, required Adaptive nodes to server service graph, and every endpoint to coverage/auth/effect exercise with no skip.

- [ ] **Step 7: Generate clients and verify drift**

Run: `cd packages/client && bun run generate && bun test && bun typecheck`

Expected: generated clients expose typed `adaptive` methods; commands exit `0`.

- [ ] **Step 8: Run HTTP API suites**

Run: `cd packages/opencode && bun run test:httpapi && bun test test/adaptive/management.test.ts test/server/httpapi-adaptive.test.ts test/server/httpapi-sdk.test.ts && bun typecheck`

Expected: PASS with complete exercise coverage.

- [ ] **Step 9: Commit API and generated code together**

```bash
git add packages/opencode/src/adaptive/management.ts packages/opencode/src/server/routes/instance/httpapi packages/opencode/test/adaptive/management.test.ts packages/opencode/test/server packages/client/src/generated packages/client/src/generated-effect
git commit -m "feat(opencode): expose adaptive task api"
```

## Task 10: Task Operations, Permission UX, Deterministic Export, and Completion

**Files:**

- Create: `packages/opencode/src/adaptive/export.ts`
- Modify: `packages/opencode/src/cli/cmd/adaptive.ts`
- Modify: `packages/opencode/src/cli/cmd/run.ts`
- Modify: `packages/opencode/src/cli/cmd/run/stream.transport.ts`
- Modify: `packages/opencode/src/cli/cmd/run/permission.shared.ts`
- Modify: `packages/opencode/src/adaptive/controller.ts`
- Test: `packages/opencode/test/adaptive/export.test.ts`
- Modify: `packages/opencode/test/cli/adaptive-process.test.ts`
- Create: `packages/opencode/test/cli/adaptive-permission-process.test.ts`

- [ ] **Step 1: Write management, permission, export, and parity tests**

Export same terminal Task twice to different directories and assert identical relative files/checksums after excluding export creation time. Assert CLI JSON status/roadmap/detail/conflict equals generated SDK decoded state. Inject an invalid model proof and assert export/final result say `invalid`, never `completed`.

Also assert:

- `opencode adaptive list --status running --directory <dir> --json` equals the generated SDK page, and a second page starts strictly after its cursor.
- `opencode adaptive stop <task>` leaves zero active leases and a resumable `stopped` Task; repeating stop is idempotent; resume starts a new generation without replaying an interrupted tool.
- `opencode adaptive cancel <task> --yes` produces terminal `cancelled`, retains export, and makes resume/materialize fail with stable exit code `3`; non-TTY cancel without `--yes` refuses before mutation.
- `opencode adaptive materialize <task> --preview` returns a stable hash/write set; `--apply --preview-hash <hash>` rejects drift and atomically produces the SDK-visible result.
- `opencode adaptive verify-export <directory>` succeeds offline, then fails with the exact relative path after one exported byte or `SHA256SUMS` line is changed.
- Under a pseudo-TTY, normal `run --runtime adaptive` displays the existing PermissionV2 action/resources and accepts `once`, `always`, and `reject`; the reply reaches the owning synthetic Session and the terminal returns to progress output.
- Under non-TTY normal CLI, an otherwise-`ask` permission is rejected immediately with structured `permission_required_noninteractive`, no prompt/read from stdin, no side effect, and a tool result the Agent can handle. Explicit configured allow/deny rules still apply.
- In server/API mode an `ask` remains pending and is replyable through the Task-scoped endpoint; in benchmark mode the same action is denied without a prompt, pending request, or human-input audit record.

- [ ] **Step 2: Run and verify export absent**

Run: `cd packages/opencode && bun test test/adaptive/export.test.ts test/cli/adaptive-process.test.ts test/cli/adaptive-permission-process.test.ts`

Expected: FAIL because complete Task export is absent.

- [ ] **Step 3: Add complete management commands**

```text
opencode adaptive list [--status <status>] [--directory <path>] [--cursor <cursor>] [--limit N] [--json]
opencode adaptive status <task> [--watch] [--json]
opencode adaptive stop <task> [--reason <text>]
opencode adaptive cancel <task> [--reason <text>] [--yes]
opencode adaptive resume <task>
opencode adaptive materialize <task> --preview [--json]
opencode adaptive materialize <task> --apply --preview-hash <hash>
opencode adaptive verify-export <directory>
```

Commands call the same typed services as HTTP. TTY cancel requires explicit confirmation unless `--yes`; non-TTY requires `--yes`. `status --watch` displays active roles/generations, pending conflict/permission IDs, current node, validation/integration state, and last durable event without requiring a full-screen TUI.

- [ ] **Step 4: Reuse the existing run permission interaction**

Route Adaptive synthetic-Session `permission.asked`/`permission.replied` events through the current run stream/footer and `permission.shared.ts`; do not fork the UI state machine. Attach Task/Agent/role labels, but preserve Core reply semantics. Select behavior from explicit execution channel `tty|noninteractive|server|benchmark`, never from model output. Noninteractive and benchmark paths fail closed without calling stdin; server relies on Task-scoped HTTP permission endpoints.

- [ ] **Step 5: Implement export layout**

```text
task.json
roadmap.json
roadmap.md
details/<escaped-key>/<version>.md
assignments.jsonl
checkpoints.jsonl
events.jsonl
context-manifests.jsonl
model-requests.jsonl
model-validity.json
evidence/index.jsonl
evidence/blobs/<hash>
conflicts.jsonl
git.json
result.json
SHA256SUMS
```

Sort records by stable IDs/revisions/sequences. `verify-export` parses `SHA256SUMS`, rejects duplicate/absolute/traversal paths, verifies every listed file and required layout entry offline, and reports stable missing/extra/hash-mismatch errors. Redaction hardening comes in Stage 6; this stage already excludes environment values, credentials, raw provider headers, and model reasoning deltas.

- [ ] **Step 6: Wire deterministic completion**

After integration/global acceptance/materialization, Controller calls completion predicate and model audit verification. Only a successful predicate appends `TaskCompleted` and writes FinalResult. Any model invalidity forces Task `invalid` even when code tests pass.

- [ ] **Step 7: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/management.test.ts test/adaptive/export.test.ts test/cli/adaptive-process.test.ts test/cli/adaptive-permission-process.test.ts test/adaptive/materialize.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/export.ts packages/opencode/src/cli/cmd/adaptive.ts packages/opencode/src/cli/cmd/run.ts packages/opencode/src/cli/cmd/run/stream.transport.ts packages/opencode/src/cli/cmd/run/permission.shared.ts packages/opencode/src/adaptive/controller.ts packages/opencode/test/adaptive/export.test.ts packages/opencode/test/cli/adaptive-process.test.ts packages/opencode/test/cli/adaptive-permission-process.test.ts
git commit -m "feat(adaptive): export verifiable task results"
```

## Task 11: Conflict Fixture and G5 Gate

**Files:**

- Create: `fixtures/adaptive/integration-conflict/REQUIREMENT.md`
- Create: `fixtures/adaptive/integration-conflict/package.json`
- Create: `fixtures/adaptive/integration-conflict/src/api.ts`
- Create: `fixtures/adaptive/integration-conflict/src/cli.ts`
- Create: `fixtures/adaptive/integration-conflict/test/acceptance.test.ts`
- Create: `packages/opencode/test/adaptive/integration-conflict-fixture.test.ts`
- Modify: `docs/superpowers/acceptance/adaptive-runtime-v1.md`

- [ ] **Step 1: Create code and semantic conflict paths**

Two nodes edit a shared adapter and cause a resolvable text conflict. A later fixture event introduces a Requirement/public-contract contradiction with choices `keep-requirement` and `keep-roadmap`, forcing L3 normal-mode stop. Acceptance observes API/CLI behavior, not just fixture-authored unit tests.

- [ ] **Step 2: Write full end-to-end assertions**

Assert candidate commands, independent Validator inputs/verdict, Integration Worker constrained paths, post-merge commands, L3 stop with zero active Agents, user resolution/new Roadmap revision/evidence invalidation, final global acceptance/materialization, CLI/SDK parity, and deterministic export.

- [ ] **Step 3: Run the fixture**

Run: `cd packages/opencode && bun test test/adaptive/integration-conflict-fixture.test.ts --timeout 120000`

Expected: PASS. Fix production code for any mismatch; do not bypass conflict or Validator to make the fixture green.

- [ ] **Step 4: Run complete Stage 5 verification**

```bash
cd packages/schema && bun test && bun typecheck
cd packages/core && bun script/migration.ts --check && bun test && bun typecheck
cd packages/client && bun run generate && bun test && bun typecheck
cd packages/opencode && bun run test:httpapi && bun test && bun typecheck
cd packages/opencode && bun run build --single --skip-embed-web-ui
```

Expected: every command exits `0` and no generated diff remains unstaged.

- [ ] **Step 5: Request independent review**

Use `requesting-code-review`; inspect authoritative evidence selection, Validator context independence, evidence invalidation, integration journal/revert, L3 stop barrier, benchmark autonomy, materialization rollback, API auth/error contracts, export completeness, and final completion/model gate. Resolve findings and repeat Step 4.

- [ ] **Step 6: Commit fixture/gate hooks**

```bash
git add fixtures/adaptive/integration-conflict packages/opencode/test/adaptive/integration-conflict-fixture.test.ts docs/superpowers/acceptance/adaptive-runtime-v1.md
git commit -m "test(adaptive): gate validated integration operations"
```

- [ ] **Step 7: Pause for G5 user trial**

Provide packaged binary, Task/Conflict IDs, generated client example, and Program Gate G5 commands. Do not begin commercial hardening until the user completes terminal conflict resolution, runs the result, compares CLI/API state, inspects evidence export, and marks G5 `accepted`.
