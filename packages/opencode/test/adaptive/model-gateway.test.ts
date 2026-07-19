import { beforeEach, describe, expect } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model as LLMModel,
  TransportReason,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { AdaptiveModelAudit } from "@opencode-ai/core/adaptive/model-audit"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { AdaptiveContextManifestTable } from "@opencode-ai/core/adaptive/sql"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { Integration } from "@opencode-ai/core/integration"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { eq, sql } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer, LayerMap, Stream } from "effect"
import { AdaptiveModelGateway } from "@/adaptive/model-gateway"
import { testEffect } from "../lib/effect"

const requests: LLMRequest[] = []
const refs: Array<{ readonly directory: string; readonly input: SessionRunnerModel.RefInput }> = []
let responses: Array<Stream.Stream<LLMEvent, LLMError>> = []
let resolverFailure: "authorization" | "defect" | "none" = "none"
let admitPause: Deferred.Deferred<void> | undefined
let admitReturned: Deferred.Deferred<void> | undefined

const resolvedModel = () =>
  LLMModel.make({
    // Catalog identity is `kimi-catalog`; this is the provider wire model ID.
    id: "kimi-wire-api",
    provider: "trusted-provider",
    route: OpenAIChat.route.with({ limits: { context: 300_000, output: 16_384 } }),
  })
let currentModel = resolvedModel()

const modelResolver = (directory: string) =>
  Layer.succeed(
    SessionRunnerModel.Service,
    SessionRunnerModel.Service.of({
      resolve: () => Effect.die("unused"),
      resolveRef: (input) =>
        Effect.sync(() => refs.push({ directory, input })).pipe(
          Effect.andThen(
            resolverFailure === "authorization"
              ? Effect.fail(new Integration.AuthorizationError({ cause: new Error("resolver-secret") }))
              : resolverFailure === "defect"
                ? Effect.die(new Error("resolver-secret"))
                : Effect.succeed(currentModel),
          ),
        ),
    }),
  )

const locationMap: Layer.Layer<LocationServiceMap.Service> = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make((ref: Location.Ref) => modelResolver(ref.directory)).pipe(
    // The production map provides every Location service; this focused fixture replaces only the resolver used here.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    Effect.map((map) => map as unknown as LayerMap.LayerMap<Location.Ref, LocationServices>),
  ),
)

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      return responses.shift() ?? Stream.empty
    }) as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

const database = Database.layerFromPath(":memory:")
const realAudit = AppNodeBuilder.build(AdaptiveModelAudit.node, [[Database.node, database]])

const wrappedAudit = Layer.effect(
  AdaptiveModelAudit.Service,
  Effect.gen(function* () {
    const base = yield* AdaptiveModelAudit.Service
    return AdaptiveModelAudit.Service.of({
      ...base,
      admit: (input) =>
        base
          .admit(input)
          .pipe(
            Effect.tap(() =>
              admitPause === undefined || admitReturned === undefined
                ? Effect.void
                : Deferred.succeed(admitReturned, undefined).pipe(Effect.andThen(Deferred.await(admitPause))),
            ),
          ),
    })
  }),
).pipe(Layer.provide(realAudit))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([AdaptiveModelGateway.node, AdaptiveModelAudit.node, AdaptiveStore.node, Database.node]),
    [
      [Database.node, database],
      [AdaptiveModelAudit.node, wrappedAudit],
      [LocationServiceMap.node, locationMap],
      [LayerNodePlatform.llmClient, client],
    ],
  ),
)

const policy = () =>
  AdaptiveModelPolicy.create({
    providerID: Provider.ID.make("trusted-provider"),
    modelID: Model.ID.make("kimi-catalog"),
    variant: Model.VariantID.make("high"),
    effectiveContextLimit: 262_144,
    outputReserve: 16_384,
    safetyReserve: 8_192,
  })

const seed = Effect.gen(function* () {
  const store = yield* AdaptiveStore.Service
  const owner = "controller-a"
  const task = yield* store.createTask({
    id: AdaptiveTask.ID.create(),
    directory: "/workspace/authoritative",
    mode: "benchmark",
    status: "running",
    requirement: "Use only durable context",
    modelPolicy: policy(),
    roadmapRevision: 0,
    baseSnapshotHash: "git:0123456789abcdef",
  })
  const agent = yield* store.createAgent({
    id: AdaptiveTask.AgentID.create(),
    taskID: task.id,
    role: "implementation",
  })
  const claimed = yield* store.claimAgent({
    agentID: agent.id,
    expectedGeneration: 0,
    owner,
    pid: 101,
    leaseDurationMs: 60_000,
  })
  const manifest = yield* store.putManifest({
    id: AdaptiveTask.ContextManifestID.create(),
    taskID: task.id,
    agentID: agent.id,
    generation: claimed.generation,
    owner,
    purpose: "authoritative model request",
    system: ["authoritative system"],
    messages: [{ role: "user", content: [{ type: "text", text: "authoritative text" }] }],
    tools: [
      {
        name: "inspect",
        description: "Inspect authoritative state",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ],
    components: [],
    estimatedTokens: 100,
    requestHash: "sha256:authoritative",
  })
  return { store, task, agent, claimed, manifest }
})

const input = (
  state: Effect.Success<typeof seed>,
  requestID = AdaptiveTask.RequestID.create(),
): AdaptiveModelGateway.StreamInput => ({
  taskID: state.task.id,
  agentID: state.agent.id,
  generation: state.claimed.generation,
  manifestID: state.manifest.id,
  requestID,
})

const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "token=provider-secret upstream unavailable" }),
  })

beforeEach(() => {
  requests.length = 0
  refs.length = 0
  responses = []
  currentModel = resolvedModel()
  resolverFailure = "none"
  admitPause = undefined
  admitReturned = undefined
})

describe("AdaptiveModelGateway", () => {
  it.live("uses only stored model identity and Manifest context for one canonical stream", () =>
    Effect.gen(function* () {
      const state = yield* seed
      const gateway = yield* AdaptiveModelGateway.Service
      const terminal = LLMEvent.finish({ reason: "stop", usage: { inputTokens: 19, outputTokens: 7 } })
      responses.push(Stream.make(terminal))

      const untrusted = {
        ...input(state),
        providerID: "attacker-provider",
        modelID: "attacker-model",
        text: "untrusted text",
      } as AdaptiveModelGateway.StreamInput
      const events = Array.from(yield* Stream.runCollect(gateway.stream(untrusted)))

      expect(events).toHaveLength(1)
      expect(events[0]).toBe(terminal)
      expect(requests).toHaveLength(1)
      expect(refs).toHaveLength(1)
      expect(refs[0]?.directory).toBe("/workspace/authoritative")
      expect(refs[0]?.input.model).toEqual({
        providerID: Provider.ID.make("trusted-provider"),
        id: Model.ID.make("kimi-catalog"),
        variant: Model.VariantID.make("high"),
      })
      expect(requests[0]).toMatchObject({
        model: { provider: "trusted-provider", id: "kimi-wire-api" },
        system: [{ type: "text", text: "authoritative system" }],
        messages: [{ role: "user", content: [{ type: "text", text: "authoritative text" }] }],
        tools: [{ name: "inspect", description: "Inspect authoritative state" }],
        generation: { maxTokens: 16_384 },
      })
      expect(JSON.stringify(requests[0])).not.toContain("attacker")
      expect(JSON.stringify(requests[0])).not.toContain("untrusted text")

      const row = yield* state.store.getModelRequest(untrusted.requestID)
      expect(row).toMatchObject({
        status: "succeeded",
        inputTokens: 19,
        outputTokens: 7,
        resolved: {
          providerID: "trusted-provider",
          modelID: "kimi-catalog",
          variant: "high",
          effectiveContextLimit: 262_144,
        },
      })
      expect(yield* (yield* AdaptiveModelAudit.Service).verify(state.task.id)).toMatchObject({
        valid: true,
        providerID: "trusted-provider",
        modelID: "kimi-catalog",
        policyHash: state.task.modelPolicy.hash,
        requests: 1,
      })
    }),
  )

  it.live("rejects a stale generation before the provider is called", () =>
    Effect.gen(function* () {
      const state = yield* seed
      const request = { ...input(state), generation: state.claimed.generation - 1 }
      const failure = yield* Stream.runDrain((yield* AdaptiveModelGateway.Service).stream(request)).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "AdaptiveModelAudit.StaleGeneration",
        requestedGeneration: 0,
        actualGeneration: 1,
      })
      expect(requests).toHaveLength(0)
      expect(refs).toHaveLength(0)
      expect(yield* state.store.getModelRequest(request.requestID).pipe(Effect.flip)).toMatchObject({
        _tag: "AdaptiveStore.RequestNotFound",
      })
    }),
  )

  it.live("settles interruption with the latest partial usage", () =>
    Effect.gen(function* () {
      const state = yield* seed
      const started = yield* Deferred.make<void>()
      const inputUsage = LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: { inputTokens: 13 },
      })
      const outputUsage = LLMEvent.stepFinish({
        index: 1,
        reason: "stop",
        usage: { outputTokens: 5 },
      })
      responses.push(
        Stream.concat(
          Stream.make(inputUsage, outputUsage),
          Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(Stream.flatMap(() => Stream.never)),
        ),
      )
      const request = input(state)
      const run = yield* Stream.runDrain((yield* AdaptiveModelGateway.Service).stream(request)).pipe(
        Effect.forkChild({ startImmediately: true }),
      )

      yield* Deferred.await(started)
      yield* Fiber.interrupt(run)

      expect(requests).toHaveLength(1)
      expect(yield* state.store.getModelRequest(request.requestID)).toMatchObject({
        status: "interrupted",
        inputTokens: 13,
        outputTokens: 5,
        timeCompleted: expect.any(Number),
      })
    }),
  )

  it.live("keeps exact retry lineage after a failed provider stream", () =>
    Effect.gen(function* () {
      const state = yield* seed
      const gateway = yield* AdaptiveModelGateway.Service
      const firstID = AdaptiveTask.RequestID.create()
      responses.push(Stream.fail(providerUnavailable()))
      const firstFailure = yield* Stream.runDrain(gateway.stream(input(state, firstID))).pipe(Effect.flip)

      expect(firstFailure).toMatchObject({
        _tag: "AdaptiveModelGateway.ProviderStream",
        requestID: firstID,
        reason: "Provider stream failed",
      })
      expect(JSON.stringify(firstFailure)).not.toContain("provider-secret")
      const first = yield* state.store.getModelRequest(firstID)
      expect(first.status).toBe("failed")
      expect(first.failure).toBe("Provider stream failed")
      expect(first.failure).not.toContain("provider-secret")

      const retryID = AdaptiveTask.RequestID.create()
      responses.push(Stream.make(LLMEvent.finish({ reason: "stop", usage: { inputTokens: 8, outputTokens: 2 } })))
      yield* Stream.runDrain(gateway.stream({ ...input(state, retryID), retryOf: firstID }))

      const retry = yield* state.store.getModelRequest(retryID)
      expect(retry).toMatchObject({ status: "succeeded", retryOf: firstID })
      expect([first, retry].map((row) => row.modelPolicy.hash)).toEqual([
        state.task.modelPolicy.hash,
        state.task.modelPolicy.hash,
      ])
      expect(refs.map((item) => item.input)).toEqual([refs[0]?.input, refs[0]?.input])
      expect(requests.map((request) => [String(request.model.provider), String(request.model.id)])).toEqual([
        ["trusted-provider", "kimi-wire-api"],
        ["trusted-provider", "kimi-wire-api"],
      ])
    }),
  )

  it.live("settles a provider-error event with a redacted terminal failure", () =>
    Effect.gen(function* () {
      const state = yield* seed
      const request = input(state)
      const providerError = LLMEvent.providerError({
        message: "api_key=provider-secret request rejected",
        retryable: false,
      })
      responses.push(Stream.make(providerError))

      const events = Array.from(yield* Stream.runCollect((yield* AdaptiveModelGateway.Service).stream(request)))

      expect(events[0]).toBe(providerError)
      expect(yield* state.store.getModelRequest(request.requestID)).toMatchObject({
        status: "failed",
        failure: "Provider returned an error event",
        timeCompleted: expect.any(Number),
      })
      expect((yield* state.store.getModelRequest(request.requestID)).failure).not.toContain("provider-secret")
    }),
  )

  it.live("fails closed on a resolved provider mismatch without calling the LLM", () =>
    Effect.gen(function* () {
      const state = yield* seed
      currentModel = LLMModel.make({
        id: "kimi-wire-api",
        provider: "wrong-provider",
        route: OpenAIChat.route.with({ limits: { context: 262_144, output: 16_384 } }),
      })
      const request = input(state)

      const failure = yield* Stream.runDrain((yield* AdaptiveModelGateway.Service).stream(request)).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "AdaptiveModelGateway.RoutePolicyMismatch",
        requestID: request.requestID,
      })
      expect(requests).toHaveLength(0)
      expect(yield* state.store.getModelRequest(request.requestID)).toMatchObject({
        status: "failed",
        failure: "Model gateway rejected request before provider execution",
        resolved: { providerID: "wrong-provider" },
        timeCompleted: expect.any(Number),
      })
    }),
  )

  it.live("fails closed when the resolved context limit cannot satisfy pinned reserves", () =>
    Effect.gen(function* () {
      const state = yield* seed
      currentModel = LLMModel.make({
        id: "kimi-wire-api",
        provider: "trusted-provider",
        route: OpenAIChat.route.with({ limits: { context: 20_000, output: 16_384 } }),
      })
      const request = input(state)

      const failure = yield* Stream.runDrain((yield* AdaptiveModelGateway.Service).stream(request)).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "AdaptiveModelGateway.RoutePolicyMismatch",
        requestID: request.requestID,
      })
      expect(requests).toHaveLength(0)
      expect(yield* state.store.getModelRequest(request.requestID)).toMatchObject({
        status: "failed",
        resolved: { effectiveContextLimit: 20_000 },
        timeCompleted: expect.any(Number),
      })
    }),
  )

  it.live("records a lower valid route limit without exceeding the pinned policy", () =>
    Effect.gen(function* () {
      const state = yield* seed
      currentModel = LLMModel.make({
        id: "kimi-wire-api",
        provider: "trusted-provider",
        route: OpenAIChat.route.with({ limits: { context: 131_072, output: 16_384 } }),
      })
      const request = input(state)
      responses.push(Stream.make(LLMEvent.finish({ reason: "stop" })))

      yield* Stream.runDrain((yield* AdaptiveModelGateway.Service).stream(request))

      expect(requests).toHaveLength(1)
      expect(yield* state.store.getModelRequest(request.requestID)).toMatchObject({
        status: "succeeded",
        resolved: { effectiveContextLimit: 131_072 },
      })
    }),
  )

  it.live("maps resolver defects to a safe typed error and settles the audit row", () =>
    Effect.gen(function* () {
      const state = yield* seed
      resolverFailure = "defect"
      const request = input(state)

      const failure = yield* Stream.runDrain((yield* AdaptiveModelGateway.Service).stream(request)).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "AdaptiveModelGateway.ModelResolution",
        requestID: request.requestID,
        reason: "Model resolution failed",
      })
      expect(JSON.stringify(failure)).not.toContain("resolver-secret")
      expect(requests).toHaveLength(0)
      expect(yield* state.store.getModelRequest(request.requestID)).toMatchObject({
        status: "failed",
        failure: "Model gateway rejected request before provider execution",
        timeCompleted: expect.any(Number),
      })
    }),
  )

  it.live("maps resolver authorization causes to the same safe typed error", () =>
    Effect.gen(function* () {
      const state = yield* seed
      resolverFailure = "authorization"
      const request = input(state)

      const failure = yield* Stream.runDrain((yield* AdaptiveModelGateway.Service).stream(request)).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "AdaptiveModelGateway.ModelResolution",
        requestID: request.requestID,
        reason: "Model resolution failed",
      })
      expect(JSON.stringify(failure)).not.toContain("resolver-secret")
      expect(requests).toHaveLength(0)
      expect(yield* state.store.getModelRequest(request.requestID)).toMatchObject({
        status: "failed",
        timeCompleted: expect.any(Number),
      })
    }),
  )

  it.live("maps malformed authoritative Manifest content to a safe typed error", () =>
    Effect.gen(function* () {
      const state = yield* seed
      const database = yield* Database.Service
      yield* database.db
        .update(AdaptiveContextManifestTable)
        .set({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "manifest-secret" },
                { type: "invalid", text: "manifest-secret" },
              ],
            },
          ],
        })
        .where(eq(AdaptiveContextManifestTable.id, state.manifest.id))
        .run()
        .pipe(Effect.orDie)
      const request = input(state)

      const failure = yield* Stream.runDrain((yield* AdaptiveModelGateway.Service).stream(request)).pipe(Effect.flip)

      expect(JSON.parse(JSON.stringify(failure))).toMatchObject({
        _tag: "AdaptiveModelGateway.InvalidManifestContent",
        requestID: request.requestID,
        manifestID: state.manifest.id,
        reason: "Manifest content invalid",
      })
      expect(JSON.stringify(failure)).not.toContain("manifest-secret")
      expect(requests).toHaveLength(0)
      expect(yield* state.store.getModelRequest(request.requestID)).toMatchObject({
        status: "failed",
        failure: "Model gateway rejected request before provider execution",
        timeCompleted: expect.any(Number),
      })
    }),
  )

  it.live("maps corrupt persisted Manifest JSON to the same safe typed error", () =>
    Effect.gen(function* () {
      const state = yield* seed
      const database = yield* Database.Service
      yield* database.db
        .update(AdaptiveContextManifestTable)
        .set({ messages: sql`${"manifest-secret"}` })
        .where(eq(AdaptiveContextManifestTable.id, state.manifest.id))
        .run()
        .pipe(Effect.orDie)
      const request = input(state)

      const failure = yield* Stream.runDrain((yield* AdaptiveModelGateway.Service).stream(request)).pipe(Effect.flip)

      expect(JSON.parse(JSON.stringify(failure))).toMatchObject({
        _tag: "AdaptiveModelGateway.InvalidManifestContent",
        requestID: request.requestID,
        manifestID: state.manifest.id,
        reason: "Manifest content invalid",
      })
      expect(JSON.stringify(failure)).not.toContain("manifest-secret")
      expect(requests).toHaveLength(0)
      expect(yield* state.store.getModelRequest(request.requestID)).toMatchObject({
        status: "failed",
        timeCompleted: expect.any(Number),
      })
    }),
  )

  it.live("settles after admission when interrupted during the ownership handoff", () =>
    Effect.gen(function* () {
      const state = yield* seed
      admitPause = yield* Deferred.make<void>()
      admitReturned = yield* Deferred.make<void>()
      const request = input(state)
      const run = yield* Stream.runDrain((yield* AdaptiveModelGateway.Service).stream(request)).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Deferred.await(admitReturned)
      yield* Fiber.interrupt(run).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(admitPause, undefined)
      yield* Fiber.await(run)

      const row = yield* state.store.getModelRequest(request.requestID)
      expect(row).toMatchObject({ status: "interrupted", timeCompleted: expect.any(Number) })
    }),
  )
})
