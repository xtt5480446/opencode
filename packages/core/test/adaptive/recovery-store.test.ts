import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import path from "path"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { AdaptiveRecoveryStore } from "@opencode-ai/core/adaptive/recovery-store"
import { AdaptiveRoadmapStore } from "@opencode-ai/core/adaptive/roadmap-store"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { AdaptiveCheckpointTable } from "@opencode-ai/core/adaptive/sql"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AdaptiveOperation } from "@opencode-ai/schema/adaptive-operation"
import { AdaptiveRoadmap } from "@opencode-ai/schema/adaptive-roadmap"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"

const root = LayerNode.group([AdaptiveRecoveryStore.node, AdaptiveRoadmapStore.node, AdaptiveStore.node, Database.node])
const it = testEffect(AppNodeBuilder.build(root, [[Database.node, Database.layerFromPath(":memory:")]]))
const diff = (value: string) => AdaptiveOperation.Hash.make(`sha256:${value.repeat(64).slice(0, 64)}`)

const prepare = Effect.gen(function* () {
  const foundation = yield* AdaptiveStore.Service
  const roadmaps = yield* AdaptiveRoadmapStore.Service
  const recovery = yield* AdaptiveRecoveryStore.Service
  const task = yield* foundation.createTask({
    id: AdaptiveTask.ID.create(),
    directory: "/workspace/project",
    mode: "normal",
    status: "running",
    requirement: "Implement retry",
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
  const worker = yield* foundation.createAgent({
    id: AdaptiveTask.AgentID.create(),
    taskID: task.id,
    role: "implementation",
  })
  const claimed = yield* foundation.claimAgent({
    agentID: worker.id,
    expectedGeneration: 0,
    owner: "controller",
    pid: 202,
    leaseDurationMs: 60_000,
  })
  yield* roadmaps.commit({
    expectedRevision: 0,
    roadmap: new AdaptiveRoadmap.Info({
      taskID: task.id,
      revision: 1,
      requirement: new AdaptiveRoadmap.RequirementBaseline({
        objective: "Implement retry",
        scope: ["src/retry.ts"],
        constraints: [],
        acceptance: ["bun test"],
      }),
      nodes: [
        new AdaptiveRoadmap.Node({
          id: "retry-core",
          title: "Retry core",
          goal: "Implement bounded retry",
          status: "running",
          interfaces: [],
          dependencies: [],
          details: [],
          acceptance: ["bun test"],
          risks: [],
          unresolved: [],
        }),
      ],
      risks: [],
      unresolved: [],
    }),
    details: [],
    sourceAgentID: claimed.id,
    sourceGeneration: claimed.generation,
  })
  const assignment = new AdaptiveOperation.Assignment({
    id: AdaptiveOperation.AssignmentID.create(),
    taskID: task.id,
    workerID: claimed.id,
    nodeID: "retry-core",
    roadmapRevision: 1,
    detailRefs: [],
    permittedPaths: [AdaptiveOperation.RepositoryGlob.make("src/**")],
    baseCommit: "base123",
    acceptanceCommands: ["bun test"],
    generation: claimed.generation,
    timeCreated: 1_000,
  })
  yield* recovery.createAssignment(assignment)
  return { task, worker: claimed, assignment, recovery }
})

const checkpoint = (
  state: Effect.Success<typeof prepare>,
  sequence: number,
  input: { generation?: number; eventCursor?: number; head?: string; diffHash?: AdaptiveOperation.Hash } = {},
) =>
  new AdaptiveOperation.Checkpoint({
    assignmentID: state.assignment.id,
    workerID: state.worker.id,
    generation: input.generation ?? state.worker.generation,
    sequence,
    eventCursor: input.eventCursor ?? sequence + 1,
    roadmapRevision: 1,
    nodeID: "retry-core",
    completed: [`step ${sequence}`],
    decisions: [],
    modifiedPaths: [AdaptiveOperation.RepositoryPath.make("src/retry.ts")],
    evidence: [],
    remaining: [],
    nextAction: `continue ${sequence}`,
    worktreeHead: input.head ?? "head123",
    diffHash: input.diffHash ?? diff("a"),
    timeCreated: 1_000 + sequence,
  })

describe("AdaptiveRecoveryStore", () => {
  it.effect("rejects stale generation and observed workspace mismatches without advancing checkpoint state", () =>
    Effect.gen(function* () {
      const state = yield* prepare
      const first = checkpoint(state, 1)
      yield* state.recovery.saveCheckpoint({
        checkpoint: first,
        observedHead: first.worktreeHead,
        observedDiffHash: first.diffHash,
      })

      const stale = yield* state.recovery
        .saveCheckpoint({
          checkpoint: checkpoint(state, 2, { generation: state.worker.generation + 1 }),
          observedHead: first.worktreeHead,
          observedDiffHash: first.diffHash,
        })
        .pipe(Effect.flip)
      const mismatched = yield* state.recovery
        .saveCheckpoint({
          checkpoint: checkpoint(state, 2),
          observedHead: "different-head",
          observedDiffHash: diff("b"),
        })
        .pipe(Effect.flip)

      expect(stale._tag).toBe("AdaptiveRecoveryStore.StaleGeneration")
      expect(mismatched._tag).toBe("AdaptiveRecoveryStore.WorkspaceStateMismatch")
      expect(yield* state.recovery.getLatestCheckpoint(state.worker.id)).toMatchObject({ checkpoint: first })
    }),
  )

  it.effect("lets a replacement generation continue the same immutable Assignment", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const state = yield* prepare
      const first = checkpoint(state, 1)
      yield* state.recovery.saveCheckpoint({
        checkpoint: first,
        observedHead: first.worktreeHead,
        observedDiffHash: first.diffHash,
      })
      yield* TestClock.setTime(60_000)
      const foundation = yield* AdaptiveStore.Service
      const replacement = yield* foundation.claimAgent({
        agentID: state.worker.id,
        expectedGeneration: state.worker.generation,
        owner: "replacement-controller",
        pid: 303,
        leaseDurationMs: 60_000,
      })
      const second = checkpoint(state, 2, { generation: replacement.generation })

      yield* state.recovery.saveCheckpoint({
        checkpoint: second,
        observedHead: second.worktreeHead,
        observedDiffHash: second.diffHash,
      })

      expect((yield* state.recovery.getAssignment(state.assignment.id)).assignment).toEqual(state.assignment)
      expect((yield* state.recovery.getLatestCheckpoint(state.worker.id)).checkpoint).toEqual(second)
    }),
  )

  it.effect("rejects a newer Checkpoint whose event cursor moves backward", () =>
    Effect.gen(function* () {
      const state = yield* prepare
      const first = checkpoint(state, 1)
      yield* state.recovery.saveCheckpoint({
        checkpoint: first,
        observedHead: first.worktreeHead,
        observedDiffHash: first.diffHash,
      })
      const regressed = checkpoint(state, 2, { eventCursor: first.eventCursor - 1 })

      const failure = yield* state.recovery
        .saveCheckpoint({
          checkpoint: regressed,
          observedHead: regressed.worktreeHead,
          observedDiffHash: regressed.diffHash,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("AdaptiveRecoveryStore.CheckpointCursorConflict")
      expect((yield* state.recovery.getLatestCheckpoint(state.worker.id)).checkpoint).toEqual(first)
    }),
  )

  it.effect("returns a typed corruption error when Checkpoint JSON diverges from normalized columns", () =>
    Effect.gen(function* () {
      const state = yield* prepare
      const first = checkpoint(state, 1)
      yield* state.recovery.saveCheckpoint({
        checkpoint: first,
        observedHead: first.worktreeHead,
        observedDiffHash: first.diffHash,
      })
      const { db } = yield* Database.Service
      yield* db
        .update(AdaptiveCheckpointTable)
        .set({ checkpoint: checkpoint(state, 1, { head: "tampered-head" }) })
        .run()

      const failure = yield* state.recovery.getCheckpoint(state.worker.id, first.sequence).pipe(Effect.flip)

      expect(failure._tag).toBe("AdaptiveRecoveryStore.CorruptCheckpoint")
    }),
  )
})

test("AdaptiveRecoveryStore reopens with every checkpoint sequence and the latest pointer intact", async () => {
  await using tmp = await tmpdir()
  const filename = path.join(tmp.path, "recovery.sqlite")
  const layer = () => AppNodeBuilder.build(root, [[Database.node, Database.layerFromPath(filename)]])
  const run = <A, E>(effect: Effect.Effect<A, E, AdaptiveRecoveryStore.Service | AdaptiveRoadmapStore.Service | AdaptiveStore.Service>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer()), Effect.scoped))

  const saved = await run(
    Effect.gen(function* () {
      const state = yield* prepare
      const first = checkpoint(state, 1)
      const second = checkpoint(state, 2)
      yield* state.recovery.saveCheckpoint({
        checkpoint: first,
        observedHead: first.worktreeHead,
        observedDiffHash: first.diffHash,
      })
      yield* state.recovery.saveCheckpoint({
        checkpoint: second,
        observedHead: second.worktreeHead,
        observedDiffHash: second.diffHash,
      })
      return { workerID: state.worker.id, first, second }
    }),
  )

  const reopened = await run(
    Effect.gen(function* () {
      const recovery = yield* AdaptiveRecoveryStore.Service
      return {
        first: yield* recovery.getCheckpoint(saved.workerID, 1),
        latest: yield* recovery.getLatestCheckpoint(saved.workerID),
      }
    }),
  )

  expect(reopened.first.checkpoint).toEqual(saved.first)
  expect(reopened.latest.checkpoint).toEqual(saved.second)
})
