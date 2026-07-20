# S01-T02 Immutable ModelPolicy Hashing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic ModelPolicy creation and integrity-aware equality checks to Core without changing baseline OpenCode execution behavior.

**Architecture:** A new `AdaptiveModelPolicy` Core namespace projects the six execution-affecting fields into one fixed-order compact JSON string, hashes it through OpenCode's existing `Hash.sha256`, and constructs the canonical Schema contract from S01-T01. Equality recomputes both hashes and compares both canonical strings, so field drift, stale hashes, and identically tampered policies are rejected.

**Tech Stack:** TypeScript, Bun test, Node-compatible Core runtime, OpenCode `Hash.sha256`, Effect Schema contracts through `@opencode-ai/schema`.

---

This plan implements the [approved S01-T02 design](../specs/2026-07-17-s01-t02-model-policy-hashing-design.md) and supersedes Task 2 in the broader G1 foundation plan where the two differ.

## File Map

- Create `packages/core/src/adaptive/model-policy.ts`: the only Core implementation of canonical Adaptive ModelPolicy hashing and equality.
- Create `packages/core/test/adaptive/model-policy.test.ts`: deterministic hash, field sensitivity, validation, drift, and tampering tests.
- Retain `docs/superpowers/specs/2026-07-17-s01-t02-model-policy-hashing-design.md`: approved behavioral contract.
- Retain `docs/superpowers/plans/2026-07-17-s01-t02-model-policy-hashing.md`: execution and verification record.

No Schema, database, Protocol, Server, CLI, SDK, Session, Agent, Model, provider, or generated file changes are permitted in S01-T02.

## Task 1: Canonical Creation and Known Hash

**Files:**

- Create: `packages/core/test/adaptive/model-policy.test.ts`
- Create: `packages/core/src/adaptive/model-policy.ts`

- [ ] **Step 1: Write the failing canonical creation tests**

Create `packages/core/test/adaptive/model-policy.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"

const input = {
  providerID: Provider.ID.make("openai-compatible"),
  modelID: Model.ID.make("kimi-k2"),
  variant: Model.VariantID.make("default"),
  effectiveContextLimit: 262_144,
  outputReserve: 16_384,
  safetyReserve: 8_192,
} as const

const reordered = {
  safetyReserve: input.safetyReserve,
  outputReserve: input.outputReserve,
  effectiveContextLimit: input.effectiveContextLimit,
  variant: input.variant,
  modelID: input.modelID,
  providerID: input.providerID,
}

describe("AdaptiveModelPolicy", () => {
  test("matches the fixed canonical SHA-256 vector", () => {
    expect(AdaptiveModelPolicy.create(input).hash).toBe(
      "sha256:461b22cf2dc632671fdc8d9a34a2c31c1b044edfddbc7e41fe29a401d1801e04",
    )
  })

  test("caller key order does not affect the hash", () => {
    expect(AdaptiveModelPolicy.create(reordered).hash).toBe(AdaptiveModelPolicy.create(input).hash)
  })

  test("omitted and explicitly undefined variants have one representation", () => {
    const withoutVariant = {
      providerID: input.providerID,
      modelID: input.modelID,
      effectiveContextLimit: input.effectiveContextLimit,
      outputReserve: input.outputReserve,
      safetyReserve: input.safetyReserve,
    }
    expect(AdaptiveModelPolicy.create({ ...withoutVariant, variant: undefined }).hash).toBe(
      AdaptiveModelPolicy.create(withoutVariant).hash,
    )
  })

  test("every execution field affects the hash", () => {
    const baseline = AdaptiveModelPolicy.create(input).hash
    const changed = [
      { ...input, providerID: Provider.ID.make("other-provider") },
      { ...input, modelID: Model.ID.make("other-model") },
      { ...input, variant: Model.VariantID.make("high") },
      { ...input, effectiveContextLimit: 131_072 },
      { ...input, outputReserve: 8_192 },
      { ...input, safetyReserve: 4_096 },
    ].map(AdaptiveModelPolicy.create)

    for (const policy of changed) expect(policy.hash).not.toBe(baseline)
    expect(new Set(changed.map((policy) => policy.hash)).size).toBe(changed.length)
  })

  test("creation preserves the S01-T01 budget invariants", () => {
    expect(() => AdaptiveModelPolicy.create({ ...input, outputReserve: 0 })).toThrow()
    expect(() => AdaptiveModelPolicy.create({ ...input, outputReserve: 131_072, safetyReserve: 131_072 })).toThrow()
  })
})
```

- [ ] **Step 2: Run the focused test and verify the module is absent**

Run:

```bash
cd packages/core
bun test test/adaptive/model-policy.test.ts
```

Expected: FAIL with `Cannot find module '@opencode-ai/core/adaptive/model-policy'`. Fixture, syntax, or dependency failures are not the intended RED state.

- [ ] **Step 3: Implement fixed-field serialization and canonical creation**

Create `packages/core/src/adaptive/model-policy.ts`:

```ts
export * as AdaptiveModelPolicy from "./model-policy"

import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Hash } from "../util/hash"

export type Input = Omit<AdaptiveTask.ModelPolicy, "hash">

const canonical = (input: Input) =>
  JSON.stringify({
    providerID: input.providerID,
    modelID: input.modelID,
    ...(input.variant === undefined ? {} : { variant: input.variant }),
    effectiveContextLimit: input.effectiveContextLimit,
    outputReserve: input.outputReserve,
    safetyReserve: input.safetyReserve,
  })

const digest = (value: string) => `sha256:${Hash.sha256(value)}`

export const create = (input: Input) =>
  AdaptiveTask.ModelPolicy.make({
    ...input,
    hash: digest(canonical(input)),
  })
```

Do not import `node:crypto`, hash the caller object directly, add a generic stable-stringify helper, or accept a caller-supplied hash.

- [ ] **Step 4: Run focused tests and Core typecheck**

Run:

```bash
cd packages/core
bun test test/adaptive/model-policy.test.ts
bun typecheck
```

Expected: 5 tests pass and typecheck exits `0`.

- [ ] **Step 5: Commit the canonical creation slice**

```bash
git add packages/core/src/adaptive/model-policy.ts packages/core/test/adaptive/model-policy.test.ts
git commit -m "feat(core): create adaptive model policy"
```

## Task 2: Integrity-Aware Equality

**Files:**

- Modify: `packages/core/test/adaptive/model-policy.test.ts`
- Modify: `packages/core/src/adaptive/model-policy.ts`

- [ ] **Step 1: Add the failing equality and tampering tests**

Add this import to `packages/core/test/adaptive/model-policy.test.ts`:

```ts
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
```

Add inside the existing `describe` block:

```ts
test("accepts independently created equal policies", () => {
  expect(() =>
    AdaptiveModelPolicy.assertEqual(AdaptiveModelPolicy.create(input), AdaptiveModelPolicy.create(reordered)),
  ).not.toThrow()
})

test("rejects field drift and a reused old hash", () => {
  const expected = AdaptiveModelPolicy.create(input)
  const changed = AdaptiveModelPolicy.create({ ...input, variant: Model.VariantID.make("high") })
  expect(() => AdaptiveModelPolicy.assertEqual(expected, changed)).toThrow("Adaptive ModelPolicy mismatch")

  const reused = AdaptiveTask.ModelPolicy.make({ ...changed, hash: expected.hash })
  expect(() => AdaptiveModelPolicy.assertEqual(expected, reused)).toThrow("Adaptive ModelPolicy mismatch")
})

test("rejects changed hashes and two identically tampered policies", () => {
  const expected = AdaptiveModelPolicy.create(input)
  const tampered = AdaptiveTask.ModelPolicy.make({ ...expected, hash: `sha256:${"b".repeat(64)}` })
  expect(() => AdaptiveModelPolicy.assertEqual(expected, tampered)).toThrow("Adaptive ModelPolicy mismatch")
  expect(() => AdaptiveModelPolicy.assertEqual(tampered, tampered)).toThrow("Adaptive ModelPolicy mismatch")
})
```

- [ ] **Step 2: Run the focused test and verify equality is missing**

Run:

```bash
cd packages/core
bun test test/adaptive/model-policy.test.ts
```

Expected: the original 5 tests remain green and the 3 new tests fail because `AdaptiveModelPolicy.assertEqual` does not exist.

- [ ] **Step 3: Implement dual hash recomputation and canonical equality**

Append to `packages/core/src/adaptive/model-policy.ts`:

```ts
export function assertEqual(expected: AdaptiveTask.ModelPolicy, actual: AdaptiveTask.ModelPolicy) {
  const expectedCanonical = canonical(expected)
  const actualCanonical = canonical(actual)
  if (
    expected.hash === digest(expectedCanonical) &&
    actual.hash === digest(actualCanonical) &&
    expected.hash === actual.hash &&
    expectedCanonical === actualCanonical
  )
    return
  throw new Error(`Adaptive ModelPolicy mismatch: expected ${expected.hash}, received ${actual.hash}`)
}
```

- [ ] **Step 4: Run focused tests and Core typecheck**

Run:

```bash
cd packages/core
bun test test/adaptive/model-policy.test.ts
bun typecheck
```

Expected: 8 tests pass and typecheck exits `0`.

- [ ] **Step 5: Commit the equality slice**

```bash
git add packages/core/src/adaptive/model-policy.ts packages/core/test/adaptive/model-policy.test.ts
git commit -m "feat(core): detect adaptive policy drift"
```

## Task 3: Full Verification and PR Evidence

**Files:**

- No additional product files.

- [ ] **Step 1: Run focused and full Core verification**

Run:

```bash
cd packages/core
bun test test/adaptive/model-policy.test.ts
bun test
bun typecheck
cd ../..
bunx prettier --check packages/core/src/adaptive/model-policy.ts packages/core/test/adaptive/model-policy.test.ts docs/superpowers/specs/2026-07-17-s01-t02-model-policy-hashing-design.md docs/superpowers/plans/2026-07-17-s01-t02-model-policy-hashing.md
git diff --check stage-01...HEAD
```

Expected: focused and full Core tests pass, typecheck exits `0`, and formatting/diff checks pass.

- [ ] **Step 2: Verify the exact task boundary**

Run:

```bash
git diff --name-only stage-01...HEAD
git status --short
```

Expected: only the two Core files and the S01-T02 design/plan documents differ; the worktree is clean.

- [ ] **Step 3: Attach evidence and open the task PR**

The PR must:

- target `stage-01`;
- use `feat(core): pin adaptive model policy`;
- include `Closes #2`;
- link the approved design and this implementation plan;
- report RED/GREEN evidence, focused/full Core tests, Core typecheck, Prettier, exact diff boundary, and pre-push repository typecheck;
- state that `Hash.sha256` is reused and no baseline Session, Agent, Model, provider, Protocol, or generated behavior changed.

- [ ] **Step 4: Review before merge**

Review `stage-01...HEAD` for canonicalization omissions, hash-integrity gaps, accidental Node crypto duplication, and out-of-scope changes. Resolve all Critical and Important findings, rerun Task 3 Step 1, and merge only into `stage-01`.
