import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "path"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { AdaptiveTaskTable } from "@opencode-ai/core/adaptive/sql"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([AdaptiveStore.node, Database.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

const policy = () =>
  AdaptiveModelPolicy.create({
    providerID: Provider.ID.make("openai-compatible"),
    modelID: Model.ID.make("kimi-k2"),
    variant: Model.VariantID.make("default"),
    effectiveContextLimit: 262_144,
    outputReserve: 16_384,
    safetyReserve: 8_192,
  })

const task = () => ({
  id: AdaptiveTask.ID.create(),
  directory: "/workspace/project",
  mode: "normal" as const,
  status: "planning" as const,
  requirement: "Build the Adaptive Runtime foundation store",
  modelPolicy: policy(),
  roadmapRevision: 0,
  baseSnapshotHash: "git:0123456789abcdef",
})

describe("AdaptiveStore Task", () => {
  it.effect("persists and reads the complete immutable Task foundation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const store = yield* AdaptiveStore.Service
      const input = task()

      const created = yield* store.createTask(input)

      expect(created).toEqual({ ...input, timeCreated: 1_000, timeUpdated: 1_000 })
      expect(yield* store.getTask(input.id)).toEqual(created)
    }),
  )

  it.effect("returns a typed duplicate error without replacing the original Task", () =>
    Effect.gen(function* () {
      const store = yield* AdaptiveStore.Service
      const input = task()
      const created = yield* store.createTask(input)

      const duplicate = yield* store.createTask({ ...input, requirement: "replacement must not win" }).pipe(Effect.flip)

      expect(duplicate._tag).toBe("AdaptiveStore.DuplicateTask")
      expect(yield* store.getTask(input.id)).toEqual(created)
    }),
  )

  it.effect("returns typed not-found and corrupt-policy failures", () =>
    Effect.gen(function* () {
      const store = yield* AdaptiveStore.Service
      const missing = AdaptiveTask.ID.create()
      expect((yield* store.getTask(missing).pipe(Effect.flip))._tag).toBe("AdaptiveStore.TaskNotFound")

      const input = task()
      yield* store.createTask(input)
      const { db } = yield* Database.Service
      yield* db
        .update(AdaptiveTaskTable)
        .set({ model_policy_hash: `sha256:${"b".repeat(64)}` })
        .where(eq(AdaptiveTaskTable.id, input.id))
        .run()
        .pipe(Effect.orDie)

      expect((yield* store.getTask(input.id).pipe(Effect.flip))._tag).toBe("AdaptiveStore.CorruptModelPolicy")
    }),
  )
})

describe("AdaptiveStore Agent ownership", () => {
  it.effect("lists only the task's Agents in stable creation and ID order", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const otherTask = yield* store.createTask({ ...task(), id: AdaptiveTask.ID.create() })
      const ids = [AdaptiveTask.AgentID.create(), AdaptiveTask.AgentID.create()].toSorted()

      yield* store.createAgent({ id: ids[1], taskID: createdTask.id, role: "implementation" })
      yield* store.createAgent({ id: ids[0], taskID: createdTask.id, role: "coordinator" })
      yield* store.createAgent({ id: AdaptiveTask.AgentID.create(), taskID: otherTask.id, role: "validator" })

      expect((yield* store.listAgents(createdTask.id)).map((agent) => agent.id)).toEqual(ids)
    }),
  )

  it.effect("creates one unowned generation-zero Agent and rejects duplicate IDs", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(2_000)
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const input = {
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "coordinator" as const,
      }

      const created = yield* store.createAgent(input)

      expect(created).toEqual({
        ...input,
        generation: 0,
        state: "idle",
        timeCreated: 2_000,
        timeUpdated: 2_000,
      })
      expect(yield* store.getAgent(input.id)).toEqual(created)
      expect((yield* store.createAgent(input).pipe(Effect.flip))._tag).toBe("AdaptiveStore.DuplicateAgent")
      expect((yield* store.getAgent(AdaptiveTask.AgentID.create()).pipe(Effect.flip))._tag).toBe(
        "AdaptiveStore.AgentNotFound",
      )
      expect(
        (yield* store
          .createAgent({
            id: AdaptiveTask.AgentID.create(),
            taskID: AdaptiveTask.ID.create(),
            role: "coordinator",
          })
          .pipe(Effect.flip))._tag,
      ).toBe("AdaptiveStore.TaskNotFound")
    }),
  )

  it.effect("claims once and heartbeats only an unexpired matching owner", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "implementation",
      })
      expect(
        (yield* store
          .claimAgent({
            agentID: agent.id,
            expectedGeneration: 0,
            owner: "",
            pid: 0,
            leaseDurationMs: 0,
          })
          .pipe(Effect.flip))._tag,
      ).toBe("AdaptiveStore.InvalidLease")

      const claimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-a",
        pid: 101,
        leaseDurationMs: 1_000,
      })
      expect(claimed).toMatchObject({
        generation: 1,
        state: "starting",
        owner: "controller-a",
        pid: 101,
        leaseExpiresAt: 2_000,
      })

      yield* TestClock.setTime(1_500)
      const running = yield* store.heartbeat({
        agentID: agent.id,
        generation: 1,
        owner: "controller-a",
        leaseDurationMs: 2_000,
      })
      expect(running).toMatchObject({ state: "running", leaseExpiresAt: 3_500, timeUpdated: 1_500 })

      yield* TestClock.setTime(3_500)
      expect(
        (yield* store
          .heartbeat({
            agentID: agent.id,
            generation: 1,
            owner: "controller-a",
            leaseDurationMs: 1_000,
          })
          .pipe(Effect.flip))._tag,
      ).toBe("AdaptiveStore.AgentOwnershipConflict")
    }),
  )

  it.effect("lets an expired lease advance generation and rejects the stale owner", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "validator",
      })
      yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-a",
        pid: 101,
        leaseDurationMs: 100,
      })

      yield* TestClock.setTime(1_100)
      const reclaimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 1,
        owner: "controller-b",
        pid: 202,
        leaseDurationMs: 500,
      })
      expect(reclaimed).toMatchObject({ generation: 2, owner: "controller-b", pid: 202, leaseExpiresAt: 1_600 })

      expect(
        (yield* store
          .settleAgent({
            agentID: agent.id,
            generation: 1,
            owner: "controller-a",
            state: "lost",
            exitReason: "old owner timed out",
          })
          .pipe(Effect.flip))._tag,
      ).toBe("AdaptiveStore.AgentOwnershipConflict")
    }),
  )

  it.effect("settles after lease expiry when no replacement owns the next generation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "integration",
      })
      yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-a",
        pid: 303,
        leaseDurationMs: 100,
      })

      yield* TestClock.setTime(1_500)
      const settled = yield* store.settleAgent({
        agentID: agent.id,
        generation: 1,
        owner: "controller-a",
        state: "failed",
        exitCode: 2,
        exitReason: "worker exited",
      })

      expect(settled).toEqual({
        ...agent,
        generation: 1,
        state: "failed",
        exitCode: 2,
        exitReason: "worker exited",
        timeUpdated: 1_500,
      })
    }),
  )

  it.effect("quarantines uncertain cleanup without releasing or expiring ownership", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "implementation",
      })
      yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-a",
        pid: 404,
        leaseDurationMs: 100,
      })
      const quarantine = Reflect.get(store, "quarantineAgent") as
        | ((input: {
            agentID: AdaptiveTask.AgentID
            generation: number
            owner: string
            exitCode?: number
            exitReason: string
          }) => Effect.Effect<AdaptiveStore.AgentRecord, unknown>)
        | undefined

      expect(typeof quarantine).toBe("function")
      if (!quarantine) return
      const quarantined = yield* quarantine({
        agentID: agent.id,
        generation: 1,
        owner: "controller-a",
        exitCode: 128,
        exitReason: "process-group cleanup uncertain",
      })
      expect(quarantined).toMatchObject({
        generation: 1,
        state: "failed",
        owner: "controller-a",
        pid: 404,
        exitCode: 128,
        exitReason: "process-group cleanup uncertain",
      })
      expect(quarantined.leaseExpiresAt).toBeUndefined()

      yield* TestClock.setTime(1_000_000)
      expect(
        (yield* store
          .claimAgent({
            agentID: agent.id,
            expectedGeneration: 1,
            owner: "controller-b",
            pid: 405,
            leaseDurationMs: 100,
          })
          .pipe(Effect.flip))._tag,
      ).toBe("AdaptiveStore.AgentClaimConflict")
      expect((yield* store.getAgent(agent.id)).generation).toBe(1)
    }),
  )

  it.effect("allows exactly one concurrent claim for one expected generation", () =>
    Effect.gen(function* () {
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "discovery",
      })

      const results = yield* Effect.all(
        ["controller-a", "controller-b"].map((owner, index) =>
          store
            .claimAgent({
              agentID: agent.id,
              expectedGeneration: 0,
              owner,
              pid: index + 1,
              leaseDurationMs: 1_000,
            })
            .pipe(Effect.exit),
        ),
        { concurrency: "unbounded" },
      )

      expect(results.filter(Exit.isSuccess)).toHaveLength(1)
      expect(results.filter(Exit.isFailure)).toHaveLength(1)
      expect((yield* store.getAgent(agent.id)).generation).toBe(1)
    }),
  )
})

describe("AdaptiveStore Manifest and Request", () => {
  it.effect("stores an immutable ordered JSON Manifest for the active owner", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(4_000)
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "implementation",
      })
      const claimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-a",
        pid: 404,
        leaseDurationMs: 1_000,
      })
      const input = {
        id: AdaptiveTask.ContextManifestID.create(),
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        owner: "controller-a",
        purpose: "Implement the foundation store",
        system: ["system-one", "system-two"],
        messages: [{ role: "user", content: "keep order" }],
        tools: [{ name: "read", enabled: true }],
        components: [{ key: "roadmap", revision: 3 }],
        estimatedTokens: 1_024,
        requestHash: "sha256:manifest",
      }

      const created = yield* store.putManifest(input)

      const { owner: _owner, ...stored } = input
      expect(created).toEqual({ ...stored, timeCreated: 4_000 })
      expect(yield* store.getManifest(input.id)).toEqual(created)
      expect((yield* store.putManifest(input).pipe(Effect.flip))._tag).toBe("AdaptiveStore.DuplicateManifest")
    }),
  )

  it.effect("preserves JSON object keys that overlap JavaScript prototype names", () =>
    Effect.gen(function* () {
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "implementation",
      })
      const claimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-a",
        pid: 405,
        leaseDurationMs: 1_000,
      })
      const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":"keep","prototype":"value"}')
      const manifest = yield* store.putManifest({
        id: AdaptiveTask.ContextManifestID.create(),
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        owner: "controller-a",
        purpose: "Preserve exact JSON keys",
        system: ["system"],
        messages: [payload],
        tools: [],
        components: [],
        estimatedTokens: 100,
        requestHash: "sha256:prototype-keys",
      })

      expect(manifest.messages).toEqual([payload])
      expect(Object.hasOwn(manifest.messages[0] as object, "__proto__")).toBe(true)
      expect(yield* store.getManifest(manifest.id)).toEqual(manifest)
    }),
  )

  it.effect("rejects unsupported Manifest JSON and rolls back ownership mismatch", () =>
    Effect.gen(function* () {
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "discovery",
      })
      const claimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-a",
        pid: 505,
        leaseDurationMs: 1_000,
      })
      const base = {
        id: AdaptiveTask.ContextManifestID.create(),
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        owner: "controller-a",
        purpose: "Discover dependencies",
        system: ["system"],
        messages: [] as unknown[],
        tools: [] as unknown[],
        components: [] as unknown[],
        estimatedTokens: 100,
        requestHash: "sha256:manifest",
      }

      const sparse = Array(1)
      const extraKey = ["value"] as unknown[] & Record<string, unknown>
      extraKey.extra = "not JSON array data"
      const cycle: Record<string, unknown> = {}
      cycle.self = cycle
      const symbolKeyed = { visible: true }
      Object.defineProperty(symbolKeyed, Symbol("hidden"), { value: "not JSON object data", enumerable: true })
      const nonEnumerable = { visible: true }
      Object.defineProperty(nonEnumerable, "hidden", { value: "not serialized" })
      const accessor = {}
      Object.defineProperty(accessor, "computed", { get: () => "not a data property", enumerable: true })
      const invalid = [
        undefined,
        sparse,
        extraKey,
        NaN,
        Infinity,
        1n,
        () => {},
        Symbol("value"),
        new Date(),
        cycle,
        symbolKeyed,
        nonEnumerable,
        accessor,
      ]
      yield* Effect.forEach(invalid, (value) =>
        Effect.gen(function* () {
          const failure = yield* store
            .putManifest({ ...base, id: AdaptiveTask.ContextManifestID.create(), messages: [value] })
            .pipe(Effect.flip)
          expect(failure._tag).toBe("AdaptiveStore.InvalidManifest")
        }),
      )
      const extra = () => {
        const value = ["value"] as unknown[] & Record<string, unknown>
        value.extra = "not JSON array data"
        return value
      }
      const invalidTopLevel = [
        { system: Array(1) as string[] },
        { system: extra() as string[] },
        { messages: Array(1) },
        { messages: extra() },
        { tools: Array(1) },
        { tools: extra() },
        { components: Array(1) },
        { components: extra() },
      ]
      yield* Effect.forEach(invalidTopLevel, (values) =>
        Effect.gen(function* () {
          const failure = yield* store
            .putManifest({ ...base, ...values, id: AdaptiveTask.ContextManifestID.create() })
            .pipe(Effect.flip)
          expect(failure._tag).toBe("AdaptiveStore.InvalidManifest")
        }),
      )
      expect(
        (yield* store
          .putManifest({ ...base, id: AdaptiveTask.ContextManifestID.create(), owner: "wrong" })
          .pipe(Effect.flip))._tag,
      ).toBe("AdaptiveStore.ManifestOwnershipMismatch")
      expect((yield* store.getManifest(base.id).pipe(Effect.flip))._tag).toBe("AdaptiveStore.ManifestNotFound")
    }),
  )

  it.effect("returns typed InvalidManifest when persisted JSON is corrupt", () =>
    Effect.gen(function* () {
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "discovery",
      })
      const claimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-a",
        pid: 506,
        leaseDurationMs: 1_000,
      })
      const manifest = yield* store.putManifest({
        id: AdaptiveTask.ContextManifestID.create(),
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        owner: "controller-a",
        purpose: "Detect corrupt persisted JSON",
        system: ["system"],
        messages: [],
        tools: [],
        components: [],
        estimatedTokens: 100,
        requestHash: "sha256:corrupt-json",
      })
      const { db } = yield* Database.Service
      yield* db
        .run(sql`UPDATE adaptive_context_manifest SET messages = ${"{malformed"} WHERE id = ${manifest.id}`)
        .pipe(Effect.orDie)

      const failure = yield* store.getManifest(manifest.id).pipe(Effect.flip)
      expect(failure._tag).toBe("AdaptiveStore.InvalidManifest")
    }),
  )

  it.effect("inserts one admitted Request snapshot and settles it exactly once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(5_000)
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "validator",
      })
      const claimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-a",
        pid: 606,
        leaseDurationMs: 1_000,
      })
      const manifest = yield* store.putManifest({
        id: AdaptiveTask.ContextManifestID.create(),
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        owner: "controller-a",
        purpose: "Validate request audit",
        system: ["system"],
        messages: [],
        tools: [],
        components: [],
        estimatedTokens: 100,
        requestHash: "sha256:manifest",
      })
      const input = {
        id: AdaptiveTask.RequestID.create(),
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        manifestID: manifest.id,
        modelPolicy: createdTask.modelPolicy,
      }

      const admitted = yield* store.insertModelRequest(input)
      expect(admitted).toEqual({ ...input, status: "admitted", timeCreated: 5_000 })
      expect(yield* store.getModelRequest(input.id)).toEqual(admitted)
      expect((yield* store.insertModelRequest(input).pipe(Effect.flip))._tag).toBe("AdaptiveStore.DuplicateRequest")
      const retry = yield* store.insertModelRequest({
        ...input,
        id: AdaptiveTask.RequestID.create(),
        retryOf: input.id,
      })
      expect(retry.retryOf).toBe(input.id)

      expect(
        (yield* store.settleModelRequest({ requestID: input.id, status: "failed", inputTokens: -1 }).pipe(Effect.flip))
          ._tag,
      ).toBe("AdaptiveStore.InvalidRequest")
      expect((yield* store.getModelRequest(input.id)).status).toBe("admitted")

      yield* TestClock.setTime(5_500)
      const settled = yield* store.settleModelRequest({
        requestID: input.id,
        status: "succeeded",
        inputTokens: 80,
        outputTokens: 20,
      })
      expect(settled).toEqual({
        ...admitted,
        status: "succeeded",
        inputTokens: 80,
        outputTokens: 20,
        timeCompleted: 5_500,
      })
      expect(
        (yield* store
          .settleModelRequest({ requestID: input.id, status: "failed", failure: "late overwrite" })
          .pipe(Effect.flip))._tag,
      ).toBe("AdaptiveStore.RequestAlreadySettled")
    }),
  )

  it.effect("lists only the task's model Requests in stable creation and ID order", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(5_000)
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "coordinator",
      })
      const claimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-list",
        pid: 609,
        leaseDurationMs: 1_000,
      })
      const manifest = yield* store.putManifest({
        id: AdaptiveTask.ContextManifestID.create(),
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        owner: "controller-list",
        purpose: "List request audit",
        system: ["system"],
        messages: [],
        tools: [],
        components: [],
        estimatedTokens: 100,
        requestHash: "sha256:list",
      })
      const ids = [AdaptiveTask.RequestID.create(), AdaptiveTask.RequestID.create()].toSorted()
      for (const id of ids.toReversed()) {
        yield* store.insertModelRequest({
          id,
          taskID: createdTask.id,
          agentID: agent.id,
          generation: claimed.generation,
          manifestID: manifest.id,
          modelPolicy: createdTask.modelPolicy,
        })
      }

      expect((yield* store.listModelRequests(createdTask.id)).map((request) => request.id)).toEqual(ids)
      expect(yield* store.listModelRequests(AdaptiveTask.ID.create())).toEqual([])
    }),
  )

  it.effect("returns typed InvalidRequest for a malformed ModelPolicy snapshot", () =>
    Effect.gen(function* () {
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "validator",
      })
      const claimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-a",
        pid: 607,
        leaseDurationMs: 1_000,
      })
      const manifest = yield* store.putManifest({
        id: AdaptiveTask.ContextManifestID.create(),
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        owner: "controller-a",
        purpose: "Reject a malformed request policy",
        system: ["system"],
        messages: [],
        tools: [],
        components: [],
        estimatedTokens: 100,
        requestHash: "sha256:request-policy",
      })
      const requestID = AdaptiveTask.RequestID.create()
      const modelPolicy = AdaptiveTask.ModelPolicy.make({
        ...createdTask.modelPolicy,
        hash: `sha256:${"b".repeat(64)}`,
      })

      const failure = yield* store
        .insertModelRequest({
          id: requestID,
          taskID: createdTask.id,
          agentID: agent.id,
          generation: claimed.generation,
          manifestID: manifest.id,
          modelPolicy,
        })
        .pipe(Effect.flip)
      expect(failure._tag).toBe("AdaptiveStore.InvalidRequest")
      expect(yield* store.getModelRequest(requestID).pipe(Effect.flip)).toMatchObject({
        _tag: "AdaptiveStore.RequestNotFound",
      })
    }),
  )

  it.effect("rejects Request references that disagree with the Manifest tuple", () =>
    Effect.gen(function* () {
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "validator",
      })
      const claimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-a",
        pid: 707,
        leaseDurationMs: 1_000,
      })
      const manifest = yield* store.putManifest({
        id: AdaptiveTask.ContextManifestID.create(),
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        owner: "controller-a",
        purpose: "Reference guard",
        system: ["system"],
        messages: [],
        tools: [],
        components: [],
        estimatedTokens: 10,
        requestHash: "sha256:manifest",
      })
      const requestID = AdaptiveTask.RequestID.create()

      expect(
        (yield* store
          .insertModelRequest({
            id: requestID,
            taskID: createdTask.id,
            agentID: agent.id,
            generation: claimed.generation + 1,
            manifestID: manifest.id,
            modelPolicy: createdTask.modelPolicy,
          })
          .pipe(Effect.flip))._tag,
      ).toBe("AdaptiveStore.RequestReferenceMismatch")
      expect((yield* store.getModelRequest(requestID).pipe(Effect.flip))._tag).toBe("AdaptiveStore.RequestNotFound")

      const missingParentRequestID = AdaptiveTask.RequestID.create()
      expect(
        (yield* store
          .insertModelRequest({
            id: missingParentRequestID,
            taskID: createdTask.id,
            agentID: agent.id,
            generation: claimed.generation,
            manifestID: manifest.id,
            retryOf: AdaptiveTask.RequestID.create(),
            modelPolicy: createdTask.modelPolicy,
          })
          .pipe(Effect.flip))._tag,
      ).toBe("AdaptiveStore.RequestReferenceMismatch")
      expect((yield* store.getModelRequest(missingParentRequestID).pipe(Effect.flip))._tag).toBe(
        "AdaptiveStore.RequestNotFound",
      )

      const otherTask = yield* store.createTask(task())
      const otherAgent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: otherTask.id,
        role: "validator",
      })
      const otherClaim = yield* store.claimAgent({
        agentID: otherAgent.id,
        expectedGeneration: 0,
        owner: "controller-b",
        pid: 708,
        leaseDurationMs: 1_000,
      })
      const otherManifest = yield* store.putManifest({
        id: AdaptiveTask.ContextManifestID.create(),
        taskID: otherTask.id,
        agentID: otherAgent.id,
        generation: otherClaim.generation,
        owner: "controller-b",
        purpose: "Create a parent in another Task",
        system: ["system"],
        messages: [],
        tools: [],
        components: [],
        estimatedTokens: 10,
        requestHash: "sha256:other-task",
      })
      const otherParent = yield* store.insertModelRequest({
        id: AdaptiveTask.RequestID.create(),
        taskID: otherTask.id,
        agentID: otherAgent.id,
        generation: otherClaim.generation,
        manifestID: otherManifest.id,
        modelPolicy: otherTask.modelPolicy,
      })
      const crossTaskRequestID = AdaptiveTask.RequestID.create()
      expect(
        (yield* store
          .insertModelRequest({
            id: crossTaskRequestID,
            taskID: createdTask.id,
            agentID: agent.id,
            generation: claimed.generation,
            manifestID: manifest.id,
            retryOf: otherParent.id,
            modelPolicy: createdTask.modelPolicy,
          })
          .pipe(Effect.flip))._tag,
      ).toBe("AdaptiveStore.RequestReferenceMismatch")
      expect((yield* store.getModelRequest(crossTaskRequestID).pipe(Effect.flip))._tag).toBe(
        "AdaptiveStore.RequestNotFound",
      )
    }),
  )
})

describe("AdaptiveStore bootstrap completion", () => {
  it.effect("persists bootstrap only after the exact model request succeeds", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(6_000)
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(task())
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: createdTask.id,
        role: "coordinator",
      })
      const claimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-bootstrap",
        pid: 808,
        leaseDurationMs: 1_000,
      })
      const manifest = yield* store.putManifest({
        id: AdaptiveTask.ContextManifestID.create(),
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        owner: "controller-bootstrap",
        purpose: "Coordinator bootstrap",
        system: ["system"],
        messages: [],
        tools: [],
        components: [],
        estimatedTokens: 10,
        requestHash: "sha256:bootstrap",
      })
      const request = yield* store.insertModelRequest({
        id: AdaptiveTask.RequestID.create(),
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        manifestID: manifest.id,
        modelPolicy: createdTask.modelPolicy,
      })
      const input = {
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        manifestID: manifest.id,
        requestID: request.id,
        output: "Repository discovery is required.",
      }

      expect((yield* store.completeBootstrap(input).pipe(Effect.flip))._tag).toBe(
        "AdaptiveStore.BootstrapReferenceMismatch",
      )
      expect((yield* store.getBootstrap(createdTask.id).pipe(Effect.flip))._tag).toBe("AdaptiveStore.BootstrapNotFound")

      yield* store.settleModelRequest({ requestID: request.id, status: "succeeded" })
      yield* TestClock.setTime(6_500)
      const completed = yield* store.completeBootstrap(input)

      expect(completed).toEqual({ ...input, timeCreated: 6_500 })
      expect(yield* store.getBootstrap(createdTask.id)).toEqual(completed)
    }),
  )
})

test("AdaptiveStore recovers Task, ownership generation, Manifest, Request, and bootstrap from a new process layer", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "adaptive.sqlite")
  const inputTask = task()
  const agentID = AdaptiveTask.AgentID.create()
  const manifestID = AdaptiveTask.ContextManifestID.create()
  const requestID = AdaptiveTask.RequestID.create()
  const layer = () => AppNodeBuilder.build(AdaptiveStore.node, [[Database.node, Database.layerFromPath(filename)]])
  const run = <A, E>(effect: Effect.Effect<A, E, AdaptiveStore.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer()), Effect.scoped))

  const first = await run(
    Effect.gen(function* () {
      const store = yield* AdaptiveStore.Service
      const createdTask = yield* store.createTask(inputTask)
      const agent = yield* store.createAgent({ id: agentID, taskID: createdTask.id, role: "coordinator" })
      const claimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-restart",
        pid: 808,
        leaseDurationMs: 60_000,
      })
      const manifest = yield* store.putManifest({
        id: manifestID,
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        owner: "controller-restart",
        purpose: "Recover after restart",
        system: ["system"],
        messages: [{ role: "user", content: "resume" }],
        tools: [],
        components: [{ key: "roadmap" }],
        estimatedTokens: 50,
        requestHash: "sha256:restart",
      })
      const request = yield* store.insertModelRequest({
        id: requestID,
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        manifestID: manifest.id,
        modelPolicy: createdTask.modelPolicy,
      })
      const settled = yield* store.settleModelRequest({
        requestID: request.id,
        status: "succeeded",
      })
      const bootstrap = yield* store.completeBootstrap({
        taskID: createdTask.id,
        agentID: agent.id,
        generation: claimed.generation,
        manifestID: manifest.id,
        requestID: settled.id,
        output: "Repository discovery is required.",
      })
      return { createdTask, claimed, manifest, settled, bootstrap }
    }),
  )

  const recovered = await run(
    Effect.gen(function* () {
      const store = yield* AdaptiveStore.Service
      return {
        createdTask: yield* store.getTask(inputTask.id),
        claimed: yield* store.getAgent(agentID),
        manifest: yield* store.getManifest(manifestID),
        settled: yield* store.getModelRequest(requestID),
        bootstrap: yield* store.getBootstrap(inputTask.id),
      }
    }),
  )

  expect(recovered).toEqual(first)
})
