import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AdaptiveTask as RootAdaptiveTask } from "../src"
import { AdaptiveTask } from "../src/adaptive-task"
import { Model } from "../src/model"
import { Provider } from "../src/provider"
import { AbsolutePath } from "../src/schema"

describe("AdaptiveTask", () => {
  const policyInput = {
    providerID: Provider.ID.make("test"),
    modelID: Model.ID.make("short-context"),
    effectiveContextLimit: 262_144,
    outputReserve: 16_384,
    safetyReserve: 8_192,
    hash: `sha256:${"a".repeat(64)}`,
  }

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
    const identifiers = [
      [Schema.decodeUnknownSync(AdaptiveTask.ID), "adt_"],
      [Schema.decodeUnknownSync(AdaptiveTask.AgentID), "ada_"],
      [Schema.decodeUnknownSync(AdaptiveTask.RequestID), "adr_"],
      [Schema.decodeUnknownSync(AdaptiveTask.ContextManifestID), "acm_"],
    ] as const

    for (const [decode, prefix] of identifiers) {
      expect(() => decode(`${prefix}${"a".repeat(26)}`)).not.toThrow()
      expect(() => decode(`bad_${"a".repeat(26)}`)).toThrow()
      expect(() => decode(`${prefix}${"a".repeat(25)}`)).toThrow()
      expect(() => decode(`${prefix}${"a".repeat(27)}`)).toThrow()
      expect(() => decode(`${prefix}${"a".repeat(25)}-`)).toThrow()
    }
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

  test("root and direct entrypoints expose the same schema identity", () => {
    expect(RootAdaptiveTask.ID).toBe(AdaptiveTask.ID)
    expect(RootAdaptiveTask.ModelPolicy).toBe(AdaptiveTask.ModelPolicy)
    expect(RootAdaptiveTask.Summary).toBe(AdaptiveTask.Summary)
  })
})
