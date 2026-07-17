# Adaptive Runtime Commercial Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the complete adaptive workflow into a secure, observable, upgradeable, resource-bounded, benchmark-valid Commercial V1 release with independently verifiable artifacts.

**Architecture:** Hardening adds fail-closed configuration/quotas, same-model retry/calibration, benchmark process/network isolation, centralized secret handling, baseline-compatible model auditing, structured observability, retention/backup/restore, load/chaos/soak gates, and cross-platform packaged verification. Benchmark comparison is emitted only after both runs independently pass the same offline validity verifier.

**Tech Stack:** Effect Config/Telemetry, OpenCode LLM transports, Linux bubblewrap sandbox, AppProcess, SQLite WAL/backup, content-addressed blobs, SHA-256 manifests, Bun tests/scripts/build matrix, generated clients.

---

## File Map

**Configuration/provider resilience**

- Create `packages/schema/src/adaptive-config.ts` and `packages/schema/test/adaptive-config.test.ts`.
- Create `packages/core/src/config/adaptive.ts`: decode/merge commercial defaults.
- Extend `packages/core/src/session/runner/model.ts`: supported protocol matrix for OpenAI, Anthropic, OpenAI-compatible/Kimi/DeepSeek/OpenRouter, Google, and Bedrock.
- Create `packages/opencode/src/adaptive/provider-resilience.ts`: same-model retry, overflow retry, token calibration, rate/concurrency control.
- Extend `packages/opencode/src/adaptive/model-gateway.ts`, `packages/opencode/src/adaptive/context/assembler.ts`, and `packages/core/src/adaptive/model-audit.ts`; cover them in `packages/opencode/test/adaptive/provider-resilience.test.ts` and `provider-compatibility.test.ts`.

**Security/benchmark**

- Create `packages/opencode/src/adaptive/security/redact.ts`.
- Create `packages/opencode/src/adaptive/security/paths.ts`.
- Create `packages/opencode/src/adaptive/security/sandbox.ts`.
- Create `packages/opencode/src/adaptive/security/package-broker.ts`.
- Create `packages/opencode/src/benchmark/model-audit.ts`, `runner.ts`, `verify.ts`, `suite.ts`.
- Create `packages/opencode/src/cli/cmd/benchmark.ts`.
- Instrument `packages/opencode/src/session/llm.ts` only when a benchmark audit context is active.
- Extend `packages/opencode/src/adaptive/model-gateway.ts`, `adaptive/tool/gateway.ts`, `adaptive/validation/command-runner.ts`, `adaptive/process/command.ts`, `src/index.ts`, and `src/effect/app-runtime.ts`.

**Operations**

- Create `packages/opencode/src/adaptive/observability.ts`, `health.ts`, `retention.ts`, `backup.ts`.
- Extend `packages/opencode/src/adaptive/export.ts` with redaction and offline verification.
- Extend `packages/opencode/src/adaptive/management.ts`, `health.ts`, and `packages/opencode/src/cli/cmd/adaptive.ts` with status pagination/metrics and doctor checks.
- Add documentation under `docs/adaptive/`.

**Quality/release**

- Create the exact test/script files listed under Tasks 1-10 for security, model validity, migration/backup, quota, load, chaos, soak, and release smoke.
- Modify `packages/opencode/script/build.ts` and CI workflows for packaged platform checks.
- Create controlled `fixtures/benchmark/adaptive-v1-dry-run` suite.

## Task 1: Commercial Configuration and Resource Limits

**Files:**

- Create: `packages/schema/src/adaptive-config.ts`
- Modify: `packages/schema/src/index.ts`
- Create: `packages/schema/test/adaptive-config.test.ts`
- Create: `packages/core/src/config/adaptive.ts`
- Modify: `packages/core/src/config/config.ts`
- Test: `packages/core/test/config/adaptive.test.ts`
- Modify: `packages/opencode/src/adaptive/controller.ts`
- Modify: `packages/opencode/src/adaptive/context/assembler.ts`
- Modify: `packages/opencode/src/adaptive/process/supervisor.ts`
- Test: `packages/opencode/test/adaptive/quotas.test.ts`

- [ ] **Step 1: Write decode/default/boundary tests**

Commercial defaults:

```ts
{
  maxWorkers: 4,
  maxTaskWallMinutes: 480,
  maxAgentTurnsPerGeneration: 24,
  maxAgentGenerations: 100,
  maxProviderRetries: 4,
  maxToolOutputBytes: 1_048_576,
  maxBlobBytesPerTask: 2_147_483_648,
  maxRoadmapTokens: 50_000,
  maxDetailBytes: 262_144,
  maxPendingEvents: 10_000,
  leaseSeconds: 20,
  heartbeatSeconds: 5,
  softRestartInputRatio: 0.8,
  retentionDays: 30,
}
```

Assert invalid zero/negative values, heartbeat >= lease, ratio outside `(0,1)`, output+safety reserve >= effective context, maxWorkers above 64, and unknown fields fail decode with useful paths.

- [ ] **Step 2: Run and verify config is missing**

Run: `cd packages/schema && bun test test/adaptive-config.test.ts`

Run: `cd packages/core && bun test test/config/adaptive.test.ts`

Expected: FAIL because Adaptive config is absent.

- [ ] **Step 3: Implement public config schema and Core merge**

Expose `adaptive` in OpenCode current config with nested `limits`, `context`, `retries`, `retention`, and `benchmark`. Use decode defaults; environment overrides use `OPENCODE_ADAPTIVE_*` names and the same schema validation. Task creation snapshots effective limits into Task configuration hash so later config changes cannot mutate a running Task.

- [ ] **Step 4: Enforce limits at deterministic boundaries**

- Scheduler enforces max Workers.
- Controller checks wall time/generations/events/blob quota before state advance.
- Supervisor enforces generations/lease.
- Assembler enforces Roadmap/Detail/context thresholds.
- Tool/command gateways bound output and duration.
- Exceeded limits create typed Task failure with current checkpoint/export available; no silent eviction of mandatory facts.

- [ ] **Step 5: Write quota tests**

Each quota test sets a tiny value, crosses it by one unit, and asserts no next process/request/tool/state transition occurs. Restart after quota failure must preserve terminal reason.

- [ ] **Step 6: Run tests and commit**

Run: `cd packages/schema && bun test test/adaptive-config.test.ts && bun typecheck`

Run: `cd packages/core && bun test test/config/adaptive.test.ts && bun typecheck`

Run: `cd packages/opencode && bun test test/adaptive/quotas.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/schema/src/adaptive-config.ts packages/schema/src/index.ts packages/schema/test/adaptive-config.test.ts packages/core/src/config/adaptive.ts packages/core/src/config/config.ts packages/core/test/config/adaptive.test.ts packages/opencode/src/adaptive/controller.ts packages/opencode/src/adaptive/context/assembler.ts packages/opencode/src/adaptive/process/supervisor.ts packages/opencode/test/adaptive/quotas.test.ts
git commit -m "feat(adaptive): enforce commercial resource limits"
```

## Task 2: Provider Compatibility, Same-Model Retry, and Token Calibration

**Files:**

- Modify: `packages/core/src/session/runner/model.ts`
- Modify: `packages/core/test/session-runner-model.test.ts`
- Create: `packages/opencode/src/adaptive/provider-resilience.ts`
- Modify: `packages/opencode/src/adaptive/model-gateway.ts`
- Modify: `packages/opencode/src/adaptive/context/assembler.ts`
- Modify: `packages/core/src/adaptive/model-audit.ts`
- Test: `packages/opencode/test/adaptive/provider-resilience.test.ts`
- Test: `packages/opencode/test/adaptive/provider-compatibility.test.ts`

- [ ] **Step 1: Write provider route matrix tests**

Table-driven resolution must cover:

```text
@ai-sdk/openai -> OpenAI Responses
@ai-sdk/anthropic -> Anthropic Messages
@ai-sdk/openai-compatible with URL -> OpenAI-compatible Chat (Kimi/DeepSeek included)
Google AI Studio -> Gemini
Amazon Bedrock -> Bedrock Converse
OpenRouter/OpenAI-compatible profiles -> declared compatible route
unsupported/custom API -> UnsupportedApiError before Agent request
```

Assert credentials remain in Controller route only and never enter Task/Manifest/audit serialization.

- [ ] **Step 2: Write retry and overflow tests**

Cover these exact setup/action/assertions:

- Script transport failure then rate limit then success; assert three distinct Request IDs, each `retry_of` points to the immediately prior ID, and provider/model/variant/policy hash/effective limit are identical across all attempts.
- Independently return authentication, invalid-request, and provider-declared nonretryable errors; assert one request/settlement each, zero scheduled delay, and the original typed error reaches the Agent operation.
- Return `Retry-After: 7`, then two retryable failures without the header under `TestClock`; assert delays are exactly 7 seconds then within configured deterministic-jitter bounds, never exceed 30 seconds, and cancellation during delay settles the request interrupted.
- Return overflow before any assistant/tool delta with optional command bodies present; assert old Manifest invalidated, optional components evicted in documented order, a smaller new Manifest/request hash, and retry on the same resolved model.
- Return overflow after one assistant or tool delta; assert the request settles failed/interrupted, no provider retry and no automatic tool/model replay occurs, and the replacement generation receives the partial-output failure fact.
- Overflow an Implementation Worker after all optional components are gone; assert its Assignment becomes admission-blocked with `CONTEXT_SPLIT_REQUIRED`, no compaction/model fallback/request retry occurs, and Coordinator receives exact mandatory-component sizes plus a split/reduce-dependency request before committing node status `blocked` or replacement nodes. Then overflow a Coordinator whose Requirement plus complete Roadmap alone exceed the immutable limit and assert typed `CONTEXT_BUDGET_UNSATISFIABLE` Task failure as the unsplittable global boundary.
- Report actual input usage above the estimate, assert the next-turn estimator multiplier rises monotonically within `1.0..2.0`, the effective context limit remains unchanged, and lower later usage never retroactively changes stored Manifests.

- [ ] **Step 3: Run and verify missing support/resilience**

Run: `cd packages/core && bun test test/session-runner-model.test.ts --test-name-pattern "provider route matrix"`

Run: `cd packages/opencode && bun test test/adaptive/provider-resilience.test.ts test/adaptive/provider-compatibility.test.ts`

Expected: FAIL on unsupported protocols/resilience service.

- [ ] **Step 4: Extend the existing resolver using `@opencode-ai/llm` routes**

Reuse provider modules/protocols already present in `packages/llm`; do not introduce another SDK or model catalog. Preserve existing Session resolution tests. `adaptive doctor --live` reports unsupported route before creating Task request audit.

- [ ] **Step 5: Implement retry admission/lineage**

All attempts have distinct Request IDs and `retry_of` points to the immediately previous attempt. ModelPolicy hash/provider/model/variant/effective limit remain identical. Backoff is Controller-owned, interruptible, capped at 30 seconds, and max attempts come from Task snapshot. No fallback model exists in code or configuration.

- [ ] **Step 6: Implement overflow reduction, split escalation, and calibration**

Only when provider signals overflow before assistant/tool output, invalidate the Manifest, increase conservative estimator multiplier for that provider/model Task (bounded `1.0..2.0`), evict optional components in existing order, persist a new Manifest, and retry. Requirement/Roadmap/Assignment/direct contracts remain mandatory. When only mandatory local components remain, admission-block that Assignment with `CONTEXT_SPLIT_REQUIRED` and wake Coordinator to split it or reduce semantic dependencies; do not fail the Task or call a compaction model. Only an unsplittable global Requirement/complete-Roadmap boundary returns `CONTEXT_BUDGET_UNSATISFIABLE`. Provider-reported input usage updates calibration for later turns but cannot increase effective context limit.

- [ ] **Step 7: Run matrix/resilience/runner tests and commit**

Run: `cd packages/core && bun test test/session-runner-model.test.ts test/session-runner.test.ts && bun typecheck`

Run: `cd packages/opencode && bun test test/adaptive/provider-resilience.test.ts test/adaptive/provider-compatibility.test.ts test/adaptive/model-gateway.test.ts test/adaptive/context-assembler.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/core/src/session/runner/model.ts packages/core/src/adaptive/model-audit.ts packages/core/test/session-runner-model.test.ts packages/opencode/src/adaptive/provider-resilience.ts packages/opencode/src/adaptive/model-gateway.ts packages/opencode/src/adaptive/context/assembler.ts packages/opencode/test/adaptive/provider-resilience.test.ts packages/opencode/test/adaptive/provider-compatibility.test.ts
git commit -m "feat(adaptive): harden same-model provider execution"
```

## Task 3: Central Secret Redaction and Sensitive Path Policy

**Files:**

- Create: `packages/opencode/src/adaptive/security/redact.ts`
- Create: `packages/opencode/src/adaptive/security/paths.ts`
- Modify: `packages/opencode/src/adaptive/process/command.ts`
- Modify: `packages/opencode/src/adaptive/model-gateway.ts`
- Modify: `packages/opencode/src/adaptive/tool/gateway.ts`
- Modify: `packages/opencode/src/adaptive/validation/command-runner.ts`
- Modify: `packages/opencode/src/adaptive/export.ts`
- Test: `packages/opencode/test/adaptive/security-redact.test.ts`
- Test: `packages/opencode/test/adaptive/security-paths.test.ts`

- [ ] **Step 1: Create a secret corpus and failing tests**

Corpus includes OpenAI/Anthropic/GitHub-style keys, OAuth bearer/JWT, `Authorization`/cookie headers, URL credentials, AWS access/secret/session values, `.npmrc` tokens, proxy credentials, PEM private key blocks, `OPENCODE_AUTH_CONTENT`, Unicode/line-wrapped variants, and benign lookalikes. Assert raw secrets never appear in structured logs, process errors, audit rows, ContextManifest export, evidence preview, or doctor output.

- [ ] **Step 2: Write sensitive path tests**

Default denied paths: `.env*`, credential/keychain files, SSH/GPG/private keys, cloud credential directories, OpenCode data/auth/database paths, browser profiles/cookies, and paths outside assigned workspace. Normal mode can request explicit user permission for workspace-local sensitive files; benchmark mode denies. Symlink/case/Unicode normalization cannot bypass.

- [ ] **Step 3: Run and verify centralized policies are absent**

Run: `cd packages/opencode && bun test test/adaptive/security-redact.test.ts test/adaptive/security-paths.test.ts`

Expected: FAIL because security modules are absent.

- [ ] **Step 4: Implement typed redaction**

Redact known structured fields before stringification, then scan bounded strings. Replacement is `[REDACTED:<kind>:<sha256-prefix>]` so repeated secret correlation is possible without value disclosure. Never run redaction over user source files before model use because it would alter code semantics; sensitive-path permission prevents accidental reads, while exports redact captured contexts/diffs/logs.

- [ ] **Step 5: Enforce at every egress/persistence boundary**

Child env uses allowlist from Stage 1. Model audit stores identity/usage/hash only, never headers/body auth. Tool/validation previews redact before DB/log; raw blobs containing workspace command output use owner-only mode and export through redaction. Error logging uses structured safe fields and redacted messages.

- [ ] **Step 6: Run security and regression tests**

Run: `cd packages/opencode && bun test test/adaptive/security-redact.test.ts test/adaptive/security-paths.test.ts test/adaptive/export.test.ts test/adaptive/process-supervisor.test.ts && bun typecheck`

Expected: PASS; corpus scan of temp DB/log/export finds no raw sentinel.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/adaptive/security/redact.ts packages/opencode/src/adaptive/security/paths.ts packages/opencode/src/adaptive/process/command.ts packages/opencode/src/adaptive/model-gateway.ts packages/opencode/src/adaptive/tool/gateway.ts packages/opencode/src/adaptive/validation/command-runner.ts packages/opencode/src/adaptive/export.ts packages/opencode/test/adaptive/security-redact.test.ts packages/opencode/test/adaptive/security-paths.test.ts
git commit -m "feat(adaptive): protect secrets and sensitive paths"
```

## Task 4: Benchmark Sandbox and Audited Package Broker

**Files:**

- Create: `packages/opencode/src/adaptive/security/sandbox.ts`
- Create: `packages/opencode/src/adaptive/security/package-broker.ts`
- Modify: `packages/opencode/src/adaptive/process/command.ts`
- Modify: `packages/opencode/src/adaptive/tool/gateway.ts`
- Modify: `packages/opencode/src/adaptive/validation/command-runner.ts`
- Test: `packages/opencode/test/adaptive/benchmark-sandbox.test.ts`
- Test: `packages/opencode/test/adaptive/package-broker.test.ts`

- [ ] **Step 1: Write Linux capability and egress tests**

Inside benchmark Agent/tool/validation processes assert workspace write works, outside write fails, provider/config/data paths unreadable, network socket/DNS/HTTP fails, process cannot signal Controller/other Workers, and push/PR/publish/deploy commands fail before execution. `adaptive doctor --benchmark` must report all required primitives.

- [ ] **Step 2: Write package broker tests**

Allow exact npm registry package/version/lockfile-resolved tarball, deny arbitrary URL/git dependency/lifecycle network escape, record request/package/version/integrity/registry/bytes/lockfile diff, and make result visible in worktree/evidence. Agent process remains networkless.

- [ ] **Step 3: Run and verify sandbox/broker are absent**

Run: `cd packages/opencode && bun test test/adaptive/benchmark-sandbox.test.ts test/adaptive/package-broker.test.ts`

Expected: FAIL because benchmark isolation is absent.

- [ ] **Step 4: Implement Linux benchmark sandbox**

Use `bwrap` with new user/pid/network namespaces, read-only system mounts, read-write assigned worktree/temp only, private home, no Controller DB/data/auth mounts, sanitized env, and stdio RPC inherited as the sole Controller channel. Resolve `bwrap` path and capabilities in doctor. If unavailable or namespace creation fails, benchmark mode exits before Task creation with `BENCHMARK_SANDBOX_UNAVAILABLE`.

On macOS/Windows, normal adaptive mode remains supported; benchmark mode fails closed until an equivalent tested network/filesystem sandbox is configured through an explicit external sandbox command whose capability probe passes.

- [ ] **Step 5: Enforce external side-effect policy**

Benchmark catalog excludes webfetch/websearch/question/remote operations. Shell policy rejects push, PR, publish, deploy, remote mutation, credential commands, package-manager network installs, curl/wget/network clients, and external workdirs. Network namespace is the final boundary, so command parsing is defense in depth rather than the sole control.

- [ ] **Step 6: Implement package broker**

Controller validates package-manager structured request, registry allowlist and integrity, performs acquisition in a separate sandbox with registry-only egress, then makes cache content available read-only to worktree install. Run install scripts networkless in Worker sandbox. Persist lockfile/package evidence and count broker egress separately from model requests.

- [ ] **Step 7: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/benchmark-sandbox.test.ts test/adaptive/package-broker.test.ts test/adaptive/tool-gateway.test.ts test/adaptive/validation-command-runner.test.ts --timeout 90000 && bun typecheck`

Expected on Linux with bwrap: PASS. CI on unsupported platform asserts fail-closed diagnostic.

```bash
git add packages/opencode/src/adaptive/security/sandbox.ts packages/opencode/src/adaptive/security/package-broker.ts packages/opencode/src/adaptive/process/command.ts packages/opencode/src/adaptive/tool/gateway.ts packages/opencode/src/adaptive/validation/command-runner.ts packages/opencode/test/adaptive/benchmark-sandbox.test.ts packages/opencode/test/adaptive/package-broker.test.ts
git commit -m "feat(adaptive): isolate benchmark execution"
```

## Task 5: Baseline Model Audit and Pair Validity Verifier

**Files:**

- Create: `packages/opencode/src/benchmark/model-audit.ts`
- Create: `packages/opencode/src/benchmark/suite.ts`
- Create: `packages/opencode/src/benchmark/runner.ts`
- Create: `packages/opencode/src/benchmark/verify.ts`
- Create: `packages/opencode/src/cli/cmd/benchmark.ts`
- Modify: `packages/opencode/src/session/llm.ts`
- Modify: `packages/opencode/src/index.ts`
- Modify: `packages/opencode/src/effect/app-runtime.ts`
- Test: `packages/opencode/test/benchmark/model-audit.test.ts`
- Test: `packages/opencode/test/benchmark/runner.test.ts`
- Test: `packages/opencode/test/adaptive/model-validity.test.ts`

- [ ] **Step 1: Write audit invariance and invalidity tests**

Cover these exact setup/action/assertions:

- Capture the complete request/options/event recording for a non-benchmark baseline call before instrumentation, run with audit inactive afterward, and assert byte-identical messages/tools/provider options/retry count/event order plus zero benchmark rows.
- In benchmark context run one normal legacy stream and one title/helper stream resolved to different models; assert both requests are recorded with purpose, requested/resolved identity, effective limit, lineage, usage, and terminal settlement.
- Independently route title, compaction, and another helper through a second model; assert each run finalizes `INVALID_MODEL_MIXING`, names the offending request/purpose/identity, and cannot enter aggregate quality results.
- For Adaptive fixtures inject an uninstrumented request, an admitted-but-unsettled request, ModelPolicy hash drift, and effective-context drift; assert distinct stable invalidity reasons and no `VALID` proof.
- Attempt terminal/API conflict or PermissionV2 input during benchmark execution; assert stdin/reply channels are never called, the run is invalidated as `INVALID_HUMAN_INTERVENTION` if a reply is externally injected, and autonomous same-model conflict choices plus deterministic permission denials remain audit-visible.
- Verify a baseline/adaptive pair that differs one field at a time in provider, resolved model, variant, and effective context; assert exact mismatch code/value pair for each and no compare metrics.
- Mark either side invalid while both acceptance suites pass; assert `benchmark compare` reports validity only, omits quality winner/delta/score fields, and exits nonzero.

- [ ] **Step 2: Run and verify baseline audit is absent**

Run: `cd packages/opencode && bun test test/benchmark/model-audit.test.ts test/benchmark/runner.test.ts test/adaptive/model-validity.test.ts`

Expected: FAIL because benchmark audit/runner are absent.

- [ ] **Step 3: Instrument the central legacy LLM service conditionally**

At `packages/opencode/src/session/llm.ts` immediately before each underlying provider stream, call `BenchmarkModelAudit.admit` only when an immutable benchmark context is active. Record run/session/agent/purpose, requested and resolved provider/model/variant, effective limits, attempt lineage, usage, settlement. Do not change messages/tools/options, retry behavior, event ordering, or call count. Snapshot tests compare inactive request recordings byte-for-byte.

- [ ] **Step 4: Define benchmark suite manifest**

```ts
export class SuiteCase extends Schema.Class<SuiteCase>("Benchmark.SuiteCase")({
  id: Schema.String,
  fixture: Schema.String,
  requirementFile: Schema.String,
  acceptance: Schema.Array(Schema.String),
  timeoutMinutes: PositiveInt,
  cleanBetweenRuns: Schema.Boolean,
}) {}
```

Suite is versioned/content-hashed; baseline/adaptive get separate identical workspace copies and identical requested ModelPolicy/resource wall time, except adaptive may make more calls/workers by design.

- [ ] **Step 5: Implement benchmark CLI**

```text
opencode benchmark run --runtime baseline|adaptive --model provider/model --suite <id> --output <dir>
opencode benchmark verify <run-dir>
opencode benchmark compare <baseline-dir> <adaptive-dir>
```

Run forces pure/no plugins, fixed model/variant/effective context, sandbox/side-effect policy, execution channel `benchmark`, complete audit/export, and zero human input channels. Verify is offline and checks checksums, suite hash, Task result acceptance, request completeness, one identity/policy/context, no helper request, no human reply, autonomous conflict evidence, deterministic permission denials, and sandbox/broker audit. Compare first verifies both and exact policy equality.

- [ ] **Step 6: Run audit/runner/baseline regressions**

Run: `cd packages/opencode && bun test test/benchmark/model-audit.test.ts test/benchmark/runner.test.ts test/adaptive/model-validity.test.ts test/cli/run/run-process.test.ts && bun typecheck`

Expected: PASS; baseline non-benchmark recordings/output remain unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/benchmark packages/opencode/src/cli/cmd/benchmark.ts packages/opencode/src/session/llm.ts packages/opencode/src/index.ts packages/opencode/src/effect/app-runtime.ts packages/opencode/test/benchmark packages/opencode/test/adaptive/model-validity.test.ts
git commit -m "feat(opencode): verify benchmark model consistency"
```

## Task 6: Structured Observability and Health Diagnostics

**Files:**

- Create: `packages/opencode/src/adaptive/observability.ts`
- Create: `packages/opencode/src/adaptive/health.ts`
- Modify: `packages/opencode/src/adaptive/controller.ts`
- Modify: `packages/opencode/src/adaptive/coordinator/cycle.ts`
- Modify: `packages/opencode/src/adaptive/context/assembler.ts`
- Modify: `packages/opencode/src/adaptive/model-gateway.ts`
- Modify: `packages/opencode/src/adaptive/tool/gateway.ts`
- Modify: `packages/opencode/src/adaptive/recovery.ts`
- Modify: `packages/opencode/src/adaptive/validation/validator.ts`
- Modify: `packages/opencode/src/adaptive/integration/operation.ts`
- Modify: `packages/opencode/src/adaptive/integration/materialize.ts`
- Modify: `packages/opencode/src/adaptive/conflict.ts`
- Modify: `packages/opencode/src/adaptive/export.ts`
- Modify: `packages/opencode/src/cli/cmd/adaptive.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/groups/adaptive.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/adaptive.ts`
- Test: `packages/opencode/test/adaptive/observability.test.ts`
- Test: `packages/opencode/test/adaptive/health.test.ts`

- [ ] **Step 1: Write trace/log/metric correlation tests**

Assert every Controller cycle, Agent generation, context assembly, model request, tool call, checkpoint, validation, integration, conflict, materialization, and export log/span includes Task ID and relevant Agent/request/operation ID. Secret corpus is absent. Metrics include counts/durations/tokens/restarts/invalidations/active leases/DB/blob size without high-cardinality source content labels.

- [ ] **Step 2: Write health diagnostics tests**

Doctor detects migration drift, non-writable data/blob paths, corrupt blob, stale lease, orphan process, missing worktree, integration/DB head divergence, unavailable model route, sandbox capability, and audit inconsistency. `--repair-safe` may expire dead leases/rebuild projections/clean terminal worktrees but cannot delete active Task state or alter user repo.

- [ ] **Step 3: Run and verify observability incomplete**

Run: `cd packages/opencode && bun test test/adaptive/observability.test.ts test/adaptive/health.test.ts`

Expected: FAIL because structured Adaptive observability/health is absent.

- [ ] **Step 4: Implement telemetry helpers**

Use Effect spans/log annotations; no ad hoc logger. Define metric instruments once at service construction. Add `adaptive status --watch` through durable Task events with bounded refresh, not polling every table. HttpApi health/status use same service.

- [ ] **Step 5: Implement doctor levels**

`--offline` no provider/network; `--live` one audited model request; `--benchmark` also sandbox/package-broker capability. JSON output has stable check IDs/status `ok|warning|error`, safe details, remediation, and build/database versions.

- [ ] **Step 6: Run tests and commit**

Run: `cd packages/opencode && bun test test/adaptive/observability.test.ts test/adaptive/health.test.ts test/adaptive/security-redact.test.ts && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/observability.ts packages/opencode/src/adaptive/health.ts packages/opencode/src/adaptive packages/opencode/src/cli/cmd/adaptive.ts packages/opencode/src/server/routes/instance/httpapi packages/opencode/test/adaptive/observability.test.ts packages/opencode/test/adaptive/health.test.ts
git commit -m "feat(adaptive): expose correlated runtime health"
```

## Task 7: Backup, Restore, Retention, and Upgrade Safety

**Files:**

- Create: `packages/opencode/src/adaptive/backup.ts`
- Create: `packages/opencode/src/adaptive/retention.ts`
- Modify: `packages/opencode/src/cli/cmd/adaptive.ts`
- Modify: `packages/core/test/database-migration.test.ts`
- Create: `packages/opencode/test/adaptive/backup-restore.test.ts`
- Create: `packages/opencode/test/adaptive/retention.test.ts`
- Create: `packages/opencode/test/adaptive/upgrade-recovery.test.ts`

- [ ] **Step 1: Write backup/restore consistency tests**

Backup an active checkpointed Task under WAL activity, restore to a new home, resume, and assert Roadmap/Details/events/manifests/audit/blobs/workspace refs. Corrupt/missing checksum fails before replacing current data. Restore over nonempty home requires explicit `--replace` and creates rollback backup.

- [ ] **Step 2: Write retention tests**

Terminal Task older than retention loses unreferenced raw blobs/worktrees after export, while Roadmap/Details/audit/evidence indexes/final result remain. Active/needs_input Tasks are never collected. Shared blob remains until last reference. Dry run and applied report match.

- [ ] **Step 3: Write upgrade recovery tests**

Exercise database snapshots after every Adaptive migration stage; upgrade to current, reconcile open cycle/lease/tool/integration/materialization states, and resume. Inject process death while applying latest migration; reopen succeeds transactionally.

- [ ] **Step 4: Run and verify services absent**

Run: `cd packages/opencode && bun test test/adaptive/backup-restore.test.ts test/adaptive/retention.test.ts test/adaptive/upgrade-recovery.test.ts`

Expected: FAIL because backup/retention orchestration is absent.

- [ ] **Step 5: Implement SQLite/blob/workspace backup**

Use SQLite online backup or checkpointed consistent copy under database service lock, copy referenced blobs/workspace metadata with hashes, write versioned manifest then atomically finalize archive. Do not shell-copy live WAL files. Restore validates version/checksums/path traversal, stages to temp home, runs migrations/doctor, then swaps.

- [ ] **Step 6: Implement retention/gc commands**

```text
opencode adaptive backup --output <archive>
opencode adaptive restore <archive> [--replace]
opencode adaptive gc [--dry-run] [--older-than-days N]
```

GC derives reachability from DB in one snapshot and rechecks Task terminal state before deletion. Every deletion/report is audit logged.

- [ ] **Step 7: Run tests and commit**

Run: `cd packages/core && bun script/migration.ts --check && bun test test/database-migration.test.ts`

Run: `cd packages/opencode && bun test test/adaptive/backup-restore.test.ts test/adaptive/retention.test.ts test/adaptive/upgrade-recovery.test.ts --timeout 120000 && bun typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/adaptive/backup.ts packages/opencode/src/adaptive/retention.ts packages/opencode/src/cli/cmd/adaptive.ts packages/core/test/database-migration.test.ts packages/opencode/test/adaptive/backup-restore.test.ts packages/opencode/test/adaptive/retention.test.ts packages/opencode/test/adaptive/upgrade-recovery.test.ts
git commit -m "feat(adaptive): protect durable task data"
```

## Task 8: Load, Chaos, Leak, and Soak Verification

**Files:**

- Create: `packages/opencode/test/adaptive/load.test.ts`
- Create: `packages/opencode/test/adaptive/chaos.test.ts`
- Create: `packages/opencode/test/adaptive/leak.test.ts`
- Create: `packages/opencode/script/adaptive-soak.ts`
- Create: `packages/opencode/script/adaptive-load-report.ts`
- Modify: `packages/opencode/package.json`

- [ ] **Step 1: Write deterministic load test**

Using fake LLM and temp workspaces, create 100 Tasks, 1,000 Agents/generations, 100k Task events, 10k manifests, and concurrent status/event reads while 16 Controller operations write. Assert no SQLite busy failure, list/status p95 under 250ms on CI class machine, bounded memory after GC, index query plans, and correct quotas.

- [ ] **Step 2: Write randomized deterministic chaos test**

Seeded fault scheduler kills Controller/Agent/tool/validation/integration/materialization at durable transition hooks, corrupts one noncritical cache/blob copy, delays provider/tool, duplicates RPC frames/events, and expires leases. For 100 seeds assert terminal correct result or explicit recoverable failure, never silent completion/divergent projection/duplicate external side effect.

- [ ] **Step 3: Write leak test**

After 50 start/kill/resume/complete cycles assert no live child/grandchild process, open worktree lock, active lease, unclosed DB handle, temp file, orphan branch/worktree, Event subscription, or growing listener count. Capture baseline/final handles where platform supports it.

- [ ] **Step 4: Run and verify failures expose bottlenecks**

Run: `cd packages/opencode && bun test test/adaptive/load.test.ts test/adaptive/chaos.test.ts test/adaptive/leak.test.ts --timeout 300000`

Expected initially: tests may expose performance/recovery defects; fix production indexes/lifecycle/reconciliation until PASS without lowering workload or loosening correctness assertions.

- [ ] **Step 5: Implement soak script**

`bun run adaptive:soak --duration 24h --seed <seed> --report <dir>` repeatedly runs real subprocess Tasks with fake deterministic provider, scheduled graceful/forced restarts, worktree operations, backup/restore, and export verification. It emits interval metrics, failures, process/worktree/DB/blob counts, and final checksums. `--duration 10m` is CI smoke; 24h is release gate.

- [ ] **Step 6: Add package scripts and run short soak**

Add:

```json
"adaptive:soak": "bun run script/adaptive-soak.ts",
"adaptive:load-report": "bun run script/adaptive-load-report.ts"
```

Run: `cd packages/opencode && bun run adaptive:soak --duration 10m --seed 20260717 --report /tmp/adaptive-soak`

Expected: exit `0`; final report shows zero leaks/corruption/invalid completion.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/test/adaptive/load.test.ts packages/opencode/test/adaptive/chaos.test.ts packages/opencode/test/adaptive/leak.test.ts packages/opencode/script/adaptive-soak.ts packages/opencode/script/adaptive-load-report.ts packages/opencode/package.json
git commit -m "test(adaptive): stress durable runtime recovery"
```

## Task 9: Release Documentation and Cross-Platform Packaging

**Files:**

- Create: `docs/adaptive/architecture.md`
- Create: `docs/adaptive/operations.md`
- Create: `docs/adaptive/security.md`
- Create: `docs/adaptive/benchmark-validity.md`
- Create: `docs/adaptive/troubleshooting.md`
- Create: `packages/opencode/script/adaptive-release-smoke.ts`
- Modify: `packages/opencode/script/build.ts`
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/publish.yml`
- Test: `packages/opencode/test/cli/adaptive-release-process.test.ts`

- [ ] **Step 1: Write packaged release smoke before build integration**

The smoke uses the packaged binary to run offline doctor, create/resume/restart/export a fake-provider Task, validate process child entry, apply/rollback a managed empty workspace, verify export, backup/restore, and assert no process/worktree leak. It never imports source modules.

- [ ] **Step 2: Run current package and verify missing release smoke coverage**

Run: `cd packages/opencode && bun run build --single --skip-embed-web-ui`

Run on this implementation host: `cd packages/opencode && bun script/adaptive-release-smoke.ts dist/opencode-linux-x64/bin/opencode`

Expected before wiring: script fails because build/release smoke integration or fixture mode is absent.

- [ ] **Step 3: Integrate smoke into native and CI matrix builds**

Native build runs full smoke. Cross builds run binary format/static embedded-command checks; CI runners for Linux x64/arm64, macOS x64/arm64, and Windows x64 execute offline doctor and source/packaged child launch. Benchmark sandbox success is required on Linux; other platforms require explicit fail-closed benchmark diagnostic.

- [ ] **Step 4: Write operational documentation from shipped behavior**

Architecture documents trust/state/process/data flows and why no chat replay/compaction Agent is used. Operations gives exact create/list/status/stop/cancel/resume/restart/permission/conflict/backup/gc/export commands and recovery states. Security defines credential/network/path boundaries and platform benchmark support. Benchmark validity defines every invalidity reason. Troubleshooting maps stable doctor/failure codes to safe actions.

- [ ] **Step 5: Run docs command examples in subprocess tests**

`adaptive-release-process.test.ts` extracts fenced `opencode adaptive|benchmark` examples marked executable and runs them against isolated fake provider/home. Unknown/stale commands fail the test.

- [ ] **Step 6: Run build/release tests and commit**

Run: `cd packages/opencode && bun test test/cli/adaptive-release-process.test.ts && bun run build --single --skip-embed-web-ui`

Expected: PASS; packaged full smoke exits `0`.

```bash
git add docs/adaptive packages/opencode/script/adaptive-release-smoke.ts packages/opencode/script/build.ts packages/opencode/test/cli/adaptive-release-process.test.ts .github/workflows
git commit -m "docs(adaptive): document and package commercial runtime"
```

## Task 10: Controlled Benchmark Dry-Run Suite and G6 Release Gate

**Files:**

- Create: `fixtures/benchmark/adaptive-v1-dry-run/suite.json`
- Create: `fixtures/benchmark/adaptive-v1-dry-run/cases/recovery/case.json`
- Create: `fixtures/benchmark/adaptive-v1-dry-run/cases/contracts/case.json`
- Create: `fixtures/benchmark/adaptive-v1-dry-run/cases/conflict/case.json`
- Create: `packages/opencode/test/benchmark/dry-run.test.ts`
- Modify: `docs/superpowers/acceptance/adaptive-runtime-v1.md`

- [ ] **Step 1: Define a validity dry-run, not the final research benchmark**

Three cases reuse behavior from G2/G4/G5: forced recovery, parallel frozen contracts, validation/conflict. Suite fixes workspace hashes, requirement files, authoritative acceptance, timeouts, model policy input, and sandbox policy. It exists to prove runner/audit comparability; it does not establish statistical research conclusions.

- [ ] **Step 2: Write pair-run tests**

Using deterministic fake model, run baseline/adaptive copies, offline verify both, compare exact provider/model/variant/context, and assert expected output layout. Inject baseline helper model, adaptive policy drift, missing request settlement, sandbox absence, checksum corruption, and acceptance failure; each must invalidate with a stable reason and suppress comparison.

- [ ] **Step 3: Run dry-run and complete automated suite**

```bash
cd packages/opencode && bun test test/benchmark/dry-run.test.ts --timeout 300000
cd packages/schema && bun test && bun typecheck
cd packages/core && bun script/migration.ts --check && bun test && bun typecheck
cd packages/client && bun run generate && bun test && bun typecheck
cd packages/opencode && bun run test:httpapi && bun test && bun typecheck
cd packages/opencode && bun run build --single --skip-embed-web-ui
cd packages/opencode && bun run adaptive:soak --duration 24h --seed 20260717 --report /tmp/adaptive-release-soak
```

Expected: all commands exit `0`; 24-hour report has no leak/corruption/invalid completion.

- [ ] **Step 4: Run security scans on artifacts**

Scan test DB, logs, backup, baseline/adaptive exports, packaged doctor output, and soak report for the full secret corpus. Verify every `SHA256SUMS`, model proof, suite/workspace hash, result commit, and evidence blob. Expected: no raw secret; all checksums/proofs valid.

- [ ] **Step 5: Request final independent reviews**

Use `requesting-code-review` for the complete diff and a separate adversarial review of security/model validity/recovery. Resolve all severity-1/2 findings and any issue that can create incorrect completion, model mixing, data loss, credential exposure, sandbox escape, baseline behavior change, or unverifiable evidence. Repeat Steps 3-4 after fixes.

- [ ] **Step 6: Commit the dry-run/release evidence hooks**

```bash
git add fixtures/benchmark/adaptive-v1-dry-run packages/opencode/test/benchmark/dry-run.test.ts docs/superpowers/acceptance/adaptive-runtime-v1.md
git commit -m "test(adaptive): gate commercial v1 release"
```

- [ ] **Step 7: Pause for G6 real-model user trial**

Provide packaged release candidate, long-task instructions, Program Gate G6 baseline/adaptive commands, verification commands, 24-hour soak report, security scan, supported provider/platform matrix, and open-issue list. Only the user may mark G6 `accepted`; no deferred correctness/security/reliability requirement is compatible with Commercial V1 acceptance.
