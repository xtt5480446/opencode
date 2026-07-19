import { AdaptiveModelAudit } from "@opencode-ai/core/adaptive/model-audit"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Message } from "@opencode-ai/llm"
import { Context, Effect, Layer, Schema, Scope, Stream } from "effect"
import { AdaptiveModelGateway } from "./model-gateway"
import { AdaptiveProcessSupervisor } from "./process/supervisor"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"

export const BOOTSTRAP_SYSTEM =
  "You are the Coordinator process for an Adaptive Runtime task. Confirm that you received the exact task requirement and return one concise sentence identifying whether repository discovery is required. Do not propose code, use another model, or claim the task is complete."

export const Incompatible = Schema.Literals([
  "continue",
  "session",
  "fork",
  "command",
  "share",
  "attach",
  "interactive",
])
export type Incompatible = typeof Incompatible.Type

export interface Input {
  readonly directory: string
  readonly requirement: string
  readonly mode: AdaptiveTask.Mode
  readonly requestedModel: { readonly providerID: string; readonly modelID: string; readonly variant?: string }
  readonly incompatible?: Incompatible
  readonly format?: "default" | "json"
  readonly emit?: (event: Record<string, unknown>) => void
}

export class IncompatibleError extends Schema.TaggedErrorClass<IncompatibleError>()(
  "AdaptiveController.Incompatible",
  { option: Incompatible },
) {
  override get message() {
    return `--runtime adaptive cannot be combined with --${this.option}`
  }
}

export const validateInput = Effect.fn("AdaptiveController.validateInput")(function* (input: Input) {
  if (input.incompatible !== undefined) return yield* new IncompatibleError({ option: input.incompatible })
  return input
})

export interface Interface {
  readonly start: (input: Input) => Effect.Effect<StartResult, IncompatibleError | Error, Scope.Scope>
}

export interface StartResult {
  readonly taskID: AdaptiveTask.ID
  readonly status: AdaptiveTask.Status
  readonly bootstrap?: string
}

export type Error = unknown

export const make = Effect.fn("AdaptiveController.make")(function* () {
  const store = yield* AdaptiveStore.Service
  const supervisor = yield* AdaptiveProcessSupervisor.Service
  const gateway = yield* AdaptiveModelGateway.Service
  const locations = yield* LocationServiceMap.Service
  const makeStart = Effect.fn("AdaptiveController.start")(function* (input: Input) {
    yield* validateInput(input)
    const resolved = yield* SessionRunnerModel.Service.use((models) =>
      models.resolveRef({
        model: {
          providerID: Provider.ID.make(input.requestedModel.providerID),
          id: Model.ID.make(input.requestedModel.modelID),
          variant:
            input.requestedModel.variant === undefined
              ? undefined
              : Model.VariantID.make(input.requestedModel.variant),
        },
      }),
    ).pipe(
      Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(input.directory) }))),
      Effect.catch(() => Effect.succeed(undefined)),
    )
    const routeLimit = resolved?.route.defaults.limits?.context ?? resolved?.defaults?.limits?.context ?? 100_000
    const policy = AdaptiveModelPolicy.create({
      providerID: Provider.ID.make(input.requestedModel.providerID),
      modelID: Model.ID.make(input.requestedModel.modelID),
      ...(input.requestedModel.variant ? { variant: Model.VariantID.make(input.requestedModel.variant) } : {}),
      effectiveContextLimit: routeLimit,
      outputReserve: Math.min(16_384, Math.floor(routeLimit / 4)),
      safetyReserve: Math.min(8_192, Math.floor(routeLimit / 8)),
    })
    const task = yield* store.createTask({
      id: AdaptiveTask.ID.create(),
      directory: input.directory,
      mode: input.mode,
      status: "planning",
      requirement: input.requirement || "Inspect repository",
      modelPolicy: policy,
      roadmapRevision: 0,
      baseSnapshotHash: "unknown",
    })
    const agent = yield* store.createAgent({ id: AdaptiveTask.AgentID.create(), taskID: task.id, role: "coordinator" })
    input.emit?.({ type: "adaptive.task.created", taskID: task.id, status: task.status })
    let manifest: AdaptiveStore.ManifestRecord | undefined
    const handle = yield* supervisor.start({
      agentID: agent.id,
      router: (method, payload, identity) => {
        if (method === "process.complete") return Effect.succeed({ status: "accepted" })
        if (!manifest)
          return Effect.fail(
            new AdaptiveProcessSupervisor.RpcError({ code: "BOOTSTRAP", message: "Bootstrap manifest is not ready" }),
          )
        const requestID = AdaptiveTask.RequestID.create()
        return Effect.succeed(
          gateway
            .stream({
              taskID: identity.taskID,
              agentID: identity.agentID,
              generation: identity.generation,
              manifestID: manifest.id,
              requestID,
            })
            .pipe(
              Stream.map((event) => ({ event: { type: event.type } }) as never),
              Stream.mapError(
                () => new AdaptiveProcessSupervisor.RpcError({ code: "MODEL", message: "Adaptive model request failed" }),
              ),
            ),
        )
      },
    })
    manifest = yield* store.putManifest({
      id: AdaptiveTask.ContextManifestID.create(),
      taskID: task.id,
      agentID: agent.id,
      generation: handle.generation,
      owner: handle.owner,
      purpose: "coordinator bootstrap",
      system: [BOOTSTRAP_SYSTEM],
      messages: [Message.user(input.requirement || "Inspect repository")],
      tools: [],
      components: [],
      estimatedTokens: Math.ceil((BOOTSTRAP_SYSTEM.length + input.requirement.length) / 4),
      requestHash: "sha256:bootstrap",
    })
    const result = yield* handle.request("model.stream", { requirement: input.requirement }).pipe(
      Effect.catch(() => Effect.succeed({ status: "bootstrap-failed" })),
    )
    return { taskID: task.id, status: task.status, bootstrap: JSON.stringify(result) }
  })
  return { start: makeStart } satisfies Interface
})

export class Service extends Context.Service<Service, Interface>()("@opencode/AdaptiveController") {}

export const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [AdaptiveStore.node, AdaptiveModelGateway.node, AdaptiveProcessSupervisor.node, LocationServiceMap.node],
})
export * as AdaptiveController from "./controller"
