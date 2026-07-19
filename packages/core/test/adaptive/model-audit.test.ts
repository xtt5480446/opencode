import { expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AdaptiveModelAudit } from "@opencode-ai/core/adaptive/model-audit"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { AdaptiveModelRequestTable } from "@opencode-ai/core/adaptive/sql"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([AdaptiveModelAudit.node, AdaptiveStore.node, Database.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

const policy = (input?: {
  readonly providerID?: string
  readonly modelID?: string
  readonly effectiveLimit?: number
}) =>
  AdaptiveModelPolicy.create({
    providerID: Provider.ID.make(input?.providerID ?? "openai-compatible"),
    modelID: Model.ID.make(input?.modelID ?? "kimi-k2"),
    variant: Model.VariantID.make("default"),
    effectiveContextLimit: input?.effectiveLimit ?? 262_144,
    outputReserve: 16_384,
    safetyReserve: 8_192,
  })

const setup = (input?: { readonly modelPolicy?: AdaptiveTask.ModelPolicy; readonly owner?: string }) =>
  Effect.gen(function* () {
    const store = yield* AdaptiveStore.Service
    const owner = input?.owner ?? "controller-a"
    const task = yield* store.createTask({
      id: AdaptiveTask.ID.create(),
      directory: "/workspace/project",
      mode: "benchmark",
      status: "running",
      requirement: "Audit one immutable model lineage",
      modelPolicy: input?.modelPolicy ?? policy(),
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
      purpose: "model request",
      system: ["system"],
      messages: [],
      tools: [],
      components: [],
      estimatedTokens: 100,
      requestHash: "sha256:manifest",
    })
    return { task, agent, claimed, manifest, owner }
  })

const admission = (
  state: {
    readonly task: AdaptiveStore.TaskRecord
    readonly agent: AdaptiveStore.AgentRecord
    readonly claimed: AdaptiveStore.AgentRecord
    readonly manifest: AdaptiveStore.ManifestRecord
  },
  requestID = AdaptiveTask.RequestID.create(),
) => ({
  requestID,
  taskID: state.task.id,
  agentID: state.agent.id,
  generation: state.claimed.generation,
  manifestID: state.manifest.id,
  modelPolicy: state.task.modelPolicy,
})

const requestCount = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({ count: sql<number>`count(*)` })
    .from(AdaptiveModelRequestTable)
    .get()
    .pipe(Effect.orDie)
  return row?.count ?? 0
})

const settlement = (
  requestID: AdaptiveTask.RequestID,
  input?: {
    readonly providerID?: string
    readonly modelID?: string
    readonly variant?: string
    readonly effectiveContextLimit?: number
    readonly status?: "succeeded" | "failed" | "interrupted"
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly failure?: string
  },
) => ({
  requestID,
  status: input?.status ?? ("succeeded" as const),
  providerID: Provider.ID.make(input?.providerID ?? "openai-compatible"),
  modelID: Model.ID.make(input?.modelID ?? "kimi-k2"),
  variant: Model.VariantID.make(input?.variant ?? "default"),
  effectiveContextLimit: input?.effectiveContextLimit ?? 262_144,
  ...(input?.inputTokens === undefined ? {} : { inputTokens: input.inputTokens }),
  ...(input?.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
  ...(input?.failure === undefined ? {} : { failure: input.failure }),
})

it.effect("admits only the current Task, claimed Agent, Manifest generation, and exact immutable policy", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1_000)
    const store = yield* AdaptiveStore.Service
    const audit = yield* AdaptiveModelAudit.Service
    const state = yield* setup()
    const input = admission(state)

    const missing = yield* audit
      .admit({ ...input, taskID: AdaptiveTask.ID.create(), requestID: AdaptiveTask.RequestID.create() })
      .pipe(Effect.flip)
    expect(missing._tag).toBe("AdaptiveModelAudit.MissingState")
    expect(missing).toMatchObject({ state: "task" })
    expect(yield* requestCount).toBe(0)

    const missingManifest = yield* audit
      .admit({
        ...input,
        manifestID: AdaptiveTask.ContextManifestID.create(),
        requestID: AdaptiveTask.RequestID.create(),
      })
      .pipe(Effect.flip)
    expect(missingManifest).toMatchObject({ _tag: "AdaptiveModelAudit.MissingState", state: "manifest" })
    expect(yield* requestCount).toBe(0)

    const stale = yield* audit
      .admit({ ...input, generation: 0, requestID: AdaptiveTask.RequestID.create() })
      .pipe(Effect.flip)
    expect(stale._tag).toBe("AdaptiveModelAudit.StaleGeneration")
    expect(yield* requestCount).toBe(0)

    const unclaimed = yield* store.createAgent({
      id: AdaptiveTask.AgentID.create(),
      taskID: state.task.id,
      role: "validator",
    })
    const notClaimed = yield* audit
      .admit({ ...input, agentID: unclaimed.id, generation: 0, requestID: AdaptiveTask.RequestID.create() })
      .pipe(Effect.flip)
    expect(notClaimed._tag).toBe("AdaptiveModelAudit.AgentNotClaimed")
    expect(yield* requestCount).toBe(0)

    const other = yield* setup({ owner: "controller-b" })
    const wrongTask = yield* audit
      .admit({
        ...input,
        agentID: other.agent.id,
        generation: other.claimed.generation,
        manifestID: other.manifest.id,
        requestID: AdaptiveTask.RequestID.create(),
      })
      .pipe(Effect.flip)
    expect(wrongTask._tag).toBe("AdaptiveModelAudit.AgentTaskMismatch")
    expect(yield* requestCount).toBe(0)

    const manifestOwner = yield* audit
      .admit({ ...input, manifestID: other.manifest.id, requestID: AdaptiveTask.RequestID.create() })
      .pipe(Effect.flip)
    expect(manifestOwner._tag).toBe("AdaptiveModelAudit.ManifestMismatch")
    expect(manifestOwner).toMatchObject({ reason: "owner" })
    expect(yield* requestCount).toBe(0)

    const wrongHash = AdaptiveTask.ModelPolicy.make({
      ...state.task.modelPolicy,
      hash: `sha256:${"b".repeat(64)}`,
    })
    const hashMismatch = yield* audit
      .admit({ ...input, modelPolicy: wrongHash, requestID: AdaptiveTask.RequestID.create() })
      .pipe(Effect.flip)
    expect(hashMismatch._tag).toBe("AdaptiveModelAudit.PolicyMismatch")
    expect(hashMismatch).toMatchObject({ reason: "immutable policy" })
    expect(yield* requestCount).toBe(0)

    const limitMismatch = yield* audit
      .admit({
        ...input,
        modelPolicy: policy({ effectiveLimit: state.task.modelPolicy.effectiveContextLimit - 1 }),
        requestID: AdaptiveTask.RequestID.create(),
      })
      .pipe(Effect.flip)
    expect(limitMismatch._tag).toBe("AdaptiveModelAudit.PolicyMismatch")
    expect(limitMismatch).toMatchObject({ reason: "effective context limit" })
    expect(yield* requestCount).toBe(0)

    yield* TestClock.setTime(61_000)
    const reclaimed = yield* store.claimAgent({
      agentID: state.agent.id,
      expectedGeneration: state.claimed.generation,
      owner: "controller-c",
      pid: 202,
      leaseDurationMs: 60_000,
    })
    const manifestGeneration = yield* audit
      .admit({
        ...input,
        generation: reclaimed.generation,
        requestID: AdaptiveTask.RequestID.create(),
      })
      .pipe(Effect.flip)
    expect(manifestGeneration._tag).toBe("AdaptiveModelAudit.ManifestMismatch")
    expect(manifestGeneration).toMatchObject({ reason: "generation" })
    expect(yield* requestCount).toBe(0)
  }),
)

it.effect("persists exact retry lineage and rejects retries across Task or policy before insert", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(2_000)
    const audit = yield* AdaptiveModelAudit.Service
    const store = yield* AdaptiveStore.Service
    const state = yield* setup()
    const first = admission(state)
    yield* audit.admit(first)
    const duplicate = yield* audit.admit(first).pipe(Effect.flip)
    expect(duplicate._tag).toBe("AdaptiveModelAudit.DuplicateRequest")
    expect(yield* requestCount).toBe(1)
    const second = admission(state)
    yield* audit.admit({ ...second, retryOf: first.requestID })
    expect((yield* store.getModelRequest(second.requestID)).retryOf).toBe(first.requestID)

    const other = yield* setup()
    const beforeCrossTask = yield* requestCount
    const crossTask = admission(other)
    const taskFailure = yield* audit.admit({ ...crossTask, retryOf: first.requestID }).pipe(Effect.flip)
    expect(taskFailure._tag).toBe("AdaptiveModelAudit.InvalidRetryLineage")
    expect(taskFailure).toMatchObject({ reason: "task" })
    expect(yield* requestCount).toBe(beforeCrossTask)

    const foreignPolicyParent = AdaptiveTask.RequestID.create()
    yield* store.insertModelRequest({
      id: foreignPolicyParent,
      taskID: state.task.id,
      agentID: state.agent.id,
      generation: state.claimed.generation,
      manifestID: state.manifest.id,
      modelPolicy: policy({ modelID: "qwen3" }),
    })
    const beforeCrossPolicy = yield* requestCount
    const policyFailure = yield* audit.admit({ ...admission(state), retryOf: foreignPolicyParent }).pipe(Effect.flip)
    expect(policyFailure._tag).toBe("AdaptiveModelAudit.InvalidRetryLineage")
    expect(policyFailure).toMatchObject({ reason: "policy" })
    expect(yield* requestCount).toBe(beforeCrossPolicy)
  }),
)

it.effect("returns deterministic model-mixing evidence for different settled resolved identities", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(3_000)
    const audit = yield* AdaptiveModelAudit.Service
    const state = yield* setup()
    const first = admission(state)
    const second = admission(state)
    yield* audit.admit(first)
    yield* audit.admit(second)
    yield* audit.settle(settlement(first.requestID))
    yield* audit.settle(
      settlement(second.requestID, {
        providerID: "anthropic",
        modelID: "claude-sonnet",
      }),
    )

    expect(yield* audit.verify(state.task.id)).toEqual({
      valid: false,
      code: "INVALID_MODEL_MIXING",
      reasons: ["MULTIPLE_MODEL_IDENTITIES:anthropic/claude-sonnet,openai-compatible/kimi-k2"],
      requests: 2,
    })
  }),
)

it.effect("identifies every admitted or streaming request as unsettled", () =>
  Effect.gen(function* () {
    const audit = yield* AdaptiveModelAudit.Service
    const state = yield* setup()
    const input = admission(state)
    yield* audit.admit(input)

    expect(yield* audit.verify(state.task.id)).toEqual({
      valid: false,
      code: "INVALID_MODEL_MIXING",
      reasons: [`UNSETTLED_MODEL_REQUEST:${input.requestID}`],
      requests: 1,
    })

    yield* audit.streaming(input.requestID)
    expect(yield* audit.verify(state.task.id)).toEqual({
      valid: false,
      code: "INVALID_MODEL_MIXING",
      reasons: [`UNSETTLED_MODEL_REQUEST:${input.requestID}`],
      requests: 1,
    })
  }),
)

it.effect("rejects zero requests, context limit drift, and multiple policy hashes", () =>
  Effect.gen(function* () {
    const audit = yield* AdaptiveModelAudit.Service
    const state = yield* setup()
    expect(yield* audit.verify(state.task.id)).toEqual({
      valid: false,
      code: "INVALID_MODEL_MIXING",
      reasons: ["NO_MODEL_REQUEST"],
      requests: 0,
    })

    const overLimit = admission(state)
    yield* audit.admit(overLimit)
    yield* audit.settle(
      settlement(overLimit.requestID, {
        effectiveContextLimit: state.task.modelPolicy.effectiveContextLimit + 1,
      }),
    )
    expect(yield* audit.verify(state.task.id)).toMatchObject({
      reasons: [`CONTEXT_LIMIT_EXCEEDS_TASK_POLICY:${overLimit.requestID}:262145>262144`],
    })

    const second = admission(state)
    yield* audit.admit(second)
    yield* audit.settle(settlement(second.requestID))
    const { db } = yield* Database.Service
    yield* db
      .update(AdaptiveModelRequestTable)
      .set({ model_policy_hash: `sha256:${"b".repeat(64)}` })
      .where(eq(AdaptiveModelRequestTable.id, second.requestID))
      .run()
      .pipe(Effect.orDie)
    expect(yield* audit.verify(state.task.id)).toMatchObject({
      reasons: [
        `MULTIPLE_POLICY_HASHES:${[state.task.modelPolicy.hash, `sha256:${"b".repeat(64)}`].toSorted().join(",")}`,
        `CONTEXT_LIMIT_EXCEEDS_TASK_POLICY:${overLimit.requestID}:262145>262144`,
      ],
    })
  }),
)

it.effect("invalidates a resolved variant that differs from the Task policy", () =>
  Effect.gen(function* () {
    const audit = yield* AdaptiveModelAudit.Service
    const state = yield* setup()
    const input = admission(state)
    yield* audit.admit(input)
    yield* audit.settle(settlement(input.requestID, { variant: "high" }))

    expect(yield* audit.verify(state.task.id)).toEqual({
      valid: false,
      code: "INVALID_MODEL_MIXING",
      reasons: [`MODEL_VARIANT_MISMATCH:${input.requestID}:high!=default`],
      requests: 1,
    })
  }),
)

it.effect("verifies a settled one-model retry lineage with exact identity, policy, and count", () =>
  Effect.gen(function* () {
    const audit = yield* AdaptiveModelAudit.Service
    const state = yield* setup()
    const first = admission(state)
    const second = admission(state)
    yield* audit.admit(first)
    yield* audit.admit({ ...second, retryOf: first.requestID })
    yield* audit.settle(settlement(first.requestID, { status: "failed", failure: "retryable" }))
    yield* audit.streaming(second.requestID)
    yield* audit.settle(settlement(second.requestID, { inputTokens: 80, outputTokens: 20 }))

    expect(yield* audit.verify(state.task.id)).toEqual({
      valid: true,
      providerID: state.task.modelPolicy.providerID,
      modelID: state.task.modelPolicy.modelID,
      policyHash: state.task.modelPolicy.hash,
      requests: 2,
    })
  }),
)

it.effect("durably enforces admitted to streaming to every terminal path", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(5_000)
    const audit = yield* AdaptiveModelAudit.Service
    const store = yield* AdaptiveStore.Service
    const state = yield* setup()

    for (const [index, status] of (["succeeded", "failed", "interrupted"] as const).entries()) {
      const input = admission(state)
      yield* audit.admit(input)
      expect((yield* store.getModelRequest(input.requestID)).status).toBe("admitted")
      yield* audit.streaming(input.requestID)
      expect((yield* store.getModelRequest(input.requestID)).status).toBe("streaming")
      yield* TestClock.adjust(1)
      yield* audit.settle(
        settlement(input.requestID, {
          status,
          inputTokens: 10,
          outputTokens: 5,
          ...(status === "succeeded" ? {} : { failure: `${status} summary` }),
        }),
      )
      expect(yield* store.getModelRequest(input.requestID)).toMatchObject({
        status,
        inputTokens: 10,
        outputTokens: 5,
        timeCompleted: 5_001 + index,
      })
    }

    const missing = AdaptiveTask.RequestID.create()
    expect((yield* audit.streaming(missing).pipe(Effect.flip))._tag).toBe("AdaptiveModelAudit.RequestNotFound")
    expect((yield* audit.settle(settlement(missing)).pipe(Effect.flip))._tag).toBe("AdaptiveModelAudit.RequestNotFound")

    const terminal = admission(state)
    yield* audit.admit(terminal)
    yield* audit.settle(settlement(terminal.requestID))
    expect((yield* audit.streaming(terminal.requestID).pipe(Effect.flip))._tag).toBe(
      "AdaptiveModelAudit.InvalidTransition",
    )
    expect((yield* audit.settle(settlement(terminal.requestID)).pipe(Effect.flip))._tag).toBe(
      "AdaptiveModelAudit.InvalidTransition",
    )

    const alreadyStreaming = admission(state)
    yield* audit.admit(alreadyStreaming)
    yield* audit.streaming(alreadyStreaming.requestID)
    expect((yield* audit.streaming(alreadyStreaming.requestID).pipe(Effect.flip))._tag).toBe(
      "AdaptiveModelAudit.InvalidTransition",
    )
  }),
)
