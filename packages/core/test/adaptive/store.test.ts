import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
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

      const duplicate = yield* store
        .createTask({ ...input, requirement: "replacement must not win" })
        .pipe(Effect.flip)

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
