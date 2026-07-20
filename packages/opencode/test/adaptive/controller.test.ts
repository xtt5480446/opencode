import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, LayerMap } from "effect"
import { AdaptiveController } from "@/adaptive/controller"
import { AdaptiveModelGateway } from "@/adaptive/model-gateway"
import { AdaptiveProcessSupervisor } from "@/adaptive/process/supervisor"
import { runAdaptiveRole } from "@/cli/cmd/adaptive-agent"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { Catalog } from "@opencode-ai/core/catalog"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Auth } from "@/auth"

const noAuth = Layer.succeed(
  Auth.Service,
  Auth.Service.of({
    get: () => Effect.succeed(undefined),
    all: () => Effect.succeed({}),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
)

describe("AdaptiveController", () => {
  test("exports the fixed coordinator bootstrap contract", () => {
    expect(AdaptiveController.BOOTSTRAP_SYSTEM).toBe(
      "You are the Coordinator process for an Adaptive Runtime task. Confirm that you received the exact task requirement and return one concise sentence identifying whether repository discovery is required. Do not propose code, use another model, or claim the task is complete.",
    )
    expect(AdaptiveController.CATALOG_READY_TIMEOUT_MS).toBe(300_000)
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

  test("waits for the final catalog plugin before resolving the requested model", async () => {
    const waited: string[] = []
    const location = Layer.mergeAll(
      Layer.succeed(
        PluginV2.Service,
        PluginV2.Service.of({
          add: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
          wait: (id) => Effect.sync(() => waited.push(id)),
        }),
      ),
      Layer.succeed(
        Integration.Service,
        Integration.Service.of({ reload: () => Effect.void } as Integration.Interface),
      ),
      Layer.succeed(Catalog.Service, Catalog.Service.of({ reload: () => Effect.void } as Catalog.Interface)),
      Layer.succeed(
        SessionRunnerModel.Service,
        SessionRunnerModel.Service.of({
          resolve: () => Effect.die("unused"),
          resolveRef: () => Effect.die("stop after readiness check"),
        }),
      ),
    )
    const locationMap = Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make((_ref: Location.Ref) => location).pipe(
        Effect.map((map) => map as unknown as LayerMap.LayerMap<Location.Ref, LocationServices>),
      ),
    )
    const dependencies = Layer.mergeAll(
      Layer.succeed(AdaptiveStore.Service, AdaptiveStore.Service.of({} as AdaptiveStore.Interface)),
      Layer.succeed(
        AdaptiveProcessSupervisor.Service,
        AdaptiveProcessSupervisor.Service.of({} as AdaptiveProcessSupervisor.Interface),
      ),
      Layer.succeed(
        AdaptiveModelGateway.Service,
        AdaptiveModelGateway.Service.of({} as AdaptiveModelGateway.Interface),
      ),
      noAuth,
      locationMap,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const controller = yield* AdaptiveController.make()
        yield* Effect.scoped(
          controller.start({
            directory: "/tmp/project",
            requirement: "inspect",
            mode: "normal",
            requestedModel: { providerID: "test", modelID: "model" },
          }),
        ).pipe(Effect.exit)
      }).pipe(Effect.provide(dependencies)),
    )

    expect(waited).toEqual(["variant"])
  })

  test("fails boundedly when final catalog readiness never completes", async () => {
    const location = Layer.mergeAll(
      Layer.succeed(
        PluginV2.Service,
        PluginV2.Service.of({
          add: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
          wait: () => Effect.never,
        }),
      ),
      Layer.succeed(
        Integration.Service,
        Integration.Service.of({ reload: () => Effect.die("unreachable") } as unknown as Integration.Interface),
      ),
      Layer.succeed(
        Catalog.Service,
        Catalog.Service.of({ reload: () => Effect.die("unreachable") } as unknown as Catalog.Interface),
      ),
      Layer.succeed(
        SessionRunnerModel.Service,
        SessionRunnerModel.Service.of({
          resolve: () => Effect.die("unused"),
          resolveRef: () => Effect.die("unreachable"),
        }),
      ),
    )
    const locationMap = Layer.effect(
      LocationServiceMap.Service,
      LayerMap.make((_ref: Location.Ref) => location).pipe(
        Effect.map((map) => map as unknown as LayerMap.LayerMap<Location.Ref, LocationServices>),
      ),
    )
    const dependencies = Layer.mergeAll(
      Layer.succeed(AdaptiveStore.Service, AdaptiveStore.Service.of({} as AdaptiveStore.Interface)),
      Layer.succeed(
        AdaptiveProcessSupervisor.Service,
        AdaptiveProcessSupervisor.Service.of({} as AdaptiveProcessSupervisor.Interface),
      ),
      Layer.succeed(
        AdaptiveModelGateway.Service,
        AdaptiveModelGateway.Service.of({} as AdaptiveModelGateway.Interface),
      ),
      noAuth,
      locationMap,
    )

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const controller = yield* AdaptiveController.make({ catalogReadyTimeoutMs: 1 })
        return yield* Effect.scoped(
          controller.start({
            directory: "/tmp/project",
            requirement: "inspect",
            mode: "normal",
            requestedModel: { providerID: "test", modelID: "model" },
          }),
        ).pipe(Effect.flip)
      }).pipe(Effect.provide(dependencies)),
    )

    expect(error._tag).toBe("AdaptiveController.CatalogUnavailable")
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
