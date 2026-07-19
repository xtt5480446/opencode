export * as AdaptiveModelGateway from "./model-gateway"

import { AdaptiveModelAudit } from "@opencode-ai/core/adaptive/model-audit"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Provider } from "@opencode-ai/schema/provider"
import { LLM, LLMClient, LLMEvent, Message, Model as ResolvedModel, SystemPart, ToolDefinition } from "@opencode-ai/llm"
import { Cause, Context, Effect, Exit, Layer, Schema, Scope, Stream } from "effect"

export interface StreamInput {
  readonly taskID: AdaptiveTask.ID
  readonly agentID: AdaptiveTask.AgentID
  readonly generation: number
  readonly manifestID: AdaptiveTask.ContextManifestID
  readonly requestID: AdaptiveTask.RequestID
  readonly retryOf?: AdaptiveTask.RequestID
}

export class RoutePolicyMismatchError extends Schema.TaggedErrorClass<RoutePolicyMismatchError>()(
  "AdaptiveModelGateway.RoutePolicyMismatch",
  {
    requestID: AdaptiveTask.RequestID,
    reason: Schema.String,
  },
) {}

export class InvalidManifestContentError extends Schema.TaggedErrorClass<InvalidManifestContentError>()(
  "AdaptiveModelGateway.InvalidManifestContent",
  {
    requestID: AdaptiveTask.RequestID,
    manifestID: AdaptiveTask.ContextManifestID,
    reason: Schema.String,
  },
) {}

export class ProviderStreamError extends Schema.TaggedErrorClass<ProviderStreamError>()(
  "AdaptiveModelGateway.ProviderStream",
  {
    requestID: AdaptiveTask.RequestID,
    reason: Schema.Literal("Provider stream failed"),
  },
) {}

export type Error =
  | AdaptiveStore.TaskNotFoundError
  | AdaptiveStore.CorruptModelPolicyError
  | AdaptiveStore.ManifestNotFoundError
  | AdaptiveStore.InvalidManifestError
  | AdaptiveModelAudit.AdmissionError
  | AdaptiveModelAudit.RequestNotFoundError
  | AdaptiveModelAudit.InvalidTransitionError
  | SessionRunnerModel.Error
  | RoutePolicyMismatchError
  | InvalidManifestContentError
  | ProviderStreamError

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AdaptiveModelGateway") {}

interface RequestState {
  readonly policy: AdaptiveTask.ModelPolicy
  providerID: Provider.ID
  effectiveContextLimit: number
  inputTokens?: number
  outputTokens?: number
  providerStarted: boolean
  providerError: boolean
}

const validTokenCount = (value: number | undefined) =>
  value !== undefined && value >= 0 && Number.isSafeInteger(value) ? value : undefined

const updateUsage = (state: RequestState, event: LLMEvent) => {
  if ("usage" in event && event.usage !== undefined) {
    const inputTokens = validTokenCount(event.usage.inputTokens)
    const outputTokens = validTokenCount(event.usage.outputTokens)
    if (inputTokens !== undefined) state.inputTokens = inputTokens
    if (outputTokens !== undefined) state.outputTokens = outputTokens
  }
  if (LLMEvent.is.providerError(event)) state.providerError = true
}

const settlement = (state: RequestState, input: StreamInput, exit: Exit.Exit<unknown, unknown>) => {
  const interrupted = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
  const status = state.providerError
    ? "failed"
    : Exit.isSuccess(exit)
      ? "succeeded"
      : interrupted
        ? "interrupted"
        : "failed"
  const failure =
    status !== "failed"
      ? undefined
      : state.providerError
        ? "Provider returned an error event"
        : state.providerStarted
          ? "Provider stream failed"
          : "Model gateway rejected request before provider execution"
  return {
    requestID: input.requestID,
    status,
    providerID: state.providerID,
    modelID: state.policy.modelID,
    ...(state.policy.variant === undefined ? {} : { variant: state.policy.variant }),
    effectiveContextLimit: state.effectiveContextLimit,
    ...(state.inputTokens === undefined ? {} : { inputTokens: state.inputTokens }),
    ...(state.outputTokens === undefined ? {} : { outputTokens: state.outputTokens }),
    ...(failure === undefined ? {} : { failure }),
  } as const
}

const routeLimit = (model: ResolvedModel) => model.defaults?.limits?.context ?? model.route.defaults.limits?.context

const publicStreamError = (requestID: AdaptiveTask.RequestID) =>
  new ProviderStreamError({ requestID, reason: "Provider stream failed" })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* AdaptiveStore.Service
    const audit = yield* AdaptiveModelAudit.Service
    const locations = yield* LocationServiceMap.Service
    const llm = yield* LLMClient.Service

    const prepare = (input: StreamInput): Effect.Effect<Stream.Stream<LLMEvent, Error>, Error, Scope.Scope> =>
      Effect.gen(function* () {
        const task = yield* store.getTask(input.taskID)
        const admitted = yield* audit.admit({
          ...input,
          modelPolicy: task.modelPolicy,
        })
        const state: RequestState = {
          policy: task.modelPolicy,
          providerID: task.modelPolicy.providerID,
          effectiveContextLimit: task.modelPolicy.effectiveContextLimit,
          providerStarted: false,
          providerError: false,
        }
        const scope = yield* Scope.Scope
        yield* Scope.addFinalizerExit(scope, (exit) =>
          audit.settle(settlement(state, input, exit)).pipe(Effect.uninterruptible, Effect.orDie),
        )

        const manifest = yield* store.getManifest(input.manifestID)
        const modelRef: ModelV2.Ref = {
          providerID: task.modelPolicy.providerID,
          id: task.modelPolicy.modelID,
          variant: task.modelPolicy.variant,
        }
        const model = yield* SessionRunnerModel.Service.use((models) => models.resolveRef({ model: modelRef })).pipe(
          Effect.provide(
            locations.get(
              Location.Ref.make({
                directory: AbsolutePath.make(admitted.directory),
              }),
            ),
          ),
        )

        if (model.provider.length > 0) state.providerID = Provider.ID.make(model.provider)
        if (String(model.provider) !== task.modelPolicy.providerID)
          return yield* new RoutePolicyMismatchError({
            requestID: input.requestID,
            reason: `resolved provider ${model.provider} does not match pinned provider ${task.modelPolicy.providerID}`,
          })

        const contextLimit = routeLimit(model)
        if (contextLimit === undefined || contextLimit <= 0 || !Number.isSafeInteger(contextLimit))
          return yield* new RoutePolicyMismatchError({
            requestID: input.requestID,
            reason: "resolved route has no positive integer context limit",
          })
        state.effectiveContextLimit = Math.min(contextLimit, task.modelPolicy.effectiveContextLimit)
        if (task.modelPolicy.outputReserve + task.modelPolicy.safetyReserve >= state.effectiveContextLimit)
          return yield* new RoutePolicyMismatchError({
            requestID: input.requestID,
            reason: "resolved route context limit cannot satisfy the pinned reserves",
          })
        if (
          manifest.estimatedTokens + task.modelPolicy.outputReserve + task.modelPolicy.safetyReserve >
          state.effectiveContextLimit
        )
          return yield* new RoutePolicyMismatchError({
            requestID: input.requestID,
            reason: "authoritative Manifest exceeds the effective context budget",
          })

        const decodeFailure = (reason: unknown) =>
          new InvalidManifestContentError({
            requestID: input.requestID,
            manifestID: input.manifestID,
            reason: String(reason),
          })
        const messages = yield* Schema.decodeUnknownEffect(Schema.Array(Message))(manifest.messages).pipe(
          Effect.mapError(decodeFailure),
        )
        const tools = yield* Schema.decodeUnknownEffect(Schema.Array(ToolDefinition))(manifest.tools).pipe(
          Effect.mapError(decodeFailure),
        )
        const request = LLM.request({
          model,
          system: manifest.system.map(SystemPart.make),
          messages,
          tools,
          generation: { maxTokens: task.modelPolicy.outputReserve },
        })

        yield* audit.streaming(input.requestID)
        state.providerStarted = true
        return llm.stream(request).pipe(
          Stream.tap((event) => Effect.sync(() => updateUsage(state, event))),
          Stream.catchCause(() => Stream.fail(publicStreamError(input.requestID))),
        )
      })

    const stream: Interface["stream"] = (input) => Stream.unwrap(prepare(input))

    return Service.of({ stream })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [AdaptiveStore.node, AdaptiveModelAudit.node, LocationServiceMap.node, llmClient],
})
