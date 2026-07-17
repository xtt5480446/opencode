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
})
