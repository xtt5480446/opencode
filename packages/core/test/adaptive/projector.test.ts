import { describe, expect } from "bun:test"
import { asc, count, eq } from "drizzle-orm"
import { Effect } from "effect"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { AdaptiveProjector } from "@opencode-ai/core/adaptive/projector"
import { AdaptiveRecoveryStore } from "@opencode-ai/core/adaptive/recovery-store"
import { AdaptiveRoadmapStore } from "@opencode-ai/core/adaptive/roadmap-store"
import {
  AdaptiveAgentProcessTable,
  AdaptiveAssignmentTable,
  AdaptiveCheckpointTable,
  AdaptiveDetailTable,
  AdaptiveRoadmapRevisionTable,
  AdaptiveTaskTable,
} from "@opencode-ai/core/adaptive/sql"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Hash } from "@opencode-ai/core/util/hash"
import { AdaptiveEvent } from "@opencode-ai/schema/adaptive-event"
import { AdaptiveOperation } from "@opencode-ai/schema/adaptive-operation"
import { AdaptiveRoadmap } from "@opencode-ai/schema/adaptive-roadmap"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { AdaptiveDurable } from "@opencode-ai/schema/durable-event-manifest"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { testEffect } from "../lib/effect"

const root = LayerNode.group([
  AdaptiveProjector.node,
  AdaptiveRecoveryStore.node,
  AdaptiveRoadmapStore.node,
  AdaptiveStore.node,
  EventV2.node,
  Database.node,
])
const it = testEffect(AppNodeBuilder.build(root, [[Database.node, Database.layerFromPath(":memory:")]]))
const digest = (body: string) => AdaptiveOperation.Hash.make(`sha256:${Hash.sha256(body)}`)
const diffHash = digest("diff")

const contractDetail = new AdaptiveEvent.DetailRecord({
  nodeID: "retry-core",
  ref: new AdaptiveRoadmap.DetailRef({ key: "contract:retry", kind: "contracts", version: 1, status: "ready" }),
  body: "retry<T>(operation): Promise<T>",
  contentHash: digest("retry<T>(operation): Promise<T>"),
})
const decisionDetail = new AdaptiveEvent.DetailRecord({
  nodeID: "retry-core",
  ref: new AdaptiveRoadmap.DetailRef({ key: "decision:timer", kind: "decisions", version: 1, status: "ready" }),
  body: "Use one cancellable timer.",
  contentHash: digest("Use one cancellable timer."),
})

const roadmap = (taskID: AdaptiveTask.ID, revision: number, details: readonly AdaptiveRoadmap.DetailRef[]) =>
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
        title: "Retry core",
        goal: "Implement bounded retry",
        status: revision === 1 ? "ready" : "running",
        interfaces: [],
        dependencies: [],
        details,
        acceptance: ["bun test"],
        risks: [],
        unresolved: [],
      }),
    ],
    risks: [],
    unresolved: [],
  })

const prepare = Effect.gen(function* () {
  const foundation = yield* AdaptiveStore.Service
  const roadmaps = yield* AdaptiveRoadmapStore.Service
  const recovery = yield* AdaptiveRecoveryStore.Service
  const events = yield* EventV2.Service
  const task = yield* foundation.createTask({
    id: AdaptiveTask.ID.create(),
    directory: "/workspace/project",
    mode: "normal",
    status: "running",
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
  const coordinator = yield* foundation.createAgent({
    id: AdaptiveTask.AgentID.create(),
    taskID: task.id,
    role: "coordinator",
  })
  const worker = yield* foundation.createAgent({
    id: AdaptiveTask.AgentID.create(),
    taskID: task.id,
    role: "implementation",
  })
  const claimedCoordinator = yield* foundation.claimAgent({
    agentID: coordinator.id,
    expectedGeneration: 0,
    owner: "controller",
    pid: 101,
    leaseDurationMs: 60_000,
  })
  const claimedWorker = yield* foundation.claimAgent({
    agentID: worker.id,
    expectedGeneration: 0,
    owner: "controller",
    pid: 202,
    leaseDurationMs: 60_000,
  })

  yield* events.publish(AdaptiveEvent.TaskCreated, {
    taskID: task.id,
    timeCreated: task.timeCreated,
    task: {
      id: task.id,
      directory: AbsolutePath.make(task.directory),
      mode: task.mode,
      status: task.status,
      requirement: task.requirement,
      modelPolicy: task.modelPolicy,
      roadmapRevision: task.roadmapRevision,
      timeCreated: task.timeCreated,
      timeUpdated: task.timeUpdated,
    },
  })
  yield* roadmaps.commit({
    expectedRevision: 0,
    roadmap: roadmap(task.id, 1, [contractDetail.ref]),
    details: [contractDetail],
    sourceAgentID: claimedCoordinator.id,
    sourceGeneration: claimedCoordinator.generation,
  })
  yield* events.publish(AdaptiveEvent.DetailCommitted, {
    taskID: task.id,
    timeCreated: 200,
    detail: decisionDetail,
    sourceAgentID: claimedCoordinator.id,
    sourceGeneration: claimedCoordinator.generation,
  })
  yield* roadmaps.commit({
    expectedRevision: 1,
    roadmap: roadmap(task.id, 2, [contractDetail.ref, decisionDetail.ref]),
    details: [],
    sourceAgentID: claimedCoordinator.id,
    sourceGeneration: claimedCoordinator.generation,
  })
  const assignment = new AdaptiveOperation.Assignment({
    id: AdaptiveOperation.AssignmentID.create(),
    taskID: task.id,
    workerID: claimedWorker.id,
    nodeID: "retry-core",
    roadmapRevision: 2,
    detailRefs: [contractDetail.ref, decisionDetail.ref],
    permittedPaths: [AdaptiveOperation.RepositoryGlob.make("src/**")],
    baseCommit: "base123",
    acceptanceCommands: ["bun test"],
    generation: claimedWorker.generation,
    timeCreated: 300,
  })
  yield* recovery.createAssignment(assignment)
  const checkpoint = new AdaptiveOperation.Checkpoint({
    assignmentID: assignment.id,
    workerID: claimedWorker.id,
    generation: claimedWorker.generation,
    sequence: 1,
    eventCursor: 5,
    roadmapRevision: 2,
    nodeID: "retry-core",
    completed: ["implemented retry loop"],
    decisions: [new AdaptiveOperation.VersionRef({ key: decisionDetail.ref.key, version: 1 })],
    modifiedPaths: [AdaptiveOperation.RepositoryPath.make("src/retry.ts")],
    evidence: ["aev_test"],
    remaining: ["run cancellation test"],
    nextAction: "run tests",
    worktreeHead: "head123",
    diffHash,
    timeCreated: 400,
  })
  yield* recovery.saveCheckpoint({ checkpoint, observedHead: checkpoint.worktreeHead, observedDiffHash: diffHash })
  yield* events.publish(AdaptiveEvent.DecisionRecorded, {
    taskID: task.id,
    timeCreated: 500,
    agentID: claimedWorker.id,
    generation: claimedWorker.generation,
    nodeID: assignment.nodeID,
    detail: decisionDetail.ref,
    summary: "Use one timer",
    reason: "Cancellation stays deterministic",
    evidence: ["aev_test"],
  })
  yield* events.publish(AdaptiveEvent.CandidateSubmitted, {
    taskID: task.id,
    timeCreated: 600,
    report: new AdaptiveOperation.CandidateReport({
      assignmentID: assignment.id,
      workerID: claimedWorker.id,
      generation: claimedWorker.generation,
      nodeID: assignment.nodeID,
      headCommit: "head123",
      diffHash,
      modifiedPaths: [AdaptiveOperation.RepositoryPath.make("src/retry.ts")],
      evidence: ["aev_test"],
      remainingRisks: [],
      detailRefs: [decisionDetail.ref],
      timeCreated: 600,
    }),
  })
  const latestCheckpoint = new AdaptiveOperation.Checkpoint({
    assignmentID: assignment.id,
    workerID: claimedWorker.id,
    generation: claimedWorker.generation,
    sequence: 2,
    eventCursor: 8,
    roadmapRevision: 2,
    nodeID: "retry-core",
    completed: ["implemented retry loop", "ran cancellation test"],
    decisions: [new AdaptiveOperation.VersionRef({ key: decisionDetail.ref.key, version: 1 })],
    modifiedPaths: [AdaptiveOperation.RepositoryPath.make("src/retry.ts")],
    evidence: ["aev_test", "aev_cancel"],
    remaining: [],
    nextAction: "submit candidate",
    worktreeHead: "head123",
    diffHash,
    timeCreated: 700,
  })
  yield* recovery.saveCheckpoint({
    checkpoint: latestCheckpoint,
    observedHead: latestCheckpoint.worktreeHead,
    observedDiffHash: diffHash,
  })
  return { task, coordinator: claimedCoordinator, worker: claimedWorker, assignment, checkpoint: latestCheckpoint }
})

const snapshot = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return {
    roadmaps: yield* db
      .select()
      .from(AdaptiveRoadmapRevisionTable)
      .orderBy(asc(AdaptiveRoadmapRevisionTable.revision))
      .all()
      .pipe(Effect.orDie),
    details: yield* db
      .select()
      .from(AdaptiveDetailTable)
      .orderBy(asc(AdaptiveDetailTable.key), asc(AdaptiveDetailTable.version))
      .all()
      .pipe(Effect.orDie),
    assignments: yield* db.select().from(AdaptiveAssignmentTable).all().pipe(Effect.orDie),
    checkpoints: yield* db
      .select()
      .from(AdaptiveCheckpointTable)
      .orderBy(asc(AdaptiveCheckpointTable.sequence))
      .all()
      .pipe(Effect.orDie),
    taskPointers: yield* db
      .select({ id: AdaptiveTaskTable.id, roadmapRevision: AdaptiveTaskTable.roadmap_revision })
      .from(AdaptiveTaskTable)
      .all()
      .pipe(Effect.orDie),
    agentPointers: yield* db
      .select({
        id: AdaptiveAgentProcessTable.id,
        nodeID: AdaptiveAgentProcessTable.node_id,
        assignmentID: AdaptiveAgentProcessTable.assignment_id,
        eventCursor: AdaptiveAgentProcessTable.event_cursor,
        checkpointSequence: AdaptiveAgentProcessTable.checkpoint_sequence,
      })
      .from(AdaptiveAgentProcessTable)
      .orderBy(asc(AdaptiveAgentProcessTable.id))
      .all()
      .pipe(Effect.orDie),
  }
})

describe("AdaptiveProjector", () => {
  it.effect("rebuilds exact recovery projections from the existing durable aggregate", () =>
    Effect.gen(function* () {
      const projector = yield* AdaptiveProjector.Service
      yield* projector.ready
      const state = yield* prepare
      const { db } = yield* Database.Service
      const before = yield* snapshot
      const taskRoot = yield* db
        .select({
          id: AdaptiveTaskTable.id,
          directory: AdaptiveTaskTable.directory,
          providerID: AdaptiveTaskTable.provider_id,
          modelID: AdaptiveTaskTable.model_id,
          modelPolicyHash: AdaptiveTaskTable.model_policy_hash,
          baseSnapshotHash: AdaptiveTaskTable.base_snapshot_hash,
        })
        .from(AdaptiveTaskTable)
        .where(eq(AdaptiveTaskTable.id, state.task.id))
        .get()
        .pipe(Effect.orDie)
      const agentRoots = yield* db
        .select({
          id: AdaptiveAgentProcessTable.id,
          taskID: AdaptiveAgentProcessTable.task_id,
          role: AdaptiveAgentProcessTable.role,
          generation: AdaptiveAgentProcessTable.generation,
          owner: AdaptiveAgentProcessTable.owner,
          pid: AdaptiveAgentProcessTable.pid,
        })
        .from(AdaptiveAgentProcessTable)
        .where(eq(AdaptiveAgentProcessTable.task_id, state.task.id))
        .orderBy(asc(AdaptiveAgentProcessTable.id))
        .all()
        .pipe(Effect.orDie)
      const eventRows = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, state.task.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)

      yield* projector.rebuild(state.task.id)

      expect(yield* snapshot).toEqual(before)
      expect(
        yield* db
          .select({
            id: AdaptiveTaskTable.id,
            directory: AdaptiveTaskTable.directory,
            providerID: AdaptiveTaskTable.provider_id,
            modelID: AdaptiveTaskTable.model_id,
            modelPolicyHash: AdaptiveTaskTable.model_policy_hash,
            baseSnapshotHash: AdaptiveTaskTable.base_snapshot_hash,
          })
          .from(AdaptiveTaskTable)
          .where(eq(AdaptiveTaskTable.id, state.task.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual(taskRoot)
      expect(
        yield* db
          .select({
            id: AdaptiveAgentProcessTable.id,
            taskID: AdaptiveAgentProcessTable.task_id,
            role: AdaptiveAgentProcessTable.role,
            generation: AdaptiveAgentProcessTable.generation,
            owner: AdaptiveAgentProcessTable.owner,
            pid: AdaptiveAgentProcessTable.pid,
          })
          .from(AdaptiveAgentProcessTable)
          .where(eq(AdaptiveAgentProcessTable.task_id, state.task.id))
          .orderBy(asc(AdaptiveAgentProcessTable.id))
          .all()
          .pipe(Effect.orDie),
      ).toEqual(agentRoots)
      expect(
        yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, state.task.id))
          .orderBy(asc(EventTable.seq))
          .all()
          .pipe(Effect.orDie),
      ).toEqual(eventRows)
      expect(eventRows.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
      expect(before.checkpoints).toHaveLength(2)
      expect(before.agentPointers.find((agent) => agent.id === state.worker.id)).toMatchObject({
        nodeID: state.assignment.nodeID,
        assignmentID: state.assignment.id,
        eventCursor: state.checkpoint.eventCursor,
        checkpointSequence: state.checkpoint.sequence,
      })
      yield* projector.rebuild(state.task.id)
      expect(yield* snapshot).toEqual(before)
    }),
  )

  it.effect("accepts exact reprojection without duplicates or cursor regression and rejects divergent state", () =>
    Effect.gen(function* () {
      const state = yield* prepare
      const projector = yield* AdaptiveProjector.Service
      const { db } = yield* Database.Service
      const page = yield* EventV2.readAggregate(db, {
        aggregateID: state.task.id,
        limit: 100,
        manifest: AdaptiveDurable,
      })
      const assignmentEvent = page.events.find((event) => event.type === AdaptiveEvent.AssignmentCreated.type)
      if (!assignmentEvent) throw new Error("missing AssignmentCreated fixture event")
      const before = yield* snapshot

      yield* projector.reproject(assignmentEvent)
      yield* projector.reproject(assignmentEvent)

      expect(yield* snapshot).toEqual(before)
      yield* db
        .update(AdaptiveAssignmentTable)
        .set({ base_commit: "divergent-base" })
        .where(eq(AdaptiveAssignmentTable.id, state.assignment.id))
        .run()
        .pipe(Effect.orDie)
      const failure = yield* projector.reproject(assignmentEvent).pipe(Effect.flip)
      const worker = yield* db
        .select({
          eventCursor: AdaptiveAgentProcessTable.event_cursor,
          checkpointSequence: AdaptiveAgentProcessTable.checkpoint_sequence,
        })
        .from(AdaptiveAgentProcessTable)
        .where(eq(AdaptiveAgentProcessTable.id, state.worker.id))
        .get()
        .pipe(Effect.orDie)

      expect(failure._tag).toBe("AdaptiveProjector.ProjectionConflict")
      expect(worker).toEqual({
        eventCursor: state.checkpoint.eventCursor,
        checkpointSequence: state.checkpoint.sequence,
      })
    }),
  )

  it.effect("rejects invalid generation, revision, and Detail references without committing events", () =>
    Effect.gen(function* () {
      const state = yield* prepare
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const before = yield* db
        .select({ count: count() })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, state.task.id))
        .get()
        .pipe(Effect.orDie)
      const badGeneration = yield* events
        .publish(AdaptiveEvent.DecisionRecorded, {
          taskID: state.task.id,
          timeCreated: 800,
          agentID: state.worker.id,
          generation: state.worker.generation + 1,
          nodeID: state.assignment.nodeID,
          detail: decisionDetail.ref,
          summary: "invalid",
          reason: "invalid generation",
          evidence: [],
        })
        .pipe(Effect.exit)
      const badRevision = yield* events
        .publish(AdaptiveEvent.AssignmentCreated, {
          taskID: state.task.id,
          timeCreated: 801,
          assignment: new AdaptiveOperation.Assignment({
            id: AdaptiveOperation.AssignmentID.create(),
            taskID: state.assignment.taskID,
            workerID: state.assignment.workerID,
            nodeID: state.assignment.nodeID,
            roadmapRevision: 99,
            detailRefs: state.assignment.detailRefs,
            permittedPaths: state.assignment.permittedPaths,
            baseCommit: state.assignment.baseCommit,
            acceptanceCommands: state.assignment.acceptanceCommands,
            generation: state.assignment.generation,
            timeCreated: 801,
          }),
        })
        .pipe(Effect.exit)
      const missingRef = new AdaptiveRoadmap.DetailRef({
        key: "decision:missing",
        kind: "decisions",
        version: 1,
        status: "ready",
      })
      const badReference = yield* events
        .publish(AdaptiveEvent.CandidateSubmitted, {
          taskID: state.task.id,
          timeCreated: 802,
          report: new AdaptiveOperation.CandidateReport({
            assignmentID: state.assignment.id,
            workerID: state.worker.id,
            generation: state.worker.generation,
            nodeID: state.assignment.nodeID,
            headCommit: "head123",
            diffHash,
            modifiedPaths: [],
            evidence: [],
            remainingRisks: [],
            detailRefs: [missingRef],
            timeCreated: 802,
          }),
        })
        .pipe(Effect.exit)
      const after = yield* db
        .select({ count: count() })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, state.task.id))
        .get()
        .pipe(Effect.orDie)

      expect(String(badGeneration)).toContain("AdaptiveProjector.InvalidRelationship")
      expect(String(badRevision)).toContain("AdaptiveProjector.InvalidRelationship")
      expect(String(badReference)).toContain("AdaptiveProjector.InvalidRelationship")
      expect(after).toEqual(before)
    }),
  )

  it.effect("keeps projector-backed normal store writes atomic when a projection fails", () =>
    Effect.gen(function* () {
      const state = yield* prepare
      const store = yield* AdaptiveRoadmapStore.Service
      const { db } = yield* Database.Service
      const invalid = new AdaptiveEvent.DetailRecord({
        nodeID: "retry-core",
        ref: new AdaptiveRoadmap.DetailRef({ key: "contract:unused", kind: "contracts", version: 1, status: "ready" }),
        body: "must roll back",
        contentHash: digest("must roll back"),
      })
      const missing = new AdaptiveRoadmap.DetailRef({
        key: "contract:missing",
        kind: "contracts",
        version: 1,
        status: "ready",
      })
      const before = yield* db
        .select({ count: count() })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, state.task.id))
        .get()
        .pipe(Effect.orDie)
      const failure = yield* store
        .commit({
          expectedRevision: 2,
          roadmap: roadmap(state.task.id, 3, [contractDetail.ref, decisionDetail.ref, missing]),
          details: [invalid],
          sourceAgentID: state.coordinator.id,
          sourceGeneration: state.coordinator.generation,
        })
        .pipe(Effect.flip)

      expect(failure._tag).toBe("AdaptiveRoadmapStore.MissingDetailReference")
      expect(
        yield* db
          .select({ count: count() })
          .from(AdaptiveDetailTable)
          .where(eq(AdaptiveDetailTable.key, invalid.ref.key))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ count: 0 })
      expect(
        yield* db
          .select({ revision: AdaptiveTaskTable.roadmap_revision })
          .from(AdaptiveTaskTable)
          .where(eq(AdaptiveTaskTable.id, state.task.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ revision: 2 })
      expect(
        yield* db
          .select({ count: count() })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, state.task.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual(before)
    }),
  )
})
