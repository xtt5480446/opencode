import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { Catalog } from "@opencode-ai/core/catalog"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Hash } from "@opencode-ai/core/util/hash"
import { LLMEvent } from "@opencode-ai/llm"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Context, Deferred, Effect, Layer, Option, Ref, Schema, Scope, Stream } from "effect"
import { AdaptiveModelGateway } from "./model-gateway"
import { AgentProcessProtocol } from "./process/protocol"
import { AdaptiveProcessSupervisor } from "./process/supervisor"

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
  "file",
])
export type Incompatible = typeof Incompatible.Type

export type Event =
  | { readonly type: "adaptive.task.created"; readonly taskID: AdaptiveTask.ID; readonly status: "planning" }
  | {
      readonly type: "adaptive.bootstrap.completed"
      readonly taskID: AdaptiveTask.ID
      readonly bootstrap: string
    }

export interface Input {
  readonly directory: string
  readonly requirement: string
  readonly mode: AdaptiveTask.Mode
  readonly requestedModel: { readonly providerID: string; readonly modelID: string; readonly variant?: string }
  readonly incompatible?: Incompatible
  readonly emit?: (event: Event) => void
}

export class IncompatibleError extends Schema.TaggedErrorClass<IncompatibleError>()("AdaptiveController.Incompatible", {
  option: Incompatible,
}) {
  override get message() {
    return `--runtime adaptive cannot be combined with --${this.option}`
  }
}

export class ModelUnavailableError extends Schema.TaggedErrorClass<ModelUnavailableError>()(
  "AdaptiveController.ModelUnavailable",
  {
    providerID: Provider.ID,
    modelID: Model.ID,
  },
) {
  override get message() {
    return `Adaptive model is unavailable: ${this.providerID}/${this.modelID}`
  }
}

export class BootstrapError extends Schema.TaggedErrorClass<BootstrapError>()("AdaptiveController.Bootstrap", {
  stage: Schema.Literals(["task", "process", "manifest", "model", "completion"]),
}) {
  override get message() {
    return `Adaptive bootstrap failed during ${this.stage}`
  }
}

export const validateInput = Effect.fn("AdaptiveController.validateInput")(function* (input: Input) {
  if (input.incompatible !== undefined) return yield* new IncompatibleError({ option: input.incompatible })
  return input
})

export interface StartResult {
  readonly taskID: AdaptiveTask.ID
  readonly status: "planning"
  readonly bootstrap: string
  readonly agentID: AdaptiveTask.AgentID
  readonly generation: number
  readonly pid: number
  readonly requestID: AdaptiveTask.RequestID
  readonly modelPolicy: AdaptiveTask.ModelPolicy
}

export type Error = IncompatibleError | ModelUnavailableError | BootstrapError

export interface Interface {
  readonly start: (input: Input) => Effect.Effect<StartResult, Error, Scope.Scope>
}

const Completion = Schema.Struct({
  type: Schema.Literal("bootstrap.completed"),
  bootstrap: Schema.Trim.pipe(Schema.check(Schema.isNonEmpty())),
})
const decodeCompletion = Schema.decodeUnknownEffect(Completion)
const decodeJsonValue = Schema.decodeUnknownSync(AgentProcessProtocol.JsonValue)

const eventPayload = (event: LLMEvent) => {
  const base = Object.fromEntries(
    Object.entries(event).filter(([key, value]) => key !== "usage" && value !== undefined),
  )
  const usage =
    "usage" in event && event.usage
      ? Object.fromEntries(
          Object.entries({
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            nonCachedInputTokens: event.usage.nonCachedInputTokens,
            cacheReadInputTokens: event.usage.cacheReadInputTokens,
            cacheWriteInputTokens: event.usage.cacheWriteInputTokens,
            reasoningTokens: event.usage.reasoningTokens,
            totalTokens: event.usage.totalTokens,
          }).filter((entry) => entry[1] !== undefined),
        )
      : undefined
  return decodeJsonValue({ ...base, ...(usage ? { usage } : {}) })
}

export const make = Effect.fn("AdaptiveController.make")(function* () {
  const store = yield* AdaptiveStore.Service
  const supervisor = yield* AdaptiveProcessSupervisor.Service
  const gateway = yield* AdaptiveModelGateway.Service
  const locations = yield* LocationServiceMap.Service

  const makeStart = Effect.fn("AdaptiveController.start")(function* (input: Input) {
    yield* validateInput(input)
    const providerID = Provider.ID.make(input.requestedModel.providerID)
    const modelID = Model.ID.make(input.requestedModel.modelID)
    const variant = input.requestedModel.variant ? Model.VariantID.make(input.requestedModel.variant) : undefined
    const location = locations.get(Location.Ref.make({ directory: AbsolutePath.make(input.directory) }))
    const resolved = yield* Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      yield* plugins.wait(PluginV2.ID.make("config-provider"))
      const integrations = yield* Integration.Service
      yield* integrations.reload()
      const catalog = yield* Catalog.Service
      yield* catalog.reload()
      const models = yield* SessionRunnerModel.Service
      return yield* models.resolveRef({ model: { providerID, id: modelID, variant } })
    }).pipe(
      Effect.provide(location),
      Effect.mapError(() => new ModelUnavailableError({ providerID, modelID })),
    )
    const contextLimit = resolved.defaults?.limits?.context ?? resolved.route.defaults.limits?.context
    if (!contextLimit || !Number.isSafeInteger(contextLimit) || contextLimit < 4)
      return yield* new ModelUnavailableError({ providerID, modelID })
    const routeOutput = resolved.defaults?.limits?.output ?? resolved.route.defaults.limits?.output
    const outputReserve = Math.max(1, Math.min(16_384, routeOutput ?? 16_384, Math.floor(contextLimit / 4)))
    const safetyReserve = Math.max(1, Math.min(8_192, Math.floor(contextLimit / 8)))
    const modelPolicy = AdaptiveModelPolicy.create({
      providerID,
      modelID,
      ...(variant ? { variant } : {}),
      effectiveContextLimit: contextLimit,
      outputReserve,
      safetyReserve,
    })
    const requirement = input.requirement.trim() ? input.requirement : "Inspect repository"
    const task = yield* store
      .createTask({
        id: AdaptiveTask.ID.create(),
        directory: input.directory,
        mode: input.mode,
        status: "planning",
        requirement,
        modelPolicy,
        roadmapRevision: 0,
        baseSnapshotHash: "unavailable:stage-1",
      })
      .pipe(Effect.mapError(() => new BootstrapError({ stage: "task" })))
    input.emit?.({ type: "adaptive.task.created", taskID: task.id, status: "planning" })

    const agent = yield* store
      .createAgent({ id: AdaptiveTask.AgentID.create(), taskID: task.id, role: "coordinator" })
      .pipe(Effect.mapError(() => new BootstrapError({ stage: "task" })))
    const manifest = yield* Deferred.make<AdaptiveStore.ManifestRecord>()
    const completion = yield* Deferred.make<typeof Completion.Type>()
    const modelRequested = yield* Ref.make(false)
    const requestID = AdaptiveTask.RequestID.create()
    const messages = [{ role: "user", content: [{ type: "text", text: requirement }] }]
    const requestHash = `sha256:${Hash.sha256(JSON.stringify({ system: [BOOTSTRAP_SYSTEM], messages, tools: [] }))}`

    const handle = yield* supervisor
      .start({
        agentID: agent.id,
        prepare: (identity) =>
          store
            .putManifest({
              id: AdaptiveTask.ContextManifestID.create(),
              taskID: task.id,
              agentID: agent.id,
              generation: identity.generation,
              owner: identity.owner,
              purpose: "coordinator bootstrap",
              system: [BOOTSTRAP_SYSTEM],
              messages,
              tools: [],
              components: [],
              estimatedTokens: Math.ceil((BOOTSTRAP_SYSTEM.length + requirement.length) / 4),
              requestHash,
            })
            .pipe(
              Effect.flatMap((record) => Deferred.succeed(manifest, record)),
              Effect.asVoid,
              Effect.mapError(
                () =>
                  new AdaptiveProcessSupervisor.RpcError({
                    code: "MANIFEST",
                    message: "Adaptive bootstrap manifest failed",
                  }),
              ),
            ),
        router: (method, payload, identity) => {
          if (method === "process.complete")
            return decodeCompletion(payload).pipe(
              Effect.mapError(
                () =>
                  new AdaptiveProcessSupervisor.RpcError({
                    code: "COMPLETION",
                    message: "Adaptive bootstrap completion was invalid",
                  }),
              ),
              Effect.flatMap((result) =>
                Deferred.await(manifest).pipe(
                  Effect.flatMap((record) =>
                    store.completeBootstrap({
                      taskID: identity.taskID,
                      agentID: identity.agentID,
                      generation: identity.generation,
                      manifestID: record.id,
                      requestID,
                      output: result.bootstrap,
                    }),
                  ),
                  Effect.mapError(
                    () =>
                      new AdaptiveProcessSupervisor.RpcError({
                        code: "COMPLETION",
                        message: "Adaptive bootstrap model request did not succeed",
                      }),
                  ),
                  Effect.flatMap(() => Deferred.succeed(completion, result)),
                  Effect.flatMap((accepted) =>
                    accepted
                      ? Effect.succeed(null)
                      : Effect.fail(
                          new AdaptiveProcessSupervisor.RpcError({
                            code: "COMPLETION",
                            message: "Adaptive bootstrap completed more than once",
                          }),
                        ),
                  ),
                ),
              ),
            )

          return Ref.getAndSet(modelRequested, true).pipe(
            Effect.flatMap((alreadyRequested) =>
              alreadyRequested
                ? Effect.fail(
                    new AdaptiveProcessSupervisor.RpcError({
                      code: "MODEL",
                      message: "Adaptive bootstrap requested more than one model turn",
                    }),
                  )
                : Deferred.await(manifest).pipe(
                    Effect.map((record) =>
                      gateway
                        .stream({
                          taskID: identity.taskID,
                          agentID: identity.agentID,
                          generation: identity.generation,
                          manifestID: record.id,
                          requestID,
                        })
                        .pipe(
                          Stream.mapEffect((event) =>
                            Effect.try({
                              try: () => eventPayload(event),
                              catch: () =>
                                new AdaptiveProcessSupervisor.RpcError({
                                  code: "MODEL",
                                  message: "Adaptive model event encoding failed",
                                }),
                            }).pipe(
                              Effect.tapError(() =>
                                Effect.logWarning("adaptive model event encoding failed", { type: event.type }),
                              ),
                            ),
                          ),
                          Stream.mapError(
                            () =>
                              new AdaptiveProcessSupervisor.RpcError({
                                code: "MODEL",
                                message: "Adaptive model request failed",
                              }),
                          ),
                        ),
                    ),
                  ),
            ),
          )
        },
      })
      .pipe(Effect.mapError(() => new BootstrapError({ stage: "process" })))

    const completed = yield* Effect.raceFirst(
      Deferred.await(completion),
      handle.exited.pipe(
        Effect.catch(() => Effect.succeed(-1)),
        Effect.flatMap((exitCode) =>
          Effect.gen(function* () {
            const request = Option.getOrUndefined(yield* store.getModelRequest(requestID).pipe(Effect.option))
            const agent = Option.getOrUndefined(yield* store.getAgent(handle.agentID).pipe(Effect.option))
            const stderr = yield* handle.stderrPreview.pipe(Effect.catch(() => Effect.succeed("")))
            yield* Effect.logWarning("adaptive child exited before bootstrap completion", {
              taskID: task.id,
              agentID: handle.agentID,
              exitCode,
              agentState: agent?.state,
              requestStatus: request?.status,
              requestFailure: request?.failure,
              stderr,
            })
            return yield* new BootstrapError({ stage: "completion" })
          }),
        ),
      ),
    )
    const exitCode = yield* handle.exited.pipe(Effect.mapError(() => new BootstrapError({ stage: "process" })))
    if (exitCode !== 0) return yield* new BootstrapError({ stage: "process" })
    input.emit?.({ type: "adaptive.bootstrap.completed", taskID: task.id, bootstrap: completed.bootstrap })
    return {
      taskID: task.id,
      status: "planning" as const,
      bootstrap: completed.bootstrap,
      agentID: agent.id,
      generation: handle.generation,
      pid: handle.pid,
      requestID,
      modelPolicy,
    }
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
