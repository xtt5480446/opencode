# Adaptive Runtime Tutorial Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the learner-facing Adaptive Runtime tutorial series and backfill accurate implementation companions for S01-T01 and S01-T02.

**Architecture:** A dedicated `docs/adaptive-runtime/tutorials/` index orders tutorials by Stage and task dependency. Each tutorial stands alone, explains the relevant OpenCode baseline before the Adaptive extension, walks the final merged symbols and call flow, connects risks to tests, and ends with runnable verification plus explicit current boundaries.

**Tech Stack:** Markdown, OpenCode Schema/Core TypeScript, Bun tests, Git/GitHub merge evidence.

---

### Task 1: Establish the tutorial index

**Files:**

- Create: `docs/adaptive-runtime/tutorials/README.md`

- [ ] **Step 1: Create the index and delivery contract**

Write an index containing:

- the purpose and intended reader: an engineer who understands coding agents but is new to OpenCode internals;
- the distinction between a pre-implementation design, an execution plan, and a post-implementation tutorial;
- the fixed delivery point: implementation and automated verification complete, tutorial written, user acceptance, then merge;
- the required tutorial sections: task role, baseline architecture, requirements/invariants, final implementation, code-reading path, terminology, test safety net, hands-on verification, limitations/next dependencies;
- a Stage 1 table linking S01-T01 and S01-T02 and marking S01-T03 as pending;
- the language rule: Chinese explanation, English code identifiers/types/commands.

- [ ] **Step 2: Verify the index has no dead local links or placeholder language**

Run:

```bash
rg -n 'TB[D]|TO[D]O|FIXM[E]|待补[充]|稍后填[写]' docs/adaptive-runtime/tutorials/README.md
```

Expected: exit `1` with no matches.

Run:

```bash
test -f docs/adaptive-runtime/tutorials/s01-t01-adaptive-task-contract.md
test -f docs/adaptive-runtime/tutorials/s01-t02-model-policy-hashing.md
```

Expected after Tasks 2 and 3: both commands exit `0`.

### Task 2: Backfill S01-T01 Adaptive Task contract tutorial

**Files:**

- Create: `docs/adaptive-runtime/tutorials/s01-t01-adaptive-task-contract.md`
- Read: `packages/schema/src/adaptive-task.ts`
- Read: `packages/schema/src/identifier.ts`
- Read: `packages/schema/src/schema.ts`
- Read: `packages/schema/test/adaptive-task.test.ts`
- Read: `packages/schema/test/contract-hygiene.test.ts`

- [ ] **Step 1: Explain the task and its place in G1**

Explain why S01-T01 creates one browser-safe cross-package vocabulary for Task, Agent, Request, ContextManifest, roles, modes, statuses, ModelPolicy, and Task Summary. Connect that vocabulary to persistence, process RPC, model audit, CLI/API, and benchmark validity without claiming that S01-T01 implements runtime behavior.

- [ ] **Step 2: Explain the OpenCode baseline and reuse boundary**

Walk through `ascending()`, `statics()`, `optional()`, `Provider.ID`, `Model.ID`, `Model.VariantID`, `AbsolutePath`, and Effect Schema root/direct exports. State explicitly that these primitives are reused while legacy Session/Agent orchestration semantics are not.

- [ ] **Step 3: Walk the final implementation and terminology**

Cover the exact four ID prefixes and 26-character suffix, branded types, closed vocabularies, ModelPolicy budget invariant, canonical hash shape, Summary fields, and namespace projection. Explain `Schema`, runtime validation versus TypeScript-only typing, branded type, closed vocabulary, canonical representation, and browser-safe contract in plain Chinese.

- [ ] **Step 4: Map risks to tests and provide hands-on verification**

Map malformed IDs, invalid enum values, impossible budgets, optional variant encoding, invalid timestamps/revisions, duplicate schema identifiers, and root/direct identity to the exact test cases. Include these commands and truthful expected results from PR #62:

```bash
cd packages/schema
bun test test/adaptive-task.test.ts test/contract-hygiene.test.ts
bun test
bun typecheck
```

Record the merged verification evidence: focused `14/14`, full Schema `24/24`, and repository typecheck `30/30`. Explain that these tests prove the wire contract, not persistence, process recovery, or model execution.

### Task 3: Backfill S01-T02 ModelPolicy hashing tutorial

**Files:**

- Create: `docs/adaptive-runtime/tutorials/s01-t02-model-policy-hashing.md`
- Read: `packages/core/src/adaptive/model-policy.ts`
- Read: `packages/core/src/util/hash.ts`
- Read: `packages/core/test/adaptive/model-policy.test.ts`
- Read: `packages/schema/src/adaptive-task.ts`

- [ ] **Step 1: Explain the task and its place in G1**

Explain why a typed ModelPolicy still needs a deterministic content identity, how the hash later pins model execution across restarts/retries, and why this supports same-model benchmark evidence. State that S01-T02 neither resolves nor calls a model.

- [ ] **Step 2: Explain baseline reuse and the final implementation**

Show that the implementation reuses Core `Hash.sha256` and S01-T01 `AdaptiveTask.ModelPolicy`. Walk the fixed six-field projection, omitted `undefined` variant, compact JSON, `create()`, and `assertEqual()` recomputation of both sides. Explain why a generic stable-stringifier and a second crypto implementation were intentionally avoided.

- [ ] **Step 3: Explain terminology and integrity cases**

Explain deterministic hash, canonical projection, SHA-256, integrity versus authenticity, stale hash, field drift, and hash collision assumptions. Include the distinction that a hash detects accidental/unauthorized drift inside the runtime boundary but is not a digital signature.

- [ ] **Step 4: Map risks to tests and provide hands-on verification**

Map caller key order, omitted/undefined variant, six independently changed execution fields, budget validation, reused old hash, changed hash, and two identically tampered policies to exact tests. Include:

```bash
cd packages/core
bun test test/adaptive/model-policy.test.ts
bun typecheck
```

Record the merged evidence from PR #63: focused `8/8`, full Core `1083/1083`, `2971` assertions, and repository typecheck `30/30`. State that persistence-time enforcement begins in S01-T03 and provider-call enforcement begins in S01-T05/S01-T08.

### Task 4: Verify and commit the one-time backfill

**Files:**

- Verify: `docs/adaptive-runtime/tutorials/README.md`
- Verify: `docs/adaptive-runtime/tutorials/s01-t01-adaptive-task-contract.md`
- Verify: `docs/adaptive-runtime/tutorials/s01-t02-model-policy-hashing.md`

- [ ] **Step 1: Format all tutorial Markdown**

Run:

```bash
bun x prettier --write docs/adaptive-runtime/tutorials docs/superpowers/plans/2026-07-18-adaptive-runtime-tutorial-backfill.md
```

Expected: exit `0`.

- [ ] **Step 2: Verify required sections, referenced symbols, links, and commands**

Run targeted `rg` checks for every required heading and for the symbols `AdaptiveTask`, `AdaptiveModelPolicy`, `assertEqual`, `ascending`, `optional`, and `Hash.sha256`. Resolve each relative Markdown link against the tutorial file directory and verify every local target exists. Compare every reported test count with PR #62/#63 evidence.

- [ ] **Step 3: Run focused executable examples**

Run:

```bash
cd packages/schema && bun test test/adaptive-task.test.ts test/contract-hygiene.test.ts
cd packages/core && bun test test/adaptive/model-policy.test.ts
```

Expected: all tests pass. Report current counts separately from historical merged-PR counts if they differ.

- [ ] **Step 4: Check the exact backfill diff**

Run:

```bash
git diff --check
git status --short
```

Expected: only this plan and the three tutorial files are new, in addition to the already committed S01-T03 design document.

- [ ] **Step 5: Commit**

```bash
git add docs/adaptive-runtime/tutorials docs/superpowers/plans/2026-07-18-adaptive-runtime-tutorial-backfill.md
git commit -m "docs: add adaptive runtime implementation tutorials"
```
