# Adaptive Runtime Commercial V1 Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a commercially operable Adaptive Runtime beside the unchanged OpenCode baseline, proving that a fixed short-context model can complete long coding work through durable project state, deterministic context reconstruction, independent workers, and evidence-driven integration.

**Architecture:** `opencode run --runtime adaptive` enters a new deterministic Controller while the default `baseline` path remains byte-for-byte behavior compatible. Coordinator and Worker roles run as supervised OS processes with no provider credentials; they obtain rebuilt contexts, model streams, and coding tools through a framed stdio RPC gateway owned by the Controller. SQLite is authoritative for Task, Roadmap, Detail, Assignment, Checkpoint, Evidence, Conflict, leases, context manifests, and model audit records.

**Tech Stack:** Bun, TypeScript, Effect, Effect HttpApi, Drizzle SQLite, OpenCode V2 `@opencode-ai/llm`, canonical Core ToolRegistry, Git worktrees, OpenCode process-group supervision, Bun test.

---

## 1. Release Contract

Commercial V1 is not accepted merely because one adaptive demo completes. Release requires all of the following:

- Default `opencode run` and explicit `--runtime baseline` remain behavior compatible with frozen revision `5f7091ab4e261cca5383cbd57aa6aa589ed9ee86`.
- A Task pins one provider, resolved model, variant, effective context limit, and ModelPolicy hash before the first Agent request. The policy cannot be mutated.
- Every Agent request passes through the Model Gateway. A policy mismatch stops the request before network I/O.
- Coordinator, Discovery, Implementation, Validator, and Integration roles are independent restartable OS processes, not legacy task-tool sub-sessions.
- Every provider turn is assembled from durable external state. Unlimited chronological Session replay and compaction-generated summaries are absent from the adaptive path.
- A Worker can be killed after reading, during editing, after a failed test, and after a decision; each replacement reconstructs its state from Roadmap, Detail, Assignment, Checkpoint, worktree/diff, and unconsumed events.
- A Coordinator can be killed before and after a decision commit. Reprocessing is idempotent and cannot duplicate dispatches or skip events.
- Existing Git repositories, dirty working directories, non-Git directories, and empty directories all use the same Task semantics. Isolation backend choice is an implementation detail.
- Parallel work only crosses a contract boundary after the contract exists as versioned code/schema/stub/contract-test artifacts on an integration commit.
- Candidate completion is gated by Controller-run commands, a fresh Validator context, integration-branch verification, and evidence bound to exact commit and Roadmap revision.
- Normal mode stops on a Requirement/Roadmap conflict and supports terminal/API resolution. Benchmark mode never requests human assistance and records the autonomous resolution.
- A run with model mixing, an unaudited model request, policy drift, context-limit drift, or an unassociated helper request is finalized as `INVALID_MODEL_MIXING` and excluded from evaluation.
- Build artifacts start Worker processes successfully from the packaged binary on every supported OpenCode target; source-only execution is insufficient.
- Structured logs, status inspection, export, retention, migration, backup/restore checks, bounded resource use, and failure diagnostics are part of the release.

## 2. Fixed Technical Decisions

These decisions are implementation constraints, not options to revisit during delivery:

1. The adaptive entry point is `opencode run --runtime adaptive`; omitted `--runtime` means `baseline`.
2. Management commands live under `opencode adaptive`: `list`, `status`, `stop`, `cancel`, `resume`, `roadmap`, `detail`, `conflict`, `agent restart`, `export`, backup/retention operations, and `doctor`.
3. Public HTTP operations live under `/adaptive/task` in a typed `AdaptiveApi` HttpApi group and regenerate both generated clients.
4. Child Agent processes speak length-bounded newline-delimited JSON over stdin/stdout. Plain stdout text, malformed frames, unknown methods, oversized frames, and stale generation IDs terminate the child and are persisted as process failures.
5. The child never supplies provider/model identity to the Model Gateway. It supplies only Task ID, Agent ID, generation, ContextManifest ID, and request ID; the Controller resolves the immutable policy from SQLite.
6. Coding tool execution stays in the Controller's Location runtime. Each Adaptive Agent owns a synthetic V2 Session solely as canonical ToolRegistry/permission/output identity; adaptive context never reads that Session history.
7. ContextManifest stores the exact ordered system parts, local messages, tool catalog hash, component provenance, token estimates, omissions, and request hash used for a provider turn.
8. Roadmap is a complete global index, targeted below 50k estimated tokens. A node exposes named interface summaries and Detail keys; opening a contract Detail returns complete parameter/type/schema information.
9. Detail versions are immutable. Roadmap revisions point at exact Detail versions.
10. All state transitions use compare-and-swap on expected Roadmap revision and Agent generation. Model prose cannot advance state.
11. Large outputs are content-addressed blobs outside the repository with SQLite metadata. Roadmap and Detail contain references, not copied logs.
12. Normalized current-state tables support operations; durable events provide replay/audit. One transaction updates the projection and appends the corresponding event.
13. The Git backend creates an internal integration worktree. The snapshot backend creates a managed Git mirror for non-Git/empty workspaces. Final materialization checks the original workspace snapshot before changing user files.
14. Benchmark Workers have no network. Package acquisition is a separately audited Controller operation with registry allowlists. Model egress is available only to the Model Gateway.
15. Adaptive execution does not import or invoke Session compaction, a compaction Agent, embedding, semantic reranking, automatic semantic dependency inference, long-model fallback, legacy TaskTool, or process-local BackgroundJob ownership.
16. The stable prompt prefix uses fixed role instructions, exact Requirement Baseline, and deterministically serialized complete Roadmap. A Task-derived prompt-cache key is an optimization only and never a state/recovery dependency.

## 3. Stage Dependency Graph

```text
Stage 1: isolated execution + gateway + audit
    |
    v  USER GATE G1
Stage 2: durable state + context reconstruction + single Worker recovery
    |
    v  USER GATE G2 (research milestone: forced loss succeeds)
Stage 3: Roadmap + Detail + Coordinator + Discovery/Reviewer
    |
    v  USER GATE G3
Stage 4: multi-Worker + workspace isolation + contracts + communication
    |
    v  USER GATE G4
Stage 5: Validator + integration + conflicts + complete CLI/API workflow
    |
    v  USER GATE G5
Stage 6: security + observability + benchmark validity + release hardening
    |
    v  USER GATE G6 / COMMERCIAL V1 RELEASE
```

No implementation task from a later stage starts before the preceding gate has a written user acceptance entry in `docs/superpowers/acceptance/adaptive-runtime-v1.md`. A failed gate returns to the owning stage; it does not get waived by adding a follow-up issue.

## 4. Plan Suite

| Stage | Detailed plan | Standalone outcome |
|---|---|---|
| 1 | `docs/superpowers/plans/2026-07-17-adaptive-runtime-01-foundation.md` | Baseline isolation, immutable model policy, audited Model Gateway, safe child process, packaged `adaptive doctor` |
| 2 | `docs/superpowers/plans/2026-07-17-adaptive-runtime-02-state-context-recovery.md` | SQLite state, Context Assembler, adaptive tools, single-Worker coding, forced Worker/Coordinator reconstruction |
| 3 | `docs/superpowers/plans/2026-07-17-adaptive-runtime-03-roadmap-coordinator.md` | Complete Roadmap index, immutable Details, Coordinator cycles, Discovery, Reviewer, lightweight RepoMap |
| 4 | `docs/superpowers/plans/2026-07-17-adaptive-runtime-04-workers-contracts.md` | Multiple isolated Workers, Git/non-Git workspace backends, frozen contract artifacts, durable communication |
| 5 | `docs/superpowers/plans/2026-07-17-adaptive-runtime-05-validation-integration-operations.md` | Independent validation, integration, evidence invalidation, conflict resolution, complete CLI/API |
| 6 | `docs/superpowers/plans/2026-07-17-adaptive-runtime-06-commercial-hardening.md` | Security boundary, audit proof, observability, migration/retention, load/chaos, benchmark validity, release artifacts |

### Design-to-plan coverage

| Design responsibility | Owning implementation and proof |
|---|---|
| Baseline isolation, immutable one-model policy, Controller/Agent process boundary | Stage 1 Tasks 1-10; G1 packaged baseline/adaptive and credential/audit trial |
| Roadmap/Detail/Assignment/Checkpoint as reconstructable external state | Stage 2 Tasks 1-9; G2 forced Worker and Coordinator loss trial |
| Complete Roadmap index, transactional Coordinator, unresolved discovery, lightweight navigation-only RepoMap | Stage 3 Tasks 1-9; G3 tree/Detail/restart trial |
| Hard/contract/informational/validation dependencies, independent Workers, frozen code contracts, durable communication | Stage 4 Tasks 1-10; G4 existing/empty workspace trial |
| Authoritative commands, independent Validator, evidence invalidation, integration and L2/L3 conflict handling | Stage 5 Tasks 1-8 and 11; G5 conflict/materialization trial |
| Commercial Task list/stop/cancel/resume, PermissionV2 TTY/non-TTY/API/benchmark behavior, typed API/client/export | Stage 5 Tasks 9-10; G5 CLI/API parity trial |
| Same-model provider compatibility/retry, quotas, sandbox, secrets, observability, backup/upgrade/retention | Stage 6 Tasks 1-4 and 6-9; G6 security/soak/package trial |
| Baseline/adaptive model-use validity and controlled benchmark runner | Stage 6 Tasks 5 and 10; G6 offline verify/compare trial |

Every design section 3-20 maps to at least one row above. A requirement is not considered covered merely because a type exists: its owning gate must include behavioral evidence, and G1-G6 remain user-approved stop points.

## 5. Cross-Stage Test Layers

Every implementation task names focused tests. Each stage gate additionally runs all layers below.

### Layer A: focused red/green tests

Run only the owning test file from its package directory while implementing. A red test must fail for the asserted missing behavior, not from a syntax error or fixture failure.

### Layer B: package regressions

```bash
cd packages/schema && bun test
cd packages/schema && bun typecheck
cd packages/core && bun test
cd packages/core && bun typecheck
cd packages/opencode && bun test
cd packages/opencode && bun typecheck
```

Expected: every command exits `0`. Tests are never run from repository root.

### Layer C: API and generated-client verification

Required from Stage 5 onward, and earlier whenever a public HttpApi contract changes:

```bash
cd packages/client && bun run generate
cd packages/client && bun test
cd packages/client && bun typecheck
cd packages/opencode && bun run test:httpapi
cd packages/opencode && bun test test/server/httpapi-adaptive.test.ts test/server/httpapi-sdk.test.ts
```

Expected: generated clients have no uncommitted drift after generation; endpoint coverage/auth/effect checks and adaptive API tests exit `0`.

### Layer D: database compatibility

```bash
cd packages/core && bun script/migration.ts --check
cd packages/core && bun test test/database-migration.test.ts test/adaptive/store.test.ts
```

Expected: `No schema changes, nothing to migrate`; fresh, previous-version, interrupted-migration, and reopen tests pass.

### Layer E: packaged binary

```bash
cd packages/opencode && bun run build --single --skip-embed-web-ui
./dist/opencode-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')/bin/opencode --version
./dist/opencode-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')/bin/opencode adaptive doctor --offline --json
```

Expected: build exits `0`; version prints once; doctor returns JSON with `database`, `process`, `workspace`, and `audit` equal to `ok`. The detailed stage plans include a portable helper for Windows CI instead of relying on this POSIX path expression.

### Layer F: forced-loss and end-to-end regression

```bash
cd packages/opencode && bun test \
  test/adaptive/context-assembler.test.ts \
  test/adaptive/worker-recovery.test.ts \
  test/adaptive/coordinator-recovery.test.ts \
  test/adaptive/multi-worker.test.ts \
  test/adaptive/integration.test.ts \
  test/adaptive/model-validity.test.ts
```

Expected: all deterministic crash points pass without retries hidden in the test harness; each test asserts final repository behavior and persisted audit facts.

## 6. User Acceptance Record

Repository initialization creates this file before Stage 1, and each Gate task updates its evidence fields:

```markdown
# Adaptive Runtime V1 Acceptance

| Gate | Build revision | Date | Result | Evidence export | User notes |
|---|---|---|---|---|---|
| G1 | | | pending | | |
| G2 | | | blocked | | |
| G3 | | | blocked | | |
| G4 | | | blocked | | |
| G5 | | | blocked | | |
| G6 | | | blocked | | |
```

Only the user changes a gate result from `pending` to `accepted`. An implementation worker may attach build revision, commands, and export paths, but may not self-approve.

## 7. Gate G1: Execution Boundary

### Automated evidence

- Baseline process tests pass both with omitted `--runtime` and `--runtime baseline`.
- A fake child proves provider credentials and OpenCode auth payload are absent from its environment.
- A stale Agent generation and wrong ModelPolicy hash are rejected before the fake LLM receives a request.
- Killing the child kills its process group and settles the lease/process record.
- Packaged `adaptive doctor` launches the hidden child entry and completes its RPC handshake.
- Model audit records one resolved provider/model/variant and one request lineage.

### User trial

Using the packaged binary and a real chosen short-context model:

```bash
opencode run --runtime baseline --model "$MODEL" "Reply with exactly BASELINE_OK"
opencode run --runtime baseline --model "$MODEL" "Reply with exactly BASELINE_OK"
opencode adaptive doctor --model "$MODEL" --live --json > g1-doctor.json
opencode adaptive export --doctor g1-doctor.json --output g1-evidence
```

Required evidence:

- Both baseline commands behave identically to the frozen baseline.
- Doctor reports the exact resolved provider/model/variant, context limit, child PID/generation, successful gateway request, and `modelPolicyValid: true`.
- `g1-evidence/model-requests.jsonl` contains no second model.
- The child-process environment report contains no credential-like variable or serialized auth value.

Continuation rule: Stage 2 remains paused until G1 is marked `accepted`.

## 8. Gate G2: Context Reconstruction Milestone

### Automated evidence

- ContextManifest serialization is stable for identical state and changes when a referenced Detail/checkpoint/diff changes.
- Mandatory local context overflow pauses the node and asks Coordinator to split it or reduce semantic dependencies; only an unsplittable Requirement/complete-Roadmap boundary stops with `CONTEXT_BUDGET_UNSATISFIABLE`. Neither path truncates Requirement, Roadmap, Assignment, or direct contracts.
- Eviction order removes successful command bodies and old local tail before optional Details or failure evidence.
- Single-Worker tasks pass forced termination after code read, half edit, decision record, and failed test.
- Coordinator seed-cycle tests pass termination before commit and immediately after commit.
- Recovered Agents verify `git status`, diff, key files, and validation evidence before editing.
- A control run and four restart runs satisfy the same behavioral test; exports show no old conversation replay.

### User trial

Use the fixture under `fixtures/adaptive/recovery-counter` created by the Stage 2 plan:

```bash
opencode run --runtime adaptive --format json --model "$MODEL" --dir fixtures/adaptive/recovery-counter \
  "Implement bounded retry with cancellation exactly as described in REQUIREMENT.md" | tee g2-run.jsonl
TASK_ID="$(jq -r 'select(.type == "adaptive.task.created") | .taskID' g2-run.jsonl | head -n 1)"
opencode adaptive status "$TASK_ID" --json > g2-status-1.json
opencode adaptive agent restart "$TASK_ID" --role implementation
opencode adaptive agent restart "$TASK_ID" --role implementation
opencode adaptive resume "$TASK_ID"
opencode adaptive export "$TASK_ID" --output g2-evidence
```

Required evidence:

- Fixture tests pass from the task's result commit.
- At least two Worker generations exist and the later generation has no prior-process conversation messages.
- The latest ContextManifest contains Roadmap, Assignment, checkpoint, current diff, and events after the checkpoint.
- Recovery verification is recorded before the replacement's first edit tool call.
- Model validity is `valid` and all requests use `$MODEL`.

Continuation rule: Stage 3 remains paused until the user has inspected the changed code and G2 is marked `accepted`.

## 9. Gate G3: Roadmap and Coordinator

### Automated evidence

- R0 supports unresolved nodes without inventing interfaces.
- Roadmap reviewer catches missing acceptance, dependency cycles, and consumers without contracts.
- CAS rejects stale Coordinator proposals and replays the event batch against the new revision.
- Detail versions are immutable and every Roadmap reference resolves.
- `informational` missing Detail never pretends to be loaded; correctness impact upgrades it to `contract` or `hard` and pauses the node.
- RepoMap reports only deterministic navigation facts and cannot create Roadmap dependencies.
- Coordinator forced-loss cases do not duplicate nodes, dispatches, conflicts, or event consumption.

### User trial

Run a medium existing-repository task containing an intentionally unknown integration point:

```bash
opencode run --runtime adaptive --model "$MODEL" --dir fixtures/adaptive/roadmap-service \
  "Add idempotent batch import with a public service contract and command-level acceptance tests"
opencode adaptive roadmap "$TASK_ID" --format tree
opencode adaptive detail "$TASK_ID" contract:batch-import --format markdown
opencode adaptive agent restart "$TASK_ID" --role coordinator
opencode adaptive resume "$TASK_ID"
opencode adaptive export "$TASK_ID" --output g3-evidence
```

Required evidence:

- The tree shows the complete skeleton, unresolved discovery work, dependencies, interface summaries, acceptance, risks, and Detail keys.
- Opening `contract:batch-import` shows complete parameter/result/error/version information, not only a prose deliverable.
- After Coordinator restart, revision history remains globally self-consistent and event cursor advances exactly once.
- No automatically inferred static dependency appears as a scheduling edge.

Continuation rule: Stage 4 remains paused until the user accepts the Roadmap's usefulness as a navigation/recovery index.

## 10. Gate G4: Parallel Workers and Contracts

### Automated evidence

- Scheduler implements `hard`, `contract`, `informational`, and `validation` readiness exactly.
- A downstream worktree is based on the commit containing the frozen contract artifact.
- Changing a frozen contract pauses consumers, invalidates their evidence, and requires a new contract version.
- Two Workers cannot acquire the same write scope; disjoint scopes run concurrently.
- Durable messages are delivered once per recipient generation and survive sender/recipient restarts.
- Git, dirty Git, non-Git, and empty workspace backends all preserve original workspace state until final materialization.
- Crash points between worktree commit, state update, merge, and cleanup reconcile idempotently.

### User trial

Run both an existing-repository and empty-directory task:

```bash
opencode run --runtime adaptive --model "$MODEL" --max-workers 3 --dir fixtures/adaptive/contracts-monorepo \
  "Add the typed audit event producer, storage consumer, and CLI query in parallel"
mkdir -p /tmp/adaptive-greenfield-trial
opencode run --runtime adaptive --model "$MODEL" --max-workers 3 --dir /tmp/adaptive-greenfield-trial \
  "Build the inventory API and CLI described in $PWD/fixtures/adaptive/greenfield-inventory/REQUIREMENT.md"
```

Required evidence:

- Timeline shows at least two overlapping Worker leases using the same model policy.
- Every cross-node interface points to a compiled type/schema/stub or contract test on a specific integration commit.
- The greenfield source workspace remains empty at G4; the managed integration workspace contains a buildable application and `opencode adaptive materialize <task> --preview` shows the exact future write set. Actual source materialization is gated by Stage 5 validation.
- The existing repo's original dirty changes remain intact.
- Direct Worker communication appears as durable structured conclusions with recipients and Detail references.

Continuation rule: Stage 5 remains paused until the user runs both results and approves their code organization and contract quality.

## 11. Gate G5: Validation, Integration, Conflict, and Operations

### Automated evidence

- Controller reruns declared acceptance on candidate commit; Worker-added tests alone cannot satisfy predeclared acceptance.
- Validator receives Requirement, Roadmap, contract, diff, and evidence but no Implementation Worker reasoning/checkpoint narrative.
- Evidence invalidates on commit, Roadmap acceptance, dependency contract, or command-input hash changes.
- Clean merges are automatic; code conflicts go to Integration Worker; semantic/interface conflicts go to Coordinator.
- L3 normal-mode conflict stops all leases and returns `needs_input`; API mode resumes by conflict ID.
- Benchmark L3 conflict makes and records an autonomous decision without prompting.
- Final materialization detects workspace drift and performs no partial writes on conflict.
- CLI and generated SDK cover create/list/status/stop/cancel/resume/roadmap/detail/permission/conflict/materialize/export with identical state and error contracts.
- Normal TTY permission requests use the existing PermissionV2 interaction; normal non-TTY and benchmark execution never block on stdin, while API mode exposes a Task-scoped pending request/reply path.

### User trial

```bash
opencode run --runtime adaptive --model "$MODEL" --dir fixtures/adaptive/integration-conflict \
  "Implement the API and CLI changes in REQUIREMENT.md"
opencode adaptive list --status needs_input --json
opencode adaptive status "$TASK_ID" --watch
opencode adaptive conflict show "$TASK_ID" "$CONFLICT_ID"
opencode adaptive conflict resolve "$TASK_ID" "$CONFLICT_ID" --choice keep-requirement
opencode adaptive resume "$TASK_ID"
opencode adaptive stop "$TASK_ID" --reason "operator stop/resume trial"
opencode adaptive resume "$TASK_ID"
opencode adaptive export "$TASK_ID" --output g5-evidence
```

Required evidence:

- The terminal shows the conflict's incompatible claims, code/test evidence, impacted nodes, and concrete choices.
- No Worker remains active while the L3 conflict is open.
- Resolution creates a new Roadmap revision and resumes only newly legal nodes.
- Validator findings and merged-commit acceptance results are visible in the export.
- A second status/export through the generated SDK matches CLI state.

Continuation rule: Stage 6 remains paused until the user approves the normal terminal workflow without requiring a full-screen TUI.

## 12. Gate G6: Commercial Release and Benchmark Validity

### Automated evidence

- Upgrade from a pre-adaptive database, fresh install, interrupted migration, reopen, backup, and restore pass.
- Controller restart with orphaned Agent leases and running tools marks them interrupted, never replays side effects, and resumes through verification.
- Child and tool sandboxes deny provider/network access; controlled package acquisition is allowlisted and audited.
- Secret redaction corpus leaves no provider key, OAuth token, authorization header, or environment secret in DB/log/export.
- Resource tests enforce max Workers, turn limits, wall time, output bytes, blob quota, and database growth thresholds.
- 24-hour soak completes repeated start/kill/resume cycles without leaked processes, worktrees, locks, or SQLite corruption.
- Baseline and adaptive audit the exact same requested model. Any helper/small-model call invalidates the run.
- Cross-platform packaged smoke runs on the OpenCode build matrix; unsupported sandbox capabilities fail closed in benchmark mode.
- Release export is deterministic, includes checksums, and can be independently verified offline.

### User trial

Run the release candidate on at least one real long task and one controlled baseline/adaptive pair:

```bash
opencode benchmark run --runtime baseline --model "$MODEL" --suite adaptive-v1-dry-run --output g6-baseline
opencode benchmark run --runtime adaptive --model "$MODEL" --suite adaptive-v1-dry-run --output g6-adaptive
opencode benchmark verify g6-baseline
opencode benchmark verify g6-adaptive
opencode adaptive verify-export g6-adaptive
```

Required evidence:

- Both runs have the same resolved provider/model/variant and effective context cap.
- Both validity reports are `VALID`; otherwise no quality comparison is reported.
- Adaptive export contains restart/recovery evidence, ContextManifests, exact validation commands, result commit, and no secrets.
- The user runs the produced software and accepts correctness and maintainability.
- No severity-1 or severity-2 issue remains open; no release criterion is deferred.

Release rule: only the user may mark G6 `accepted`. That acceptance declares Commercial V1 ready; it does not claim the research hypothesis is proven until a separately approved benchmark matrix is run.

## 13. Commit and Review Policy

- Start execution in an isolated worktree created from frozen revision `5f7091ab4e261cca5383cbd57aa6aa589ed9ee86` using the `using-git-worktrees` skill.
- Use a branch name of at most three hyphen-separated words, for example `adaptive-runtime-v1`.
- Each red/green task ends with a conventional commit scoped to `schema`, `core`, `opencode`, `client`, or `adaptive`.
- Generated migration/client changes commit with the contract that required them; they are not accumulated into a final bulk commit.
- Before each user gate, run an independent code review using the `requesting-code-review` skill and resolve all correctness findings.
- A gate evidence export records the exact Git revision and dirty status. User acceptance is invalid if unrecorded working-tree changes were present.

## 14. Program Completion Check

- [x] G1 accepted: execution/gateway boundary works in packaged binary.
- [ ] G2 accepted: forced Worker and Coordinator loss reconstructs context and finishes correct code.
- [ ] G3 accepted: Roadmap/Detail/Coordinator gives a useful globally coherent navigation index.
- [ ] G4 accepted: parallel independent Workers communicate through real frozen contracts in Git and greenfield tasks.
- [ ] G5 accepted: validation, integration, conflicts, CLI, and API operate end to end.
- [ ] G6 accepted: security, observability, audit validity, migration, load, soak, and release packaging satisfy the commercial contract.
- [ ] Design document requirements have a corresponding implementation task and passing acceptance evidence.
- [ ] Baseline report and V1 evidence export are retained together for future benchmark design.
