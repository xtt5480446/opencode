import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Exit } from "effect"
import * as TestClock from "effect/testing/TestClock"
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
