import { describe, expect } from "bun:test"
import { count, eq } from "drizzle-orm"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { AdaptiveRoadmapStore } from "@opencode-ai/core/adaptive/roadmap-store"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { AdaptiveTaskTable } from "@opencode-ai/core/adaptive/sql"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Hash } from "@opencode-ai/core/util/hash"
import { AdaptiveEvent } from "@opencode-ai/schema/adaptive-event"
import { AdaptiveRoadmap } from "@opencode-ai/schema/adaptive-roadmap"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([AdaptiveRoadmapStore.node, AdaptiveStore.node, EventV2.node, Database.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

const digest = (body: string) => `sha256:${Hash.sha256(body)}` as const

const detail = (body: string, version = 1) =>
  new AdaptiveEvent.DetailRecord({
    nodeID: "retry-core",
    ref: new AdaptiveRoadmap.DetailRef({ key: "contract:x", kind: "contracts", version, status: "ready" }),
    body,
    contentHash: digest(body),
  })

const roadmap = (taskID: AdaptiveTask.ID, revision: number, refs = [detail("retry v1").ref], title = "Retry core") =>
  new AdaptiveRoadmap.Info({
    taskID,
    revision,
    requirement: new AdaptiveRoadmap.RequirementBaseline({
      objective: "Implement bounded retry",
      scope: ["src/retry.ts"],
      constraints: ["Keep one pinned model"],
      acceptance: ["bun test"],
    }),
    nodes: [
      new AdaptiveRoadmap.Node({
        id: "retry-core",
        title,
        goal: "Implement retry behavior",
        status: "ready",
        interfaces: [],
        dependencies: [],
        details: refs,
        acceptance: ["bun test"],
        risks: [],
        unresolved: [],
      }),
    ],
    risks: [],
    unresolved: [],
  })

const setup = Effect.gen(function* () {
  const foundation = yield* AdaptiveStore.Service
  const task = yield* foundation.createTask({
    id: AdaptiveTask.ID.create(),
    directory: "/workspace/project",
    mode: "normal",
    status: "planning",
    requirement: "Implement bounded retry",
    modelPolicy: AdaptiveModelPolicy.create({
      providerID: Provider.ID.make("test"),
      modelID: Model.ID.make("test-model"),
      effectiveContextLimit: 262_144,
      outputReserve: 16_384,
      safetyReserve: 8_192,
    }),
    roadmapRevision: 0,
    baseSnapshotHash: "git:base",
  })
  const agent = yield* foundation.createAgent({
    id: AdaptiveTask.AgentID.create(),
    taskID: task.id,
    role: "coordinator",
  })
  const claimed = yield* foundation.claimAgent({
    agentID: agent.id,
    expectedGeneration: 0,
    owner: "controller",
    pid: 101,
    leaseDurationMs: 60_000,
  })
  return { foundation, task, agent: claimed }
})

describe("AdaptiveRoadmapStore", () => {
  it.effect("commits one Roadmap revision and rejects stale compare-and-swap without changing it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const state = yield* setup
      const store = yield* AdaptiveRoadmapStore.Service
      const original = roadmap(state.task.id, 1)

      const committed = yield* store.commit({
        expectedRevision: 0,
        roadmap: original,
        details: [detail("retry v1")],
        sourceAgentID: state.agent.id,
        sourceGeneration: state.agent.generation,
      })
      const stale = yield* store
        .commit({
          expectedRevision: 0,
          roadmap: roadmap(state.task.id, 1, [detail("retry v1").ref], "Replacement must not win"),
          details: [],
          sourceAgentID: state.agent.id,
          sourceGeneration: state.agent.generation,
        })
        .pipe(Effect.flip)

      expect(committed.roadmap).toEqual(original)
      expect(committed.eventSequence).toBe(0)
      expect(stale._tag).toBe("AdaptiveRoadmapStore.StaleRevision")
      expect(yield* store.getCurrent(state.task.id)).toEqual(committed)
    }),
  )

  it.effect("keeps a Detail version immutable and rolls back its attempted Roadmap revision", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const store = yield* AdaptiveRoadmapStore.Service
      const original = detail("retry v1")
      yield* store.commit({
        expectedRevision: 0,
        roadmap: roadmap(state.task.id, 1),
        details: [original],
        sourceAgentID: state.agent.id,
        sourceGeneration: state.agent.generation,
      })

      const replacement = detail("different body at the same immutable version")
      const conflict = yield* store
        .commit({
          expectedRevision: 1,
          roadmap: roadmap(state.task.id, 2, [replacement.ref]),
          details: [replacement],
          sourceAgentID: state.agent.id,
          sourceGeneration: state.agent.generation,
        })
        .pipe(Effect.flip)

      expect(conflict._tag).toBe("AdaptiveRoadmapStore.ImmutableDetailConflict")
      expect((yield* store.getCurrent(state.task.id)).roadmap.revision).toBe(1)
      expect(yield* store.getDetail(state.task.id, original.ref.key, original.ref.version)).toMatchObject({
        body: original.body,
        contentHash: original.contentHash,
      })
    }),
  )

  it.effect("rejects an unresolved exact Detail reference without writing Roadmap or event state", () =>
    Effect.gen(function* () {
      const state = yield* setup
      const store = yield* AdaptiveRoadmapStore.Service
      const missing = new AdaptiveRoadmap.DetailRef({
        key: "contract:x",
        kind: "contracts",
        version: 2,
        status: "ready",
      })
      const failure = yield* store
        .commit({
          expectedRevision: 0,
          roadmap: roadmap(state.task.id, 1, [missing]),
          details: [],
          sourceAgentID: state.agent.id,
          sourceGeneration: state.agent.generation,
        })
        .pipe(Effect.flip)
      const { db } = yield* Database.Service

      expect(failure._tag).toBe("AdaptiveRoadmapStore.MissingDetailReference")
      expect((yield* state.foundation.getTask(state.task.id)).roadmapRevision).toBe(0)
      expect(
        yield* db.select({ count: count() }).from(EventTable).where(eq(EventTable.aggregate_id, state.task.id)).get(),
      ).toEqual({ count: 0 })
      expect(
        yield* db
          .select({ revision: AdaptiveTaskTable.roadmap_revision })
          .from(AdaptiveTaskTable)
          .where(eq(AdaptiveTaskTable.id, state.task.id))
          .get(),
      ).toEqual({ revision: 0 })
    }),
  )
})
