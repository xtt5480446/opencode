import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { AdaptiveController } from "@/adaptive/controller"

describe("AdaptiveController", () => {
  test("exports the fixed coordinator bootstrap contract", () => {
    expect(AdaptiveController.BOOTSTRAP_SYSTEM).toBe(
      "You are the Coordinator process for an Adaptive Runtime task. Confirm that you received the exact task requirement and return one concise sentence identifying whether repository discovery is required. Do not propose code, use another model, or claim the task is complete.",
    )
  })

  test("rejects legacy session controls before bootstrap", async () => {
    const result = await Effect.runPromise(
      AdaptiveController.validateInput({
        directory: "/tmp/project",
        requirement: "inspect",
        mode: "normal",
        requestedModel: { providerID: "test", modelID: "model" },
        incompatible: "session",
      }).pipe(Effect.exit),
    )
    expect(Exit.isFailure(result)).toBe(true)
  })
})
