# S01-T01 Adaptive Task Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the canonical browser-safe Adaptive Task, Agent, model request, ContextManifest, ModelPolicy, and Task summary contracts to `@opencode-ai/schema` without changing any baseline OpenCode contract.

**Architecture:** A new `AdaptiveTask` namespace follows the current Schema package's self-projected module pattern and reuses its identifier generator, optional encoding, canonical Provider/Model IDs, path brand, and integer schemas. Runtime behavior remains outside Schema; strict checks reject non-canonical IDs, invalid policy hashes, impossible context budgets, and invalid Task metadata before later Core or Runtime layers consume them.

**Tech Stack:** TypeScript, Effect Schema 4, Bun test, `@opencode-ai/schema` package conventions.

---

This task plan implements [the approved S01-T01 design](../specs/2026-07-17-s01-t01-adaptive-task-contract-design.md) and supersedes the narrower Task 1 code skeleton in the G1 stage plan.

## File Map

- Create `packages/schema/src/adaptive-task.ts`: the only canonical Adaptive Task wire/storage contract and ID constructors.
- Create `packages/schema/test/adaptive-task.test.ts`: focused red/green contract behavior and encoding tests.
- Modify `packages/schema/src/index.ts`: expose the same `AdaptiveTask` namespace from the package root.
- Modify `packages/schema/test/contract-hygiene.test.ts`: include the new reusable schemas in the package-wide stable/unique identifier check.

No Core, Protocol, Server, Runtime, Session, Model, Agent, generated client, or database file changes in S01-T01.

## Task 1: Canonical IDs and Closed Vocabulary

**Files:**

- Create: `packages/schema/test/adaptive-task.test.ts`
- Create: `packages/schema/src/adaptive-task.ts`

- [ ] **Step 1: Write the failing ID and enum tests**

Create `packages/schema/test/adaptive-task.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AdaptiveTask } from "../src/adaptive-task"

describe("AdaptiveTask", () => {
  test("generated identifiers use one exact canonical format", () => {
    const generated = [
      [AdaptiveTask.ID.create(), /^adt_[0-9A-Za-z]{26}$/],
      [AdaptiveTask.AgentID.create(), /^ada_[0-9A-Za-z]{26}$/],
      [AdaptiveTask.RequestID.create(), /^adr_[0-9A-Za-z]{26}$/],
      [AdaptiveTask.ContextManifestID.create(), /^acm_[0-9A-Za-z]{26}$/],
    ] as const

    for (const [value, pattern] of generated) expect(value).toMatch(pattern)
  })

  test("identifier decoding rejects wrong prefixes, lengths, and characters", () => {
    const decode = Schema.decodeUnknownSync(AdaptiveTask.ID)
    expect(() => decode(`ada_${"a".repeat(26)}`)).toThrow()
    expect(() => decode(`adt_${"a".repeat(25)}`)).toThrow()
    expect(() => decode(`adt_${"a".repeat(27)}`)).toThrow()
    expect(() => decode(`adt_${"a".repeat(25)}-`)).toThrow()
  })

  test("mode, role, and status expose only supported values", () => {
    expect(Schema.decodeUnknownSync(AdaptiveTask.Mode)("benchmark")).toBe("benchmark")
    expect(Schema.decodeUnknownSync(AdaptiveTask.Role)("implementation")).toBe("implementation")
    expect(Schema.decodeUnknownSync(AdaptiveTask.Status)("stopped")).toBe("stopped")
    expect(Schema.decodeUnknownSync(AdaptiveTask.Status)("cancelled")).toBe("cancelled")
    expect(() => Schema.decodeUnknownSync(AdaptiveTask.Mode)("assisted-benchmark")).toThrow()
    expect(() => Schema.decodeUnknownSync(AdaptiveTask.Role)("compactor")).toThrow()
    expect(() => Schema.decodeUnknownSync(AdaptiveTask.Status)("paused-maybe")).toThrow()
  })
})
```

- [ ] **Step 2: Run the focused test and verify the module is absent**

Run:

```bash
cd packages/schema
bun test test/adaptive-task.test.ts
```

Expected: FAIL with `Cannot find module '../src/adaptive-task'`. A syntax or fixture error is not the intended RED state.

- [ ] **Step 3: Implement the canonical identifiers and closed literals**

Create `packages/schema/src/adaptive-task.ts`:

```ts
export * as AdaptiveTask from "./adaptive-task"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { statics } from "./schema"

const id = <Prefix extends string, Brand extends string>(prefix: Prefix, brand: Brand) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^${prefix}[0-9A-Za-z]{26}$`))).pipe(
    Schema.brand(brand),
    Schema.annotate({ identifier: brand }),
    statics((schema) => ({ create: () => schema.make(prefix + ascending()) })),
  )

export const ID = id("adt_", "AdaptiveTask.ID")
export type ID = typeof ID.Type
export const AgentID = id("ada_", "AdaptiveTask.AgentID")
export type AgentID = typeof AgentID.Type
export const RequestID = id("adr_", "AdaptiveTask.RequestID")
export type RequestID = typeof RequestID.Type
export const ContextManifestID = id("acm_", "AdaptiveTask.ContextManifestID")
export type ContextManifestID = typeof ContextManifestID.Type

export const Mode = Schema.Literals(["normal", "benchmark"]).annotate({ identifier: "AdaptiveTask.Mode" })
export type Mode = typeof Mode.Type

export const Role = Schema.Literals([
  "coordinator",
  "roadmap-reviewer",
  "discovery",
  "implementation",
  "validator",
  "integration",
]).annotate({ identifier: "AdaptiveTask.Role" })
export type Role = typeof Role.Type

export const Status = Schema.Literals([
  "planning",
  "running",
  "needs_input",
  "stopped",
  "cancelled",
  "failed",
  "completed",
  "invalid",
]).annotate({ identifier: "AdaptiveTask.Status" })
export type Status = typeof Status.Type
```

- [ ] **Step 4: Run focused tests and package typecheck**

Run:

```bash
cd packages/schema
bun test test/adaptive-task.test.ts
bun typecheck
```

Expected: 3 tests pass and typecheck exits `0`.

- [ ] **Step 5: Commit the first green contract slice**

```bash
git add packages/schema/src/adaptive-task.ts packages/schema/test/adaptive-task.test.ts
git commit -m "feat(schema): add adaptive task identities"
```

## Task 2: Immutable ModelPolicy Shape and Task Summary

**Files:**

- Modify: `packages/schema/test/adaptive-task.test.ts`
- Modify: `packages/schema/src/adaptive-task.ts`

- [ ] **Step 1: Add failing ModelPolicy encoding and validation tests**

Add these imports to `packages/schema/test/adaptive-task.test.ts`:

```ts
import { Model } from "../src/model"
import { Provider } from "../src/provider"
```

Add inside the existing `describe` block:

```ts
const policyInput = {
  providerID: Provider.ID.make("test"),
  modelID: Model.ID.make("short-context"),
  effectiveContextLimit: 262_144,
  outputReserve: 16_384,
  safetyReserve: 8_192,
  hash: `sha256:${"a".repeat(64)}`,
}

test("ModelPolicy reuses canonical model IDs and omits an undefined variant", () => {
  const policy = Schema.decodeUnknownSync(AdaptiveTask.ModelPolicy)(policyInput)
  expect(Schema.encodeUnknownSync(AdaptiveTask.ModelPolicy)(policy)).toEqual(policyInput)
})

test("ModelPolicy rejects impossible budgets and non-canonical hashes", () => {
  const decode = Schema.decodeUnknownSync(AdaptiveTask.ModelPolicy)
  expect(() => decode({ ...policyInput, outputReserve: 0 })).toThrow()
  expect(() => decode({ ...policyInput, outputReserve: 131_072, safetyReserve: 131_072 })).toThrow()
  expect(() => decode({ ...policyInput, hash: `sha256:${"A".repeat(64)}` })).toThrow()
  expect(() => decode({ ...policyInput, hash: "sha256:short" })).toThrow()
})

test("ModelPolicy round trips a canonical optional variant", () => {
  const encoded = {
    ...policyInput,
    variant: Model.VariantID.make("high"),
  }
  const policy = Schema.decodeUnknownSync(AdaptiveTask.ModelPolicy)(encoded)
  expect(Schema.encodeUnknownSync(AdaptiveTask.ModelPolicy)(policy)).toEqual(encoded)
})
```

- [ ] **Step 2: Add failing Task Summary boundary tests**

Add this import:

```ts
import { AbsolutePath } from "../src/schema"
```

Add inside the existing `describe` block:

```ts
const summaryInput = {
  id: AdaptiveTask.ID.create(),
  directory: AbsolutePath.make("/workspace/project"),
  mode: "normal" as const,
  status: "planning" as const,
  requirement: "Implement the requested feature",
  modelPolicy: policyInput,
  roadmapRevision: 0,
  timeCreated: 0,
  timeUpdated: 1,
}

test("Task Summary round trips the public status view", () => {
  const summary = Schema.decodeUnknownSync(AdaptiveTask.Summary)(summaryInput)
  expect(Schema.encodeUnknownSync(AdaptiveTask.Summary)(summary)).toEqual(summaryInput)
})

test("Task Summary rejects invalid revisions and timestamps", () => {
  const decode = Schema.decodeUnknownSync(AdaptiveTask.Summary)
  expect(() => decode({ ...summaryInput, roadmapRevision: -1 })).toThrow()
  expect(() => decode({ ...summaryInput, timeCreated: -1 })).toThrow()
  expect(() => decode({ ...summaryInput, timeCreated: 1.5 })).toThrow()
  expect(() => decode({ ...summaryInput, timeUpdated: Number.POSITIVE_INFINITY })).toThrow()
})
```

- [ ] **Step 3: Run the focused test and verify missing schemas cause RED**

Run:

```bash
cd packages/schema
bun test test/adaptive-task.test.ts
```

Expected: FAIL because `AdaptiveTask.ModelPolicy` and `AdaptiveTask.Summary` do not exist. The three ID/enum tests remain green.

- [ ] **Step 4: Implement ModelPolicy with canonical OpenCode schemas and cross-field validation**

Extend imports in `packages/schema/src/adaptive-task.ts`:

```ts
import { Model } from "./model"
import { Provider } from "./provider"
import { AbsolutePath, NonNegativeInt, optional, PositiveInt, statics } from "./schema"
```

Replace the existing `statics`-only schema import with the combined import above, then append:

```ts
const ModelPolicyBase = Schema.Struct({
  providerID: Provider.ID,
  modelID: Model.ID,
  variant: Model.VariantID.pipe(optional),
  effectiveContextLimit: PositiveInt,
  outputReserve: PositiveInt,
  safetyReserve: PositiveInt,
  hash: Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
})

const validContextBudget = Schema.makeFilter<Schema.Schema.Type<typeof ModelPolicyBase>>((policy) =>
  policy.outputReserve + policy.safetyReserve < policy.effectiveContextLimit
    ? undefined
    : "ModelPolicy reserves must be smaller than effectiveContextLimit",
)

export interface ModelPolicy extends Schema.Schema.Type<typeof ModelPolicy> {}
export const ModelPolicy = ModelPolicyBase.check(validContextBudget).annotate({
  identifier: "AdaptiveTask.ModelPolicy",
})

export interface Summary extends Schema.Schema.Type<typeof Summary> {}
export const Summary = Schema.Struct({
  id: ID,
  directory: AbsolutePath,
  mode: Mode,
  status: Status,
  requirement: Schema.String,
  modelPolicy: ModelPolicy,
  roadmapRevision: NonNegativeInt,
  timeCreated: NonNegativeInt,
  timeUpdated: NonNegativeInt,
}).annotate({ identifier: "AdaptiveTask.Summary" })
```

- [ ] **Step 5: Run focused tests and package typecheck**

Run:

```bash
cd packages/schema
bun test test/adaptive-task.test.ts
bun typecheck
```

Expected: 8 tests pass and typecheck exits `0`.

- [ ] **Step 6: Commit the policy and summary slice**

```bash
git add packages/schema/src/adaptive-task.ts packages/schema/test/adaptive-task.test.ts
git commit -m "feat(schema): define adaptive model policy"
```

## Task 3: Canonical Export Identity and Schema Hygiene

**Files:**

- Modify: `packages/schema/test/adaptive-task.test.ts`
- Modify: `packages/schema/test/contract-hygiene.test.ts`
- Modify: `packages/schema/src/index.ts`

- [ ] **Step 1: Write the failing root export identity test**

Add this import to `packages/schema/test/adaptive-task.test.ts`:

```ts
import { AdaptiveTask as RootAdaptiveTask } from "../src"
```

Add inside the existing `describe` block:

```ts
test("root and direct entrypoints expose the same schema identity", () => {
  expect(RootAdaptiveTask.ID).toBe(AdaptiveTask.ID)
  expect(RootAdaptiveTask.ModelPolicy).toBe(AdaptiveTask.ModelPolicy)
  expect(RootAdaptiveTask.Summary).toBe(AdaptiveTask.Summary)
})
```

- [ ] **Step 2: Extend the package-wide public identifier test before changing the root export**

Add this import to `packages/schema/test/contract-hygiene.test.ts`:

```ts
import { AdaptiveTask } from "../src/adaptive-task"
```

Prepend these schemas to the `identifiers` array in `reusable public identifiers are stable and unique`:

```ts
      AdaptiveTask.ID,
      AdaptiveTask.AgentID,
      AdaptiveTask.RequestID,
      AdaptiveTask.ContextManifestID,
      AdaptiveTask.Mode,
      AdaptiveTask.Role,
      AdaptiveTask.Status,
      AdaptiveTask.ModelPolicy,
      AdaptiveTask.Summary,
```

- [ ] **Step 3: Run the focused tests and verify the root import causes RED**

Run:

```bash
cd packages/schema
bun test test/adaptive-task.test.ts test/contract-hygiene.test.ts
```

Expected: FAIL because `AdaptiveTask` is not exported from `packages/schema/src/index.ts`.

- [ ] **Step 4: Export the canonical namespace from the Schema root**

Add this ordered root export immediately after `Agent` in `packages/schema/src/index.ts`:

```ts
export { AdaptiveTask } from "./adaptive-task"
```

Do not add a second wrapper, copied schema, Core facade, V1 alias, or generated contract.

- [ ] **Step 5: Run focused, full-package, type, format, and diff verification**

Run:

```bash
cd packages/schema
bun test test/adaptive-task.test.ts test/contract-hygiene.test.ts
bun test
bun typecheck
cd ../..
bunx prettier --check packages/schema/src/adaptive-task.ts packages/schema/src/index.ts packages/schema/test/adaptive-task.test.ts packages/schema/test/contract-hygiene.test.ts
git diff --check
```

Expected:

- focused tests pass;
- all Schema package tests pass;
- `bun typecheck` exits `0`;
- Prettier and `git diff --check` exit `0`;
- no file outside the four-file S01-T01 map changes.

- [ ] **Step 6: Commit the public export and hygiene proof**

```bash
git add packages/schema/src/index.ts packages/schema/test/adaptive-task.test.ts packages/schema/test/contract-hygiene.test.ts
git commit -m "test(schema): verify adaptive contract hygiene"
```

## Task 4: Issue and PR Evidence

**Files:**

- No product file changes.

- [ ] **Step 1: Review the complete task diff against the stage branch**

Run:

```bash
git diff --check stage-01...HEAD
git diff --stat stage-01...HEAD
git status --short
```

Expected: only the four planned Schema files differ and the worktree is clean.

- [ ] **Step 2: Attach verification evidence to Issue #1 and open the task PR**

The PR must:

- target `stage-01`;
- use a conventional title such as `feat(schema): add adaptive task contract`;
- include `Closes #1`;
- list focused test, full Schema test, typecheck, Prettier, and diff-check results;
- link the approved design and this implementation plan;
- state explicitly that no baseline Session/Agent/Model behavior changed.

- [ ] **Step 3: Do not merge without review**

Resolve Critical and Important review findings, rerun the complete Task 3 Step 5 verification, and merge only into `stage-01`. G1 remains unmergeable to `main` until S01-T10 user acceptance.
