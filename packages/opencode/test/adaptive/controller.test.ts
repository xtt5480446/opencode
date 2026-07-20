import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { AdaptiveController } from "@/adaptive/controller"
import { runAdaptiveRole } from "@/cli/cmd/adaptive-agent"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"

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

  test("the coordinator child streams one bootstrap turn and acknowledges completion", async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    await runAdaptiveRole({
      identity: {
        taskID: AdaptiveTask.ID.create(),
        agentID: AdaptiveTask.AgentID.create(),
        generation: 1,
        role: "coordinator",
      },
      shutdown: new Promise<string>(() => {}),
      modelStream: async (payload, onEvent) => {
        calls.push({ method: "model.stream", payload })
        onEvent?.({ type: "text-delta", id: "text-1", text: "Repository discovery is required." })
      },
      complete: async (payload) => {
        calls.push({ method: "process.complete", payload })
      },
    })

    expect(calls).toEqual([
      { method: "model.stream", payload: null },
      {
        method: "process.complete",
        payload: { type: "bootstrap.completed", bootstrap: "Repository discovery is required." },
      },
    ])
  })
})
