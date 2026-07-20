import { describe, expect, test } from "bun:test"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
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
})
