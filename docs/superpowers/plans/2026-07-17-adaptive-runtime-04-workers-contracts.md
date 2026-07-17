# Adaptive Runtime Multi-Worker, Workspace, and Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run multiple independent coding Agents concurrently without losing global consistency, using isolated workspaces, compiled frozen contracts, deterministic dependency readiness, and durable cross-Worker communication.

**Architecture:** Scheduler computes legal work from Roadmap dependency semantics, immutable contract records, integration commit ancestry, path locks, and resource limits. Clean Git workspaces use internal integration/Worker worktrees; dirty Git, non-Git, and empty workspaces use a managed Git mirror seeded from an exact file manifest. Workers communicate through persisted messages and Detail/contract updates, never private chat history.

**Tech Stack:** Effect services, Drizzle SQLite, Git CLI through AppProcess, Core ToolRegistry, OpenCode worktree/process infrastructure, file manifests and SHA-256, Bun concurrency/integration tests.

---

## File Map

**Schema/Core**

- Modify `packages/schema/src/adaptive-operation.ts`: ContractRecord, WorkerMessage, ScheduleDecision, workspace refs.
- Modify `packages/schema/src/adaptive-event.ts`: contract/message/scheduling/workspace events.
- Extend `packages/core/src/adaptive/sql.ts`: contract, message, path lock, workspace tables.
- Create `packages/core/src/adaptive/scheduler.ts`: dependency/resource/path readiness.
- Create `packages/core/src/adaptive/contract-store.ts`: draft/freeze/supersede and consumer invalidation.
- Create `packages/core/src/adaptive/message-store.ts`: delivery/ack/restart semantics.
- Extend projector and migrations/tests.

**OpenCode runtime**

- Create `packages/opencode/src/adaptive/workspace/types.ts`: backend-neutral interfaces.
- Create `packages/opencode/src/adaptive/workspace/file-manifest.ts`: exact workspace snapshot.
- Create `packages/opencode/src/adaptive/workspace/git-backend.ts`: clean Git integration/Worker worktrees.
- Create `packages/opencode/src/adaptive/workspace/managed-backend.ts`: dirty/non-Git/empty managed mirror.
- Create `packages/opencode/src/adaptive/workspace/service.ts`: backend selection, lifecycle, reconciliation.
- Create `packages/opencode/src/adaptive/contracts.ts`: artifact verification/freeze/change orchestration.
- Create `packages/opencode/src/adaptive/communication.ts`: tools, message delivery, acknowledgements.
- Extend Controller, Coordinator, Context Assembler, Tool Gateway, recovery, and CLI status/export.
- Test workspace backends, scheduler, contracts, messages, multi-Worker overlap, crash boundaries.

**Fixtures**

- Create `fixtures/adaptive/contracts-monorepo` with typed producer/storage/CLI nodes.
- Create `fixtures/adaptive/greenfield-inventory/REQUIREMENT.md` and expected acceptance harness.
- Create end-to-end tests for clean Git, dirty Git, non-Git, and empty inputs.

## Task 1: Contract, Message, Schedule, and Workspace Contracts

**Files:**

- Modify: `packages/schema/src/adaptive-operation.ts`
- Modify: `packages/schema/src/adaptive-event.ts`
- Modify: `packages/schema/test/adaptive-contract.test.ts`
- Modify: `packages/schema/test/event-manifest.test.ts`

- [ ] **Step 1: Write failing contract round-trip tests**

```ts
test("frozen contract binds code artifacts and integration commit", () => {
  const contract = new AdaptiveOperation.ContractRecord({
    taskID: AdaptiveTask.ID.create(),
    key: "contract:audit-event",
    version: 1,
    nodeID: "audit-contract",
    state: "frozen",
    detail: new AdaptiveRoadmap.DetailRef({
      key: "contract:audit-event", kind: "contracts", version: 1, status: "ready",
    }),
    artifacts: [
      { path: "packages/contracts/src/audit-event.ts", kind: "type", contentHash: "sha256:type" },
      { path: "packages/contracts/test/audit-event.contract.test.ts", kind: "contract-test", contentHash: "sha256:test" },
    ],
    integrationCommit: "abc123",
    verificationEvidence: ["aev_contract"],
  })
  expect(contract.artifacts).toHaveLength(2)
})

test("WorkerMessage has stable recipient and Detail references", () => {
  const message = AdaptiveOperation.WorkerMessage.make({
    id: "awm_test",
    taskID: AdaptiveTask.ID.create(),
    senderAgentID: AdaptiveTask.AgentID.create(),
    senderGeneration: 2,
    recipient: { type: "node", id: "storage-consumer" },
    kind: "interface-proposal",
    subject: "AuditEvent timestamp",
    body: "Use UTC milliseconds.",
    detailRefs: [],
  })
  expect(message.recipient).toEqual({ type: "node", id: "storage-consumer" })
})
```

- [ ] **Step 2: Run and verify missing members**

Run: `cd packages/schema && bun test test/adaptive-contract.test.ts test/event-manifest.test.ts`

Expected: FAIL because contract/message/workspace records are absent.

- [ ] **Step 3: Define final wire shapes**

`ContractRecord` state is `draft|verifying|frozen|superseded`; every frozen record requires at least one `type|schema|stub|contract-test` artifact, integration commit, content hashes, and verification evidence.

`WorkerMessage` recipient is exactly one of `{ type: "agent", id }`, `{ type: "node", id }`, or `{ type: "coordinator", id: "coordinator" }`; kind is `question|answer|interface-proposal|risk|progress|handoff`; message includes subject/body/Detail refs and no raw reasoning history.

`ScheduleDecision` records Roadmap revision, ready/blocked node IDs with reason codes, selected dispatch IDs, path locks, max Worker budget, and integration commit.

`WorkspaceRef` records backend `git|managed`, source directory, managed root, integration directory/branch/head, base manifest hash, source HEAD if present, and original dirty flag.

- [ ] **Step 4: Add durable events and run schema verification**

Add `WorkspacePrepared`, `WorkspaceReconciled`, `ContractDrafted`, `ContractFrozen`, `ContractSuperseded`, `WorkerMessageSent`, `WorkerMessageDelivered`, `WorkerMessageAcknowledged`, `ScheduleComputed`, `PathLockAcquired`, and `PathLockReleased`.

Run: `cd packages/schema && bun test test/adaptive-contract.test.ts test/event-manifest.test.ts && bun typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/adaptive-operation.ts packages/schema/src/adaptive-event.ts packages/schema/test/adaptive-contract.test.ts packages/schema/test/event-manifest.test.ts
git commit -m "feat(schema): define worker collaboration contracts"
```

## Task 2: Contract, Message, Path Lock, and Workspace Persistence

**Files:**

- Modify: `packages/core/src/adaptive/sql.ts`
- Create: `packages/core/src/adaptive/contract-store.ts`
- Create: `packages/core/src/adaptive/message-store.ts`
- Modify: `packages/core/src/adaptive/recovery-store.ts`
- Modify: `packages/core/src/adaptive/projector.ts`
- Generate: `packages/core/src/database/migration/20260717120000_adaptive_worker_coordination.ts`
- Modify generated: `packages/core/src/database/migration.gen.ts`
- Modify generated: `packages/core/src/database/schema.gen.ts`
- Modify generated: `packages/core/schema.json`
- Test: `packages/core/test/adaptive/contract-store.test.ts`
- Test: `packages/core/test/adaptive/message-store.test.ts`
- Modify: `packages/core/test/adaptive/projector.test.ts`
- Modify: `packages/core/test/database-migration.test.ts`

- [ ] **Step 1: Write persistence invariants**

Cover these exact setup/action/assertions:

- Insert a verified contract candidate for integration commit `I1`, advance the integration head to unrelated `I2`, call `freeze` with expected `I1`, and assert `StaleIntegrationCommit`, no frozen version, and no `ContractFrozen` event. Repeat without verification evidence and assert `ContractNotVerified`.
- Freeze `contract:audit-event@1` with consumers `storage` and `cli`, supersede it with version `2`, and assert the returned affected-node IDs are exactly `storage,cli` in stable order while version `1` remains immutable/readable.
- Send one message to node `storage`, deliver it twice to Agent generation `1`, and assert one delivery row/event. Acknowledge it and assert a later poll returns no message.
- Deliver but do not acknowledge a message to generation `1`, settle that generation as lost, start generation `2`, and assert exactly one new delivery row for generation `2` referencing the same message ID.
- Acquire `packages/storage/src/**` for Worker A, attempt `packages/storage/src/db.ts` for Worker B, and assert `PathLockConflict` names A and neither lock row nor event is added for B.
- Expire A's lease and mark its generation lost, acquire the same normalized path for B, and assert A's lock is terminal and B owns one active lock.
- Persist a managed `WorkspaceRef`, close/reopen the database service, and assert backend, source root, managed root, integration directory/branch/head, base manifest hash, source HEAD, and dirty flag are byte-for-byte equal.

- [ ] **Step 2: Run and verify stores are missing**

Run: `cd packages/core && bun test test/adaptive/contract-store.test.ts test/adaptive/message-store.test.ts`

Expected: FAIL because stores/tables are absent.

- [ ] **Step 3: Add normalized tables**

- `adaptive_contract`: `(task_id, key, version)` primary key; node, state, Detail ref/version, artifacts JSON, integration commit, evidence JSON, content hash, superseded time.
- `adaptive_worker_message`: message ID primary key; sender/generation, recipient type/ID, kind, subject, body, Detail refs, created time.
- `adaptive_message_delivery`: `(message_id, recipient_agent_id, recipient_generation)` primary key; delivered manifest ID/time, acknowledged time.
- `adaptive_path_lock`: lock ID primary key; Task/node/Agent/generation, normalized glob, state, lease expiration.
- `adaptive_workspace`: Task primary key; backend, source/managed/integration paths, branch/head, base manifest/source HEAD, dirty flag, lifecycle state.

- [ ] **Step 4: Generate migration and implement transactional stores**

Run: `cd packages/core && bun script/migration.ts --name adaptive_worker_coordination`, rename the generated migration to `src/database/migration/20260717120000_adaptive_worker_coordination.ts`, then run `bun script/migration.ts` to refresh the registry.

Contract freeze/supersede, message send/deliver/ack, path acquire/release, and workspace state changes each append the corresponding durable event in the same transaction. ContractStore returns affected consumers by querying current Roadmap dependencies; it does not ask a model.

- [ ] **Step 5: Extend projector/migration tests**

Replay reconstructs contract/message/delivery/lock/workspace terminal state. Upgrade from Stage 3 preserves all earlier Roadmap/cycle rows.

- [ ] **Step 6: Run and commit**

Run: `cd packages/core && bun script/migration.ts --check && bun test test/adaptive/contract-store.test.ts test/adaptive/message-store.test.ts test/adaptive/projector.test.ts test/database-migration.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/core/src/adaptive packages/core/src/database packages/core/schema.json packages/core/test/adaptive packages/core/test/database-migration.test.ts
git commit -m "feat(core): persist worker coordination state"
```

## Task 3: Exact Workspace File Manifest

**Files:**

- Create: `packages/opencode/src/adaptive/workspace/types.ts`
- Create: `packages/opencode/src/adaptive/workspace/file-manifest.ts`
- Test: `packages/opencode/test/adaptive/workspace-file-manifest.test.ts`

- [ ] **Step 1: Write filesystem edge-case tests**

Use real temp directories to cover regular files, executable bit, empty directory omission, internal `.git`, ignored OpenCode state paths, symlink within root, symlink escaping root, unreadable file, concurrent source change, and deterministic order/hash. External symlink must fail closed; concurrent change must return `WorkspaceChangedDuringSnapshot`.

- [ ] **Step 2: Run and verify missing manifest**

Run: `cd packages/opencode && bun test test/adaptive/workspace-file-manifest.test.ts`

Expected: FAIL because the workspace manifest module is absent.

- [ ] **Step 3: Define manifest types and hash rules**

```ts
export type FileEntry = {
  readonly path: string
  readonly type: "file" | "symlink"
  readonly size: number
  readonly mode: number
  readonly contentHash: string
  readonly linkTarget?: string
}

export type FileManifest = {
  readonly root: string
  readonly entries: readonly FileEntry[]
  readonly hash: string
}
```

Normalize paths to POSIX repository-relative form, reject `..` and absolute entries, hash file bytes plus mode/type/path, sort by path, then hash canonical entry JSON. Capture stat before and after reading; changed size/mtime/inode aborts the snapshot.

- [ ] **Step 4: Implement explicit exclusions**

Always exclude `.git`, Adaptive managed roots, OS metadata files, and output path passed by Controller. Respect repository ignore files for generated dependencies only when copying into managed mirror, but preserve tracked/explicitly unignored source files. Record exclusion counts/reasons in workspace evidence.

- [ ] **Step 5: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/workspace-file-manifest.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/workspace/types.ts packages/opencode/src/adaptive/workspace/file-manifest.ts packages/opencode/test/adaptive/workspace-file-manifest.test.ts
git commit -m "feat(adaptive): snapshot workspace files exactly"
```

## Task 4: Clean Git Workspace Backend

**Files:**

- Create: `packages/opencode/src/adaptive/workspace/git-backend.ts`
- Create: `packages/opencode/src/adaptive/workspace/service.ts`
- Modify: `packages/opencode/src/worktree/index.ts`
- Test: `packages/opencode/test/adaptive/workspace-git.test.ts`
- Modify: `packages/opencode/test/project/worktree.test.ts`

- [ ] **Step 1: Write real Git lifecycle and crash tests**

Use real temporary Git repositories and cover these exact setup/action/assertions:

- Record the primary branch, HEAD, porcelain status, and current directory; prepare the integration worktree; assert all four primary-worktree facts are unchanged and the integration branch starts at the captured source HEAD.
- Create integration commits `I1` and `I2`, request a Worker at `I1`, and assert `git merge-base --is-ancestor I1 <worker-head>` succeeds while `I2` is absent from the Worker history.
- Assign `src/allowed/**`, change one allowed and one outside file, call `commitCandidate`, and assert a typed scope error, no candidate commit, and both modifications remain visible for inspection.
- Persist integration/Worker refs, terminate and recreate the Workspace service, call `reopen`, and assert identical directories, branches, heads, and backend without creating a second worktree.
- Inject death after `git commit` but before the workspace-head projection update, reopen, and assert the commit trailer is found once and the projection advances to that exact commit without another commit.
- Run Worker/integration cleanup, then assert the primary directory exists, its branch and HEAD are unchanged, and neither the primary branch nor its worktree registration was removed.

- [ ] **Step 2: Run and verify backend absent**

Run: `cd packages/opencode && bun test test/adaptive/workspace-git.test.ts`

Expected: FAIL because Git backend is absent.

- [ ] **Step 3: Add base-commit support to Worktree service**

Extend `makeWorktreeInfo/createFromInfo/create` with optional `baseCommit`. Git command becomes `git worktree add --no-checkout -b <branch> <directory> <baseCommit>` or detached equivalent. Preserve old default `HEAD` and all existing Worktree tests.

- [ ] **Step 4: Implement Git backend**

Prepare creates `opencode/adaptive-<task-suffix>` integration branch/worktree from captured clean source HEAD. Worker branches are `opencode/adaptive-<task-suffix>-<node-suffix>` from an explicit integration commit. Record paths/branches/head in WorkspaceStore before launch; reconcile Git facts on reopen.

- [ ] **Step 5: Enforce permitted change scope at commit**

Before `git add`, obtain porcelain status including untracked paths, normalize paths, and match Assignment globs. Reject paths outside scope and any `.git` metadata. Commit with deterministic message `adaptive(<node>): candidate <assignment-id>` and Controller-configured local author, without changing user Git config.

- [ ] **Step 6: Run backend and existing Worktree tests**

Run: `cd packages/opencode && bun test test/adaptive/workspace-git.test.ts test/project/worktree.test.ts test/project/worktree-remove.test.ts && bun typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/adaptive/workspace/git-backend.ts packages/opencode/src/adaptive/workspace/service.ts packages/opencode/src/worktree/index.ts packages/opencode/test/adaptive/workspace-git.test.ts packages/opencode/test/project/worktree.test.ts
git commit -m "feat(adaptive): isolate git worker worktrees"
```

## Task 5: Dirty Git, Non-Git, and Empty Managed Backend

**Files:**

- Create: `packages/opencode/src/adaptive/workspace/managed-backend.ts`
- Modify: `packages/opencode/src/adaptive/workspace/service.ts`
- Test: `packages/opencode/test/adaptive/workspace-managed.test.ts`

- [ ] **Step 1: Write backend-selection and preservation tests**

Required cases:

```text
clean Git -> git backend
staged, unstaged, or untracked Git change -> managed backend
non-Git populated directory -> managed backend
empty directory -> managed backend with empty initial commit
source files unchanged while Workers commit/merge
dirty staged/index state byte-for-byte unchanged
managed root survives Controller restart and reopens exact integration HEAD
external symlink/unreadable source -> Task fails before Agent request
```

- [ ] **Step 2: Run and verify managed backend absent**

Run: `cd packages/opencode && bun test test/adaptive/workspace-managed.test.ts`

Expected: FAIL because managed backend is absent.

- [ ] **Step 3: Implement managed mirror preparation**

Create `<Global.Path.data>/adaptive/workspaces/<task-id>/repository`, copy exact manifest entries with modes/symlinks, run `git init`, configure repository-local identity, `git add -A`, and create `adaptive base <manifest-hash>` commit. Empty workspace uses `git commit --allow-empty`. Create integration/Worker worktrees from this managed repository using the same backend-neutral interface.

- [ ] **Step 4: Add backend-neutral service interface**

```ts
export interface Interface {
  readonly prepare: (taskID: AdaptiveTask.ID) => Effect.Effect<WorkspaceRef, Error>
  readonly reopen: (taskID: AdaptiveTask.ID) => Effect.Effect<WorkspaceRef, Error>
  readonly createWorker: (input: CreateWorkerInput) => Effect.Effect<WorkerWorkspace, Error>
  readonly inspect: (input: InspectInput) => Effect.Effect<WorkspaceInspection, Error>
  readonly commitCandidate: (input: CommitCandidateInput) => Effect.Effect<CandidateCommit, Error>
  readonly updateIntegrationHead: (input: UpdateIntegrationHeadInput) => Effect.Effect<void, Error>
  readonly cleanupWorker: (input: CleanupWorkerInput) => Effect.Effect<void, Error>
}
```

No caller branches on backend.

- [ ] **Step 5: Run both workspace suites repeatedly**

Run: `cd packages/opencode && bun test test/adaptive/workspace-file-manifest.test.ts test/adaptive/workspace-git.test.ts test/adaptive/workspace-managed.test.ts --timeout 60000`

Expected: PASS with no worktree or managed-root leak after fixture cleanup.

- [ ] **Step 6: Commit**

```bash
git add packages/opencode/src/adaptive/workspace/managed-backend.ts packages/opencode/src/adaptive/workspace/service.ts packages/opencode/test/adaptive/workspace-managed.test.ts
git commit -m "feat(adaptive): isolate dirty and greenfield workspaces"
```

## Task 6: Deterministic Dependency Scheduler and Path Locks

**Files:**

- Create: `packages/core/src/adaptive/scheduler.ts`
- Test: `packages/core/test/adaptive/scheduler.test.ts`

- [ ] **Step 1: Write a complete readiness matrix**

Use table-driven tests:

| Dependency | Upstream/contract state | Implementation runnable | Completion runnable |
|---|---|---:|---:|
| hard | upstream integrated | yes | yes |
| hard | candidate/validating | no | no |
| contract | frozen on integration ancestor | yes | yes |
| contract | prose Detail ready, no artifact | no | no |
| informational | Detail not ready | yes | yes unless Worker upgrades |
| validation | peer implementation running | yes | no |
| validation | joint evidence valid | yes | yes |

Also test max Workers, path lock overlap, stale Roadmap dispatch, Worker base not containing contract commit, failed/lost Worker replacement, and stable priority ordering.

- [ ] **Step 2: Run and verify scheduler absent**

Run: `cd packages/core && bun test test/adaptive/scheduler.test.ts`

Expected: FAIL because `AdaptiveScheduler` is absent.

- [ ] **Step 3: Implement pure schedule computation**

```ts
export type Input = {
  readonly roadmap: AdaptiveRoadmap.Info
  readonly contracts: readonly AdaptiveOperation.ContractRecord[]
  readonly integrationHead: string
  readonly isAncestor: (ancestor: string, descendant: string) => boolean
  readonly agents: readonly AgentRecord[]
  readonly locks: readonly PathLock[]
  readonly maxWorkers: number
}

export const compute: (input: Input) => AdaptiveOperation.ScheduleDecision
```

Pure compute returns reason codes for every blocked node. Side-effecting service persists `ScheduleComputed`, atomically acquires selected path locks, creates Assignments, then launches Workers. Sort priority by explicit Coordinator dispatch order, critical dependency depth, node ID.

- [ ] **Step 4: Implement path overlap rules**

Normalize globs. Exact file/file and directory-prefix overlaps conflict; wildcard overlap uses a conservative intersection check and blocks when disjointness cannot be proven. Read-only Discovery takes no write lock. Integration worktree has a separate exclusive merge lock.

- [ ] **Step 5: Run and commit**

Run: `cd packages/core && bun test test/adaptive/scheduler.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/core/src/adaptive/scheduler.ts packages/core/test/adaptive/scheduler.test.ts
git commit -m "feat(core): schedule dependency-safe workers"
```

## Task 7: Frozen Contract Artifact Workflow

**Files:**

- Create: `packages/opencode/src/adaptive/contracts.ts`
- Modify: `packages/opencode/src/adaptive/coordinator/tools.ts`
- Modify: `packages/opencode/src/adaptive/tool/tools.ts`
- Modify: `packages/opencode/src/adaptive/controller.ts`
- Test: `packages/opencode/test/adaptive/contracts.test.ts`

- [ ] **Step 1: Write artifact/freeze/change tests**

Cover these exact setup/action/assertions with a real temporary repository:

- Propose a Detail containing a prose signature but no code/schema/stub/contract-test artifact, call freeze, and assert `ContractArtifactRequired`, draft status, and zero scheduler-ready consumers.
- Commit a type plus executable contract test, make typecheck fail, and assert state remains `verifying`; fix typecheck on a new integration commit, rerun, and assert frozen state, evidence ID, commit, and both artifact hashes.
- Freeze on integration commit `I1`, dispatch a consumer, and assert its base commit descends from `I1` and `git show I1:<path>` hashes equal the frozen artifact records.
- Change the frozen signature and submit Roadmap revision `r+1`; assert L2 impact, affected consumers have Roadmap status `blocked` before another tool call, their Assignments are stale, path locks released, and checkpoint/evidence records invalidated with the new contract key/version.
- Claim an artifact path/hash that is missing or different in the integration tree, and assert freeze fails with the exact path plus expected/observed hash and writes no frozen record.
- Supersede version `1` with version `2`, then read both versions and assert version `1` body/artifacts/hash/commit are unchanged while current lookup returns version `2`.

- [ ] **Step 2: Run and verify workflow absent**

Run: `cd packages/opencode && bun test test/adaptive/contracts.test.ts`

Expected: FAIL because contract runtime is absent.

- [ ] **Step 3: Implement contract preparation**

Coordinator creates a dedicated `contract-preparation` node/Assignment when a new consumer-visible boundary has no existing implementation. Implementation Worker must write at least one type/schema/stub artifact and one executable contract test or compiler assertion. `contract.propose` records artifact paths and intended Detail version; it does not freeze.

- [ ] **Step 4: Verify and freeze on integration commit**

Controller commits candidate, clean-merges contract preparation into integration, runs declared typecheck/contract commands there, hashes artifacts from the commit tree, writes validation evidence, and calls ContractStore.freeze. Only then Scheduler may create consumer worktrees from that integration commit.

- [ ] **Step 5: Handle frozen contract changes**

Roadmap Validator classifies change L2. Controller pauses affected Agents before accepting new tool calls, marks their Assignments stale, releases path locks, invalidates their evidence/checkpoints, supersedes old contract, integrates/verifies next version, then redispatches from the new commit.

- [ ] **Step 6: Run contract/scheduler/workspace tests**

Run: `cd packages/opencode && bun test test/adaptive/contracts.test.ts test/adaptive/workspace-git.test.ts test/adaptive/workspace-managed.test.ts`

Run: `cd packages/core && bun test test/adaptive/contract-store.test.ts test/adaptive/scheduler.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/adaptive/contracts.ts packages/opencode/src/adaptive/coordinator/tools.ts packages/opencode/src/adaptive/tool/tools.ts packages/opencode/src/adaptive/controller.ts packages/opencode/test/adaptive/contracts.test.ts
git commit -m "feat(adaptive): freeze executable contracts"
```

## Task 8: Durable Cross-Worker Communication

**Files:**

- Create: `packages/opencode/src/adaptive/communication.ts`
- Modify: `packages/opencode/src/adaptive/tool/tools.ts`
- Modify: `packages/opencode/src/adaptive/context/assembler.ts`
- Modify: `packages/opencode/src/adaptive/coordinator/cycle.ts`
- Test: `packages/opencode/test/adaptive/communication.test.ts`

- [ ] **Step 1: Write delivery/restart/global-impact tests**

Cover direct agent/node/coordinator recipients, one delivery per generation, ack, replacement redelivery, sender death after send commit, recipient death before ack, Detail ref resolution, and global contract proposal routed to Coordinator. Assert no sender conversation text appears in recipient context.

- [ ] **Step 2: Run and verify communication runtime absent**

Run: `cd packages/opencode && bun test test/adaptive/communication.test.ts`

Expected: FAIL because communication runtime is absent.

- [ ] **Step 3: Implement tools**

`communication.send` validates sender generation, recipient existence, subject/body bounds, and referenced Details; appends durable message. `communication.ack` acknowledges only a message delivered to current Agent/generation. Messages containing interface/dependency/global risk kinds also wake Coordinator.

- [ ] **Step 4: Assemble message conclusions, not chat**

Context Assembler includes pending/delivered-unacked messages as strong components with message ID/sender/node/subject/body/Detail refs. It never loads sender manifests, model text, tool history, or checkpoint reasoning.

- [ ] **Step 5: Run and commit**

Run: `cd packages/opencode && bun test test/adaptive/communication.test.ts test/adaptive/context-assembler.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/communication.ts packages/opencode/src/adaptive/tool/tools.ts packages/opencode/src/adaptive/context/assembler.ts packages/opencode/src/adaptive/coordinator/cycle.ts packages/opencode/test/adaptive/communication.test.ts
git commit -m "feat(adaptive): persist worker communication"
```

## Task 9: Multi-Worker Controller, Clean Integration, and Crash Reconciliation

**Files:**

- Modify: `packages/opencode/src/adaptive/controller.ts`
- Create: `packages/opencode/src/adaptive/integration-clean.ts`
- Modify: `packages/opencode/src/adaptive/recovery.ts`
- Modify: `packages/opencode/src/cli/cmd/adaptive.ts`
- Test: `packages/opencode/test/adaptive/multi-worker.test.ts`

- [ ] **Step 1: Write overlapping execution and crash tests**

Use real supervised processes and Git:

- Block two disjoint fake Workers on separate Deferreds, release them after both leases are active, and assert their `[startedAt, settledAt]` intervals overlap and their permitted paths do not.
- Seed five ready nodes with `maxWorkers=2`, record active-process count at every transition, and assert the maximum is exactly `2` and all five eventually receive one Assignment.
- Submit two candidates concurrently, instrument integration-lock entry/exit, and assert intervals never overlap, integration history contains each operation trailer once, and stored integration head equals Git HEAD.
- Inject death after the merge commit but before operation/state update, restart Controller, and assert the existing trailer settles the same operation and no duplicate merge commit appears.
- Inject death after state update but before Worker cleanup, restart, and assert the operation remains settled, the Worker worktree/branch and lease are cleaned exactly once, and integration HEAD is unchanged.
- Integrate upstream node A so B becomes ready, capture B's Assignment/base, and assert A's integration commit is an ancestor of B's Worker HEAD.
- Run Coordinator, two Implementation Workers, and a contract preparation role concurrently; query every model audit row and assert one provider/model/variant/policy hash/effective limit and no unaudited request.

- [ ] **Step 2: Run and verify Controller is single-Worker only**

Run: `cd packages/opencode && bun test test/adaptive/multi-worker.test.ts`

Expected: FAIL because multi-Worker scheduling/clean integration is absent.

- [ ] **Step 3: Implement Controller scheduling loop**

After each committed event batch, compute schedule, acquire locks, create Assignments/workspaces/tool Sessions, and launch up to max Workers. Agent completion wakes Controller. Candidate commits queue behind one integration lock. Do not hold the scheduler/DB lock during process startup or model/tool execution.

- [ ] **Step 4: Implement clean merge only**

`integration-clean.ts` checks candidate base is an integration ancestor, runs `git merge --no-ff --no-edit <candidate>` in integration worktree, and succeeds only with no conflict. On conflict abort merge and emit a pending integration-conflict event for Stage 5. After clean merge, update integration head and node status atomically; Stage 5 adds Validator and post-merge evidence gate.

- [ ] **Step 5: Reconcile Git/DB split-brain**

Every merge uses a durable operation ID in commit trailer `Adaptive-Operation: <id>`. Startup scans integration commits after stored head. If trailer corresponds to an open operation, finish DB update; if DB says merged but Git head lacks commit, stop Task as corruption. Never repeat a merge whose trailer is present.

- [ ] **Step 6: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/multi-worker.test.ts test/adaptive/contracts.test.ts test/adaptive/communication.test.ts --timeout 90000 && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/controller.ts packages/opencode/src/adaptive/integration-clean.ts packages/opencode/src/adaptive/recovery.ts packages/opencode/src/cli/cmd/adaptive.ts packages/opencode/test/adaptive/multi-worker.test.ts
git commit -m "feat(adaptive): coordinate parallel workers"
```

## Task 10: Existing and Greenfield Fixtures, Materialization Preview, and G4 Gate

**Files:**

- Create: `fixtures/adaptive/contracts-monorepo/REQUIREMENT.md`
- Create: `fixtures/adaptive/contracts-monorepo/package.json`
- Create: `fixtures/adaptive/contracts-monorepo/packages/contracts/package.json`
- Create: `fixtures/adaptive/contracts-monorepo/packages/contracts/src/audit-event.ts`
- Create: `fixtures/adaptive/contracts-monorepo/packages/contracts/test/audit-event.contract.test.ts`
- Create: `fixtures/adaptive/contracts-monorepo/packages/producer/package.json`
- Create: `fixtures/adaptive/contracts-monorepo/packages/producer/src/index.ts`
- Create: `fixtures/adaptive/contracts-monorepo/packages/producer/test/producer.test.ts`
- Create: `fixtures/adaptive/contracts-monorepo/packages/storage/package.json`
- Create: `fixtures/adaptive/contracts-monorepo/packages/storage/src/index.ts`
- Create: `fixtures/adaptive/contracts-monorepo/packages/storage/test/storage.test.ts`
- Create: `fixtures/adaptive/contracts-monorepo/packages/cli/package.json`
- Create: `fixtures/adaptive/contracts-monorepo/packages/cli/src/index.ts`
- Create: `fixtures/adaptive/contracts-monorepo/packages/cli/test/cli.test.ts`
- Create: `fixtures/adaptive/contracts-monorepo/notes/local.txt`
- Create: `fixtures/adaptive/greenfield-inventory/REQUIREMENT.md`
- Create: `fixtures/adaptive/greenfield-inventory/acceptance.test.ts`
- Create: `packages/opencode/test/adaptive/contracts-fixture.test.ts`
- Create: `packages/opencode/test/adaptive/greenfield-fixture.test.ts`
- Modify: `packages/opencode/src/adaptive/workspace/service.ts`
- Modify: `packages/opencode/src/cli/cmd/adaptive.ts`
- Modify: `docs/superpowers/acceptance/adaptive-runtime-v1.md`

- [ ] **Step 1: Create the contracts monorepo fixture**

It contains packages `contracts`, `producer`, `storage`, and `cli`. Requirement asks for typed audit event producer/storage/query. Producer and storage can run in parallel only after `AuditEvent` type/schema and contract test are integrated. Existing dirty user file `notes/local.txt` must remain byte-identical and staged state unchanged.

- [ ] **Step 2: Create the empty-workspace acceptance harness**

Requirement specifies an inventory HTTP API plus CLI, persistence, input validation, build/test commands, and README operations. Acceptance harness is outside the generated workspace and invokes the result through public commands; it does not prescribe internal file layout.

- [ ] **Step 3: Write end-to-end fixture tests**

Contracts fixture asserts overlapping Worker intervals, exact contract ancestor/artifact hashes, clean merges, all package tests, and preserved dirty source. Greenfield fixture starts from a truly empty directory, runs managed backend, builds/tests integration result, and asserts source remains empty until explicit materialization preview/apply.

- [ ] **Step 4: Implement materialization preview without source writes**

`opencode adaptive materialize <task> --preview` compares base/result/current manifests and reports creates/updates/deletes/mode changes with a stable preview hash. Stage 4 has no `--apply` path: users run and inspect the managed integration workspace. Stage 5 adds validated atomic apply, drift handling, and rollback before any Task can materialize into the source workspace.

- [ ] **Step 5: Run fixtures and Stage 4 suites**

```bash
cd packages/opencode && bun test \
  test/adaptive/contracts-fixture.test.ts \
  test/adaptive/greenfield-fixture.test.ts \
  test/adaptive/multi-worker.test.ts \
  test/adaptive/contracts.test.ts \
  test/adaptive/communication.test.ts \
  test/adaptive/workspace-git.test.ts \
  test/adaptive/workspace-managed.test.ts --timeout 120000
cd packages/schema && bun test && bun typecheck
cd packages/core && bun script/migration.ts --check && bun test && bun typecheck
cd packages/opencode && bun test && bun typecheck
cd packages/opencode && bun run build --single --skip-embed-web-ui
```

Expected: all exit `0`.

- [ ] **Step 6: Request independent review**

Use `requesting-code-review`; inspect path isolation, dirty workspace preservation, symlink handling, Git reconciliation, lock expiry, scheduler dependency matrix, contract artifact ancestry, message delivery, and model identity across concurrent Agents. Resolve findings and rerun Step 5.

- [ ] **Step 7: Commit fixtures and gate hooks**

```bash
git add fixtures/adaptive/contracts-monorepo fixtures/adaptive/greenfield-inventory packages/opencode/test/adaptive/contracts-fixture.test.ts packages/opencode/test/adaptive/greenfield-fixture.test.ts packages/opencode/src/adaptive/workspace/service.ts packages/opencode/src/cli/cmd/adaptive.ts docs/superpowers/acceptance/adaptive-runtime-v1.md
git commit -m "test(adaptive): gate contract-safe parallel work"
```

- [ ] **Step 8: Pause for G4 user trial**

Provide packaged binary, both Program Gate G4 commands, integration workspace paths, materialization previews, and audit export. Do not begin independent validation/integration conflict work until the user runs both results, checks code organization/contracts, and marks G4 `accepted`.
