export * as AdaptiveModelGateway from "./model-gateway"

import { AdaptiveModelAudit } from "@opencode-ai/core/adaptive/model-audit"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Provider } from "@opencode-ai/schema/provider"
import {
  LLM,
  LLMClient,
  LLMEvent,
  Message,
  Model as ResolvedModel,
  ToolDefinition,
  type Usage,
} from "@opencode-ai/llm"
import { Cause, Context, Effect, Exit, Layer, Schema, Scope, Stream } from "effect"
import { Auth } from "@/auth"
import { AdaptiveContextRequest } from "./context/request"
import { AdaptiveModelResolver } from "./model-resolver"

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

export class TaskStateError extends Schema.TaggedErrorClass<TaskStateError>()("AdaptiveModelGateway.TaskState", {
  requestID: AdaptiveTask.RequestID,
  taskID: AdaptiveTask.ID,
  reason: Schema.Literal("Task state invalid"),
}) {}

export class ModelResolutionError extends Schema.TaggedErrorClass<ModelResolutionError>()(
  "AdaptiveModelGateway.ModelResolution",
  {
    requestID: AdaptiveTask.RequestID,
    reason: Schema.Literal("Model resolution failed"),
  },
) {}

export class InvalidManifestContentError extends Schema.TaggedErrorClass<InvalidManifestContentError>()(
  "AdaptiveModelGateway.InvalidManifestContent",
  {
    requestID: AdaptiveTask.RequestID,
    manifestID: AdaptiveTask.ContextManifestID,
    reason: Schema.Literals(["Manifest unavailable", "Manifest content invalid"]),
  },
) {}

export class ProviderStreamError extends Schema.TaggedErrorClass<ProviderStreamError>()(
  "AdaptiveModelGateway.ProviderStream",
  {
    requestID: AdaptiveTask.RequestID,
    reason: Schema.Literal("Provider stream failed"),
  },
) {}

export class SettlementError extends Schema.TaggedErrorClass<SettlementError>()("AdaptiveModelGateway.Settlement", {
  requestID: AdaptiveTask.RequestID,
  reason: Schema.Literal("Model request settlement failed"),
}) {}

export type Error =
  | AdaptiveStore.TaskNotFoundError
  | AdaptiveModelAudit.AdmissionError
  | AdaptiveModelAudit.RequestNotFoundError
  | AdaptiveModelAudit.InvalidTransitionError
  | TaskStateError
  | ModelResolutionError
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
  finished: boolean
}

const validTokenCount = (value: number | undefined) =>
  value !== undefined && value >= 0 && Number.isSafeInteger(value) ? value : undefined

const observeRawEvent = (state: RequestState, event: LLMEvent) => {
  if ("usage" in event && event.usage !== undefined) {
    const inputTokens = validTokenCount(event.usage.inputTokens)
    const outputTokens = validTokenCount(event.usage.outputTokens)
    if (inputTokens !== undefined) state.inputTokens = inputTokens
    if (outputTokens !== undefined) state.outputTokens = outputTokens
  }
  if (LLMEvent.is.providerError(event)) state.providerError = true
  if (LLMEvent.is.finish(event)) state.finished = true
}

const sanitizeUsage = (usage: Usage | undefined) =>
  usage === undefined
    ? undefined
    : {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        nonCachedInputTokens: usage.nonCachedInputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
      }

const sanitizeEvent = (event: LLMEvent): LLMEvent => {
  switch (event.type) {
    case "step-start":
      return LLMEvent.stepStart({ index: event.index })
    case "text-start":
      return LLMEvent.textStart({ id: event.id })
    case "text-delta":
      return LLMEvent.textDelta({ id: event.id, text: event.text })
    case "text-end":
      return LLMEvent.textEnd({ id: event.id })
    case "reasoning-start":
      return LLMEvent.reasoningStart({ id: event.id })
    case "reasoning-delta":
      return LLMEvent.reasoningDelta({ id: event.id, text: event.text })
    case "reasoning-end":
      return LLMEvent.reasoningEnd({ id: event.id })
    case "tool-input-start":
      return LLMEvent.toolInputStart({ id: event.id, name: event.name })
    case "tool-input-delta":
      return LLMEvent.toolInputDelta({ id: event.id, name: event.name, text: event.text })
    case "tool-input-end":
      return LLMEvent.toolInputEnd({ id: event.id, name: event.name })
    case "tool-call":
      return LLMEvent.toolCall({
        id: event.id,
        name: event.name,
        input: event.input,
        providerExecuted: event.providerExecuted,
      })
    case "tool-result":
      return LLMEvent.toolResult({
        id: event.id,
        name: event.name,
        result: event.result,
        output: event.output,
        providerExecuted: event.providerExecuted,
      })
    case "tool-error":
      return LLMEvent.toolError({ id: event.id, name: event.name, message: "Tool execution failed" })
    case "step-finish":
      return LLMEvent.stepFinish({ index: event.index, reason: event.reason, usage: sanitizeUsage(event.usage) })
    case "finish":
      return LLMEvent.finish({ reason: event.reason, usage: sanitizeUsage(event.usage) })
    case "provider-error":
      return LLMEvent.providerError({
        message: "Provider returned an error",
        classification: event.classification,
        retryable: event.retryable,
      })
  }
  throw new Error("Unsupported canonical LLM event")
}

const settlement = (state: RequestState, input: StreamInput, exit: Exit.Exit<unknown, unknown>) => {
  const interrupted = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
  const status = state.providerError
    ? "failed"
    : interrupted
      ? "interrupted"
      : Exit.isSuccess(exit) && state.finished
        ? "succeeded"
        : "failed"
  const failure =
    status !== "failed"
      ? undefined
      : state.providerError
        ? "Provider returned an error event"
        : Exit.isSuccess(exit) && state.providerStarted && !state.finished
          ? "Provider stream ended before finish"
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

const taskStateError = (input: StreamInput) =>
  new TaskStateError({ requestID: input.requestID, taskID: input.taskID, reason: "Task state invalid" })

const modelResolutionError = (input: StreamInput) =>
  new ModelResolutionError({ requestID: input.requestID, reason: "Model resolution failed" })

const invalidManifest = (input: StreamInput, reason: InvalidManifestContentError["reason"]) =>
  new InvalidManifestContentError({
    requestID: input.requestID,
    manifestID: input.manifestID,
    reason,
  })

const safeDefects = <A, E, R, E2>(effect: Effect.Effect<A, E, R>, error: E2) =>
  effect.pipe(Effect.catchDefect(() => Effect.fail(error)))

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* AdaptiveStore.Service
    const audit = yield* AdaptiveModelAudit.Service
    const locations = yield* LocationServiceMap.Service
    const llm = yield* LLMClient.Service
    const auth = yield* Auth.Service

    const prepare = (input: StreamInput): Effect.Effect<Stream.Stream<LLMEvent, Error>, Error, Scope.Scope> =>
      Effect.gen(function* () {
        const task = yield* store.getTask(input.taskID).pipe(
          Effect.catchTag("AdaptiveStore.CorruptModelPolicy", () => Effect.fail(taskStateError(input))),
          (effect) => safeDefects(effect, taskStateError(input)),
        )
        const scope = yield* Scope.Scope
        const { admitted, state } = yield* Effect.uninterruptibleMask(() =>
          Effect.gen(function* () {
            const admitted = yield* safeDefects(
              audit.admit({
                ...input,
                modelPolicy: task.modelPolicy,
              }),
              taskStateError(input),
            )
            const state: RequestState = {
              policy: task.modelPolicy,
              providerID: task.modelPolicy.providerID,
              effectiveContextLimit: task.modelPolicy.effectiveContextLimit,
              providerStarted: false,
              providerError: false,
              finished: false,
            }
            yield* Scope.addFinalizerExit(scope, (exit) =>
              Effect.suspend(() => {
                const value = settlement(state, input, exit)
                const safeFailure = () =>
                  Effect.die(
                    new SettlementError({
                      requestID: input.requestID,
                      reason: "Model request settlement failed",
                    }),
                  )
                const attempt = (remaining: number): Effect.Effect<void> =>
                  Effect.gen(function* () {
                    const result = yield* audit.settle(value).pipe(Effect.exit)
                    if (Exit.isSuccess(result)) return undefined
                    if (remaining > 1) {
                      yield* attempt(remaining - 1)
                      return undefined
                    }
                    const recovery = yield* audit.settleFailed(value).pipe(Effect.exit)
                    if (Exit.isFailure(recovery)) {
                      yield* safeFailure()
                      return undefined
                    }
                    yield* safeFailure()
                    return undefined
                  })
                return attempt(3).pipe(Effect.uninterruptible)
              }),
            )
            return { admitted, state }
          }),
        )

        const modelRef: ModelV2.Ref = {
          providerID: task.modelPolicy.providerID,
          id: task.modelPolicy.modelID,
          variant: task.modelPolicy.variant,
        }
        const model = yield* AdaptiveModelResolver.resolveRef({ model: modelRef, auth }).pipe(
          Effect.provide(
            locations.get(
              Location.Ref.make({
                directory: AbsolutePath.make(admitted.directory),
              }),
            ),
          ),
          Effect.mapError(() => modelResolutionError(input)),
          (effect) => safeDefects(effect, modelResolutionError(input)),
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

        const manifest = yield* store.getManifest(input.manifestID).pipe(
          Effect.catchTag("AdaptiveStore.ManifestNotFound", () =>
            Effect.fail(invalidManifest(input, "Manifest unavailable")),
          ),
          Effect.catchTag("AdaptiveStore.InvalidManifest", () =>
            Effect.fail(invalidManifest(input, "Manifest content invalid")),
          ),
          (effect) => safeDefects(effect, invalidManifest(input, "Manifest content invalid")),
        )
        const messages = yield* Schema.decodeUnknownEffect(Schema.Array(Message))(manifest.messages).pipe(
          Effect.mapError(() => invalidManifest(input, "Manifest content invalid")),
          (effect) => safeDefects(effect, invalidManifest(input, "Manifest content invalid")),
        )
        const tools = yield* Schema.decodeUnknownEffect(Schema.Array(ToolDefinition))(manifest.tools).pipe(
          Effect.mapError(() => invalidManifest(input, "Manifest content invalid")),
          (effect) => safeDefects(effect, invalidManifest(input, "Manifest content invalid")),
        )
        const contextRequest = AdaptiveContextRequest.prepare({
          taskID: input.taskID,
          modelPolicy: task.modelPolicy,
          roadmapRevision: manifest.roadmapRevision,
          system: manifest.system,
          messages,
          tools,
        })
        if (
          contextRequest.estimatedTokens !== manifest.estimatedTokens ||
          contextRequest.requestHash !== manifest.requestHash
        )
          return yield* invalidManifest(input, "Manifest content invalid")
        if (contextRequest.estimatedTokens + task.modelPolicy.outputReserve + task.modelPolicy.safetyReserve > state.effectiveContextLimit)
          return yield* new RoutePolicyMismatchError({
            requestID: input.requestID,
            reason: "authoritative Manifest exceeds the effective context budget",
          })
        const request = yield* Effect.try({
          try: () =>
            LLM.request({
              model,
              system: contextRequest.system,
              messages: contextRequest.messages,
              tools: contextRequest.tools,
              providerOptions: contextRequest.providerOptions,
              generation: contextRequest.generation,
            }),
          catch: () => invalidManifest(input, "Manifest content invalid"),
        })

        yield* safeDefects(audit.streaming(input.requestID), taskStateError(input))
        state.providerStarted = true
        const providerStream = yield* Effect.try({
          try: () => llm.stream(request),
          catch: () => publicStreamError(input.requestID),
        })
        return providerStream.pipe(
          Stream.tap((event) => Effect.sync(() => observeRawEvent(state, event))),
          Stream.map(sanitizeEvent),
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
  deps: [AdaptiveStore.node, AdaptiveModelAudit.node, LocationServiceMap.node, llmClient, Auth.node],
})
