export * as AdaptiveProjector from "./projector"

import { and, eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { AdaptiveEvent } from "@opencode-ai/schema/adaptive-event"
import { AdaptiveOperation } from "@opencode-ai/schema/adaptive-operation"
import { AdaptiveRoadmap } from "@opencode-ai/schema/adaptive-roadmap"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { AdaptiveDurable } from "@opencode-ai/schema/durable-event-manifest"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Hash } from "../util/hash"
import { AdaptiveRecoveryStore } from "./recovery-store"
import { AdaptiveRoadmapStore } from "./roadmap-store"
import { AdaptiveProjectorIdentity } from "./projector-identity"
import {
  AdaptiveAgentProcessTable,
  AdaptiveAssignmentTable,
  AdaptiveCheckpointTable,
  AdaptiveDetailTable,
  AdaptiveRoadmapRevisionTable,
  AdaptiveTaskTable,
} from "./sql"

type DatabaseService = Database.Interface["db"]
type ProjectionMode = "live" | "reproject" | "rebuild"

export class ProjectionConflictError extends Schema.TaggedErrorClass<ProjectionConflictError>()(
  "AdaptiveProjector.ProjectionConflict",
  { taskID: AdaptiveTask.ID, entity: Schema.String, reason: Schema.String },
) {}

export class InvalidRelationshipError extends Schema.TaggedErrorClass<InvalidRelationshipError>()(
  "AdaptiveProjector.InvalidRelationship",
  { taskID: AdaptiveTask.ID, eventType: Schema.String, reason: Schema.String },
) {}

export class TaskNotFoundError extends Schema.TaggedErrorClass<TaskNotFoundError>()("AdaptiveProjector.TaskNotFound", {
  taskID: AdaptiveTask.ID,
}) {}

export type ProjectionError =
  | ProjectionConflictError
  | InvalidRelationshipError
  | TaskNotFoundError
  | AdaptiveRoadmapStore.CommitError
  | AdaptiveRecoveryStore.AssignmentError
  | AdaptiveRecoveryStore.CheckpointError

export interface Interface {
  /** Completes only after every live projector has been registered. */
  readonly ready: Effect.Effect<void>
  /** Re-applies one decoded durable event without inserting or deleting its authoritative Event row. */
  readonly reproject: (event: AdaptiveEvent.DurableEvent) => Effect.Effect<void, ProjectionError>
  /** Atomically resets the owned projection boundary and rebuilds it from the existing Task aggregate. */
  readonly rebuild: (taskID: AdaptiveTask.ID) => Effect.Effect<void, ProjectionError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AdaptiveProjector") {}

const encodeRoadmap = Schema.encodeUnknownSync(AdaptiveRoadmap.Info)
const digest = (value: string) => AdaptiveOperation.Hash.make(`sha256:${Hash.sha256(value)}`)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const applyLive = (event: AdaptiveEvent.DurableEvent) => apply(db, event, "live").pipe(Effect.orDie)

    yield* events.project(AdaptiveEvent.TaskCreated, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.RoadmapCommitted, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.DetailCommitted, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.AssignmentCreated, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.AgentGenerationStarted, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.AgentGenerationLost, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.RecoveryVerified, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.ToolCalled, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.ToolSettled, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.DecisionRecorded, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.DependencyReported, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.CheckpointSaved, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.CandidateSubmitted, applyLive, AdaptiveProjectorIdentity)
    yield* events.project(AdaptiveEvent.ContextSplitRequired, applyLive, AdaptiveProjectorIdentity)

    const reproject = Effect.fn("AdaptiveProjector.reproject")((event: AdaptiveEvent.DurableEvent) =>
      db
        .transaction(() => apply(db, event, "reproject"), { behavior: "immediate" })
        .pipe(Effect.catchTag("SqlError", Effect.die)),
    )
    const rebuild = Effect.fn("AdaptiveProjector.rebuild")(function* (taskID: AdaptiveTask.ID) {
      yield* db
        .transaction(
          () =>
            Effect.gen(function* () {
              const task = yield* db
                .select({ id: AdaptiveTaskTable.id })
                .from(AdaptiveTaskTable)
                .where(eq(AdaptiveTaskTable.id, taskID))
                .get()
                .pipe(Effect.orDie)
              if (!task) return yield* new TaskNotFoundError({ taskID })
              const aggregate = yield* readAggregate(db, taskID)
              const agents = yield* db
                .select({ id: AdaptiveAgentProcessTable.id })
                .from(AdaptiveAgentProcessTable)
                .where(eq(AdaptiveAgentProcessTable.task_id, taskID))
                .all()
                .pipe(Effect.orDie)
              const agentIDs = agents.map((agent) => agent.id)
              if (agentIDs.length > 0) {
                yield* db
                  .delete(AdaptiveCheckpointTable)
                  .where(inArray(AdaptiveCheckpointTable.worker_id, agentIDs))
                  .run()
                  .pipe(Effect.orDie)
              }
              yield* db
                .delete(AdaptiveAssignmentTable)
                .where(eq(AdaptiveAssignmentTable.task_id, taskID))
                .run()
                .pipe(Effect.orDie)
              yield* db
                .delete(AdaptiveRoadmapRevisionTable)
                .where(eq(AdaptiveRoadmapRevisionTable.task_id, taskID))
                .run()
                .pipe(Effect.orDie)
              yield* db
                .delete(AdaptiveDetailTable)
                .where(eq(AdaptiveDetailTable.task_id, taskID))
                .run()
                .pipe(Effect.orDie)
              yield* db
                .update(AdaptiveTaskTable)
                .set({ roadmap_revision: 0 })
                .where(eq(AdaptiveTaskTable.id, taskID))
                .run()
                .pipe(Effect.orDie)
              yield* db
                .update(AdaptiveAgentProcessTable)
                .set({ node_id: null, assignment_id: null, event_cursor: 0, checkpoint_sequence: null })
                .where(eq(AdaptiveAgentProcessTable.task_id, taskID))
                .run()
                .pipe(Effect.orDie)
              yield* Effect.forEach(aggregate, (event) => apply(db, event, "rebuild"), {
                concurrency: 1,
                discard: true,
              })
              return undefined
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.catchTag("SqlError", Effect.die))
    })

    return Service.of({ ready: Effect.void, reproject, rebuild })
  }),
)

const readAggregate = (
  db: DatabaseService,
  taskID: AdaptiveTask.ID,
  after = -1,
): Effect.Effect<AdaptiveEvent.DurableEvent[]> =>
  Effect.gen(function* () {
    const page = yield* EventV2.readAggregate(db, {
      aggregateID: taskID,
      after,
      limit: 256,
      manifest: AdaptiveDurable,
    })
    if (!page.hasMore) return [...page.events]
    const last = page.events.at(-1)?.durable?.seq
    if (last === undefined) return yield* Effect.die("Adaptive durable aggregate page has no sequence")
    return [...page.events, ...(yield* readAggregate(db, taskID, last))]
  })

const apply = (db: DatabaseService, event: AdaptiveEvent.DurableEvent, mode: ProjectionMode) =>
  Effect.gen(function* () {
    if (!event.durable)
      return yield* invalid(event, event.data.taskID, "Durable Adaptive event is missing its aggregate sequence")
    if (event.durable.aggregateID !== event.data.taskID)
      return yield* invalid(event, event.data.taskID, "Event aggregate does not match taskID")
    switch (event.type) {
      case AdaptiveEvent.TaskCreated.type:
        return yield* projectTaskCreated(db, event)
      case AdaptiveEvent.RoadmapCommitted.type:
        return yield* projectRoadmap(db, event, mode)
      case AdaptiveEvent.DetailCommitted.type:
        return yield* projectDetail(db, event, mode)
      case AdaptiveEvent.AssignmentCreated.type:
        return yield* projectAssignment(db, event, mode)
      case AdaptiveEvent.AgentGenerationStarted.type:
        return yield* projectGenerationStarted(db, event, mode)
      case AdaptiveEvent.AgentGenerationLost.type:
        return yield* validateAgentEvent(db, event, event.data.agentID, event.data.role, event.data.generation, mode)
      case AdaptiveEvent.RecoveryVerified.type:
        return yield* validateRecovery(db, event, mode)
      case AdaptiveEvent.ToolCalled.type:
      case AdaptiveEvent.ToolSettled.type:
        return yield* validateAgentAndAssignment(
          db,
          event,
          event.data.agentID,
          event.data.generation,
          event.data.assignmentID,
          mode,
        )
      case AdaptiveEvent.DecisionRecorded.type:
        return yield* validateDecision(db, event, mode)
      case AdaptiveEvent.DependencyReported.type:
        return yield* validateDependency(db, event, mode)
      case AdaptiveEvent.CheckpointSaved.type:
        return yield* projectCheckpoint(db, event, mode)
      case AdaptiveEvent.CandidateSubmitted.type:
        return yield* validateCandidate(db, event, mode)
      case AdaptiveEvent.ContextSplitRequired.type:
        yield* validateAgentAndAssignment(
          db,
          event,
          event.data.agentID,
          event.data.generation,
          event.data.assignmentID,
          mode,
        )
        return yield* requireNode(db, event, event.data.nodeID)
    }
    return undefined
  })

const projectTaskCreated = (db: DatabaseService, event: AdaptiveEvent.TaskCreated) =>
  Effect.gen(function* () {
    const row = yield* db
      .select()
      .from(AdaptiveTaskTable)
      .where(eq(AdaptiveTaskTable.id, event.data.taskID))
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new TaskNotFoundError({ taskID: event.data.taskID })
    const task = event.data.task
    if (
      task.id !== row.id ||
      event.data.timeCreated !== task.timeCreated ||
      task.directory !== row.directory ||
      task.mode !== row.mode ||
      task.requirement !== row.requirement ||
      task.modelPolicy.providerID !== row.provider_id ||
      task.modelPolicy.modelID !== row.model_id ||
      (task.modelPolicy.variant ?? null) !== row.variant ||
      task.modelPolicy.effectiveContextLimit !== row.effective_context_limit ||
      task.modelPolicy.outputReserve !== row.output_reserve ||
      task.modelPolicy.safetyReserve !== row.safety_reserve ||
      task.modelPolicy.hash !== row.model_policy_hash ||
      task.roadmapRevision > row.roadmap_revision
    )
      return yield* invalid(event, event.data.taskID, "TaskCreated disagrees with the preserved Task root")
    return undefined
  })

const projectRoadmap = (db: DatabaseService, event: AdaptiveEvent.RoadmapCommitted, mode: ProjectionMode) =>
  Effect.gen(function* () {
    const data = event.data
    const roadmap = data.roadmap
    const eventSequence = event.durable!.seq
    if (roadmap.taskID !== data.taskID)
      return yield* invalid(event, data.taskID, "Roadmap taskID does not match the aggregate")
    if (data.contentHash !== digest(JSON.stringify(encodeRoadmap(roadmap))))
      return yield* invalid(event, data.taskID, "Roadmap content hash does not match its encoded body")
    yield* requireRoadmapSource(db, event, mode)
    const nodeIDs = new Set(roadmap.nodes.map((node) => node.id))
    if (nodeIDs.size !== roadmap.nodes.length)
      return yield* invalid(event, data.taskID, "Roadmap node IDs must be unique")
    const existing = yield* db
      .select()
      .from(AdaptiveRoadmapRevisionTable)
      .where(
        and(
          eq(AdaptiveRoadmapRevisionTable.task_id, data.taskID),
          eq(AdaptiveRoadmapRevisionTable.revision, roadmap.revision),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (existing) {
      if (
        existing.event_sequence === eventSequence &&
        same(existing.requirement, roadmap.requirement) &&
        same(existing.roadmap, roadmap) &&
        existing.content_hash === data.contentHash &&
        existing.source_agent_id === data.sourceAgentID &&
        existing.source_generation === data.sourceGeneration &&
        existing.time_created === data.timeCreated
      ) {
        yield* Effect.forEach(
          data.details,
          (detail) => insertDetail(db, event, detail, data.sourceAgentID, data.sourceGeneration, "rebuild"),
          { discard: true },
        )
        yield* verifyRoadmapReferences(db, event, roadmap)
        return undefined
      }
      if (mode === "live")
        return yield* new AdaptiveRoadmapStore.StaleRevisionError({
          taskID: data.taskID,
          expectedRevision: roadmap.revision - 1,
          actualRevision: roadmap.revision,
        })
      return yield* conflict(data.taskID, `Roadmap r${roadmap.revision}`, "Stored normalized row diverged")
    }
    const task = yield* requireTask(db, data.taskID)
    if (task.roadmap_revision !== roadmap.revision - 1)
      return yield* new AdaptiveRoadmapStore.StaleRevisionError({
        taskID: data.taskID,
        expectedRevision: roadmap.revision - 1,
        actualRevision: task.roadmap_revision,
      })
    const versions = new Set<string>()
    yield* Effect.forEach(
      data.details,
      (detail) =>
        Effect.gen(function* () {
          const key = `${detail.ref.key}\u0000${detail.ref.version}`
          if (versions.has(key))
            return yield* invalid(
              event,
              data.taskID,
              `Roadmap contains duplicate Detail ${detail.ref.key}@${detail.ref.version}`,
            )
          versions.add(key)
          if (!nodeIDs.has(detail.nodeID))
            return yield* invalid(event, data.taskID, `Detail node ${detail.nodeID} is absent from the Roadmap`)
          yield* insertDetail(db, event, detail, data.sourceAgentID, data.sourceGeneration, mode)
          return undefined
        }),
      { discard: true },
    )
    yield* verifyRoadmapReferences(db, event, roadmap)
    yield* db
      .insert(AdaptiveRoadmapRevisionTable)
      .values({
        task_id: data.taskID,
        revision: roadmap.revision,
        requirement: roadmap.requirement,
        roadmap,
        content_hash: data.contentHash,
        source_agent_id: data.sourceAgentID,
        source_generation: data.sourceGeneration,
        event_sequence: eventSequence,
        time_created: data.timeCreated,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .update(AdaptiveTaskTable)
      .set({ roadmap_revision: roadmap.revision, ...(mode === "live" ? { time_updated: data.timeCreated } : {}) })
      .where(eq(AdaptiveTaskTable.id, data.taskID))
      .run()
      .pipe(Effect.orDie)
    return undefined
  })

const projectDetail = (db: DatabaseService, event: AdaptiveEvent.DetailCommitted, mode: ProjectionMode) =>
  Effect.gen(function* () {
    yield* requireTask(db, event.data.taskID)
    yield* requireAgent(db, event, event.data.sourceAgentID, event.data.sourceGeneration, mode)
    yield* requireNode(db, event, event.data.detail.nodeID)
    yield* insertDetail(db, event, event.data.detail, event.data.sourceAgentID, event.data.sourceGeneration, mode)
    return undefined
  })

const insertDetail = (
  db: DatabaseService,
  event: AdaptiveEvent.RoadmapCommitted | AdaptiveEvent.DetailCommitted,
  detail: AdaptiveEvent.DetailRecord,
  sourceAgentID: AdaptiveTask.AgentID,
  sourceGeneration: number,
  mode: ProjectionMode,
) =>
  Effect.gen(function* () {
    if (detail.contentHash !== digest(detail.body))
      return yield* invalid(event, event.data.taskID, `Detail ${detail.ref.key}@${detail.ref.version} hash mismatch`)
    const existing = yield* db
      .select()
      .from(AdaptiveDetailTable)
      .where(
        and(
          eq(AdaptiveDetailTable.task_id, event.data.taskID),
          eq(AdaptiveDetailTable.key, detail.ref.key),
          eq(AdaptiveDetailTable.version, detail.ref.version),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (existing) {
      if (
        existing.node_id === detail.nodeID &&
        existing.kind === detail.ref.kind &&
        existing.status === detail.ref.status &&
        existing.body === detail.body &&
        existing.content_hash === detail.contentHash
      )
        return undefined
      if (mode === "live")
        return yield* new AdaptiveRoadmapStore.ImmutableDetailConflictError({
          taskID: event.data.taskID,
          key: detail.ref.key,
          version: detail.ref.version,
        })
      return yield* conflict(
        event.data.taskID,
        `Detail ${detail.ref.key}@${detail.ref.version}`,
        "Stored normalized row diverged",
      )
    }
    yield* db
      .insert(AdaptiveDetailTable)
      .values({
        task_id: event.data.taskID,
        key: detail.ref.key,
        version: detail.ref.version,
        node_id: detail.nodeID,
        kind: detail.ref.kind,
        status: detail.ref.status,
        body: detail.body,
        content_hash: detail.contentHash,
        source_agent_id: sourceAgentID,
        source_generation: sourceGeneration,
        time_created: event.data.timeCreated,
      })
      .run()
      .pipe(Effect.orDie)
    return undefined
  })

const verifyRoadmapReferences = (
  db: DatabaseService,
  event: AdaptiveEvent.RoadmapCommitted,
  roadmap: AdaptiveRoadmap.Info,
) =>
  Effect.forEach(
    roadmap.nodes.flatMap((node) => [
      ...node.details.map((ref) => ({ nodeID: node.id, ref })),
      ...node.interfaces.map(
        (item) =>
          ({
            nodeID: node.id,
            ref: new AdaptiveRoadmap.DetailRef({
              key: item.key,
              kind: "contracts",
              version: item.version,
              status: item.state,
            }),
          }) as const,
      ),
    ]),
    (item) => requireDetail(db, event, item.ref, item.nodeID),
    { discard: true },
  )

const projectAssignment = (db: DatabaseService, event: AdaptiveEvent.AssignmentCreated, mode: ProjectionMode) =>
  Effect.gen(function* () {
    const assignment = event.data.assignment
    if (assignment.taskID !== event.data.taskID)
      return yield* invalid(event, event.data.taskID, "Assignment taskID does not match the aggregate")
    if (assignment.timeCreated !== event.data.timeCreated)
      return yield* invalid(event, event.data.taskID, "Assignment time does not match its event")
    const worker = yield* requireAgent(db, event, assignment.workerID, assignment.generation, mode)
    yield* requireRoadmapNode(db, event, assignment.roadmapRevision, assignment.nodeID)
    yield* Effect.forEach(assignment.detailRefs, (ref) => requireDetail(db, event, ref), { discard: true })
    const existing = yield* db
      .select()
      .from(AdaptiveAssignmentTable)
      .where(eq(AdaptiveAssignmentTable.id, assignment.id))
      .get()
      .pipe(Effect.orDie)
    if (existing) {
      const exact =
        existing.task_id === assignment.taskID &&
        existing.worker_id === assignment.workerID &&
        existing.node_id === assignment.nodeID &&
        existing.generation === assignment.generation &&
        existing.roadmap_revision === assignment.roadmapRevision &&
        same(existing.detail_refs, assignment.detailRefs) &&
        same(existing.permitted_paths, assignment.permittedPaths) &&
        existing.base_commit === assignment.baseCommit &&
        same(existing.acceptance_commands, assignment.acceptanceCommands) &&
        existing.time_created === assignment.timeCreated &&
        existing.superseded_at === null
      if (exact && mode !== "live") {
        if (
          mode === "reproject" &&
          worker.generation === assignment.generation &&
          event.durable!.seq >= worker.event_cursor
        )
          yield* db
            .update(AdaptiveAgentProcessTable)
            .set({
              node_id: assignment.nodeID,
              assignment_id: assignment.id,
              event_cursor: event.durable!.seq,
            })
            .where(eq(AdaptiveAgentProcessTable.id, assignment.workerID))
            .run()
            .pipe(Effect.orDie)
        return undefined
      }
      if (mode === "live")
        return yield* new AdaptiveRecoveryStore.DuplicateAssignmentError({ assignmentID: assignment.id })
      return yield* conflict(event.data.taskID, `Assignment ${assignment.id}`, "Stored normalized row diverged")
    }
    const task = yield* requireTask(db, event.data.taskID)
    if (task.roadmap_revision !== assignment.roadmapRevision)
      return yield* invalid(
        event,
        event.data.taskID,
        `Assignment Roadmap r${assignment.roadmapRevision} does not match current r${task.roadmap_revision}`,
      )
    if (worker.role !== "implementation")
      return yield* invalid(event, event.data.taskID, "Assignment Worker must be an implementation Agent")
    if (worker.assignment_id !== null)
      return yield* invalid(event, event.data.taskID, `Worker already owns Assignment ${worker.assignment_id}`)
    yield* db
      .insert(AdaptiveAssignmentTable)
      .values({
        id: assignment.id,
        task_id: assignment.taskID,
        worker_id: assignment.workerID,
        node_id: assignment.nodeID,
        generation: assignment.generation,
        roadmap_revision: assignment.roadmapRevision,
        detail_refs: assignment.detailRefs,
        permitted_paths: assignment.permittedPaths,
        base_commit: assignment.baseCommit,
        acceptance_commands: assignment.acceptanceCommands,
        time_created: assignment.timeCreated,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .update(AdaptiveAgentProcessTable)
      .set({ node_id: assignment.nodeID, assignment_id: assignment.id, event_cursor: event.durable!.seq })
      .where(eq(AdaptiveAgentProcessTable.id, assignment.workerID))
      .run()
      .pipe(Effect.orDie)
    return undefined
  })

const projectCheckpoint = (db: DatabaseService, event: AdaptiveEvent.CheckpointSaved, mode: ProjectionMode) =>
  Effect.gen(function* () {
    const checkpoint = event.data.checkpoint
    if (checkpoint.timeCreated !== event.data.timeCreated)
      return yield* invalid(event, event.data.taskID, "Checkpoint time does not match its event")
    const assignment = yield* requireAssignment(db, event, checkpoint.assignmentID)
    const worker = yield* requireAgent(db, event, checkpoint.workerID, checkpoint.generation, mode)
    if (
      assignment.task_id !== event.data.taskID ||
      assignment.worker_id !== checkpoint.workerID ||
      assignment.roadmap_revision !== checkpoint.roadmapRevision ||
      assignment.node_id !== checkpoint.nodeID ||
      worker.assignment_id !== checkpoint.assignmentID
    )
      return yield* invalid(event, event.data.taskID, "Checkpoint does not match the active Assignment tuple")
    const task = yield* requireTask(db, event.data.taskID)
    if (task.roadmap_revision < checkpoint.roadmapRevision)
      return yield* invalid(event, event.data.taskID, "Checkpoint references a newer Roadmap revision")
    yield* Effect.forEach(checkpoint.decisions, (ref) => requireDecisionRef(db, event, ref), { discard: true })
    const existing = yield* db
      .select()
      .from(AdaptiveCheckpointTable)
      .where(
        and(
          eq(AdaptiveCheckpointTable.worker_id, checkpoint.workerID),
          eq(AdaptiveCheckpointTable.sequence, checkpoint.sequence),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (existing) {
      const exact =
        existing.assignment_id === checkpoint.assignmentID &&
        existing.generation === checkpoint.generation &&
        existing.roadmap_revision === checkpoint.roadmapRevision &&
        same(existing.checkpoint, checkpoint) &&
        existing.worktree_head === checkpoint.worktreeHead &&
        existing.diff_hash === checkpoint.diffHash &&
        existing.event_cursor === checkpoint.eventCursor &&
        existing.time_created === checkpoint.timeCreated
      if (exact && mode !== "live") {
        if (
          mode === "reproject" &&
          worker.generation === checkpoint.generation &&
          event.durable!.seq >= worker.event_cursor
        ) {
          const repairSequence =
            worker.checkpoint_sequence === null || worker.checkpoint_sequence <= checkpoint.sequence
          const repairCursor = worker.event_cursor <= checkpoint.eventCursor
          if (repairSequence || repairCursor)
            yield* db
              .update(AdaptiveAgentProcessTable)
              .set({
                ...(repairSequence ? { checkpoint_sequence: checkpoint.sequence } : {}),
                ...(repairCursor ? { event_cursor: checkpoint.eventCursor } : {}),
              })
              .where(eq(AdaptiveAgentProcessTable.id, checkpoint.workerID))
              .run()
              .pipe(Effect.orDie)
        }
        return undefined
      }
      if (exact && mode === "live") {
        const worker = yield* requireAgent(db, event, checkpoint.workerID, checkpoint.generation, mode)
        return yield* new AdaptiveRecoveryStore.CheckpointSequenceConflictError({
          workerID: checkpoint.workerID,
          expectedSequence: (worker.checkpoint_sequence ?? 0) + 1,
          actualSequence: checkpoint.sequence,
        })
      }
      return yield* conflict(
        event.data.taskID,
        `Checkpoint ${checkpoint.workerID}#${checkpoint.sequence}`,
        "Stored normalized row diverged",
      )
    }
    const expectedSequence = (worker.checkpoint_sequence ?? 0) + 1
    if (checkpoint.sequence !== expectedSequence)
      return yield* new AdaptiveRecoveryStore.CheckpointSequenceConflictError({
        workerID: checkpoint.workerID,
        expectedSequence,
        actualSequence: checkpoint.sequence,
      })
    if (checkpoint.eventCursor < worker.event_cursor || checkpoint.eventCursor > event.durable!.seq)
      return yield* new AdaptiveRecoveryStore.CheckpointCursorConflictError({
        workerID: checkpoint.workerID,
        currentCursor: worker.event_cursor,
        checkpointCursor: checkpoint.eventCursor,
        eventSequence: event.durable!.seq,
      })
    yield* db
      .insert(AdaptiveCheckpointTable)
      .values({
        worker_id: checkpoint.workerID,
        sequence: checkpoint.sequence,
        assignment_id: checkpoint.assignmentID,
        generation: checkpoint.generation,
        roadmap_revision: checkpoint.roadmapRevision,
        checkpoint,
        worktree_head: checkpoint.worktreeHead,
        diff_hash: checkpoint.diffHash,
        event_cursor: checkpoint.eventCursor,
        time_created: checkpoint.timeCreated,
      })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .update(AdaptiveAgentProcessTable)
      .set({ checkpoint_sequence: checkpoint.sequence, event_cursor: checkpoint.eventCursor })
      .where(eq(AdaptiveAgentProcessTable.id, checkpoint.workerID))
      .run()
      .pipe(Effect.orDie)
    return undefined
  })

const projectGenerationStarted = (
  db: DatabaseService,
  event: AdaptiveEvent.AgentGenerationStarted,
  mode: ProjectionMode,
) =>
  Effect.gen(function* () {
    const agent = yield* validateAgentEvent(db, event, event.data.agentID, event.data.role, event.data.generation, mode)
    if (event.data.nodeID) yield* requireNode(db, event, event.data.nodeID)
    if (event.data.assignmentID) {
      const assignment = yield* requireAssignment(db, event, event.data.assignmentID)
      if (assignment.worker_id !== agent.id || assignment.node_id !== event.data.nodeID)
        return yield* invalid(event, event.data.taskID, "Generation pointer does not match its Assignment")
    }
    if (mode !== "rebuild" && (agent.generation !== event.data.generation || event.durable!.seq < agent.event_cursor))
      return undefined
    yield* db
      .update(AdaptiveAgentProcessTable)
      .set({
        node_id: event.data.nodeID ?? null,
        assignment_id: event.data.assignmentID ?? null,
        event_cursor: event.durable!.seq,
      })
      .where(eq(AdaptiveAgentProcessTable.id, event.data.agentID))
      .run()
      .pipe(Effect.orDie)
    return undefined
  })

const validateRecovery = (db: DatabaseService, event: AdaptiveEvent.RecoveryVerified, mode: ProjectionMode) =>
  Effect.gen(function* () {
    const verification = event.data.verification
    if (verification.timeCreated !== event.data.timeCreated)
      return yield* invalid(event, event.data.taskID, "Recovery verification time does not match its event")
    const assignment = yield* requireAssignment(db, event, verification.assignmentID)
    yield* requireAgent(db, event, verification.workerID, verification.generation, mode)
    if (
      assignment.task_id !== event.data.taskID ||
      assignment.worker_id !== verification.workerID ||
      assignment.roadmap_revision !== verification.roadmapRevision
    )
      return yield* invalid(event, event.data.taskID, "Recovery verification does not match its Assignment")
    return undefined
  })

const validateDecision = (db: DatabaseService, event: AdaptiveEvent.DecisionRecorded, mode: ProjectionMode) =>
  Effect.gen(function* () {
    yield* requireAgent(db, event, event.data.agentID, event.data.generation, mode)
    yield* requireNode(db, event, event.data.nodeID)
    yield* requireDetail(db, event, event.data.detail, event.data.nodeID)
    return undefined
  })

const validateDependency = (db: DatabaseService, event: AdaptiveEvent.DependencyReported, mode: ProjectionMode) =>
  Effect.gen(function* () {
    yield* requireAgent(db, event, event.data.agentID, event.data.generation, mode)
    yield* requireNode(db, event, event.data.nodeID)
    yield* requireNode(db, event, event.data.targetNodeID)
    return undefined
  })

const validateCandidate = (db: DatabaseService, event: AdaptiveEvent.CandidateSubmitted, mode: ProjectionMode) =>
  Effect.gen(function* () {
    const report = event.data.report
    if (report.timeCreated !== event.data.timeCreated)
      return yield* invalid(event, event.data.taskID, "Candidate time does not match its event")
    const assignment = yield* requireAssignment(db, event, report.assignmentID)
    yield* requireAgent(db, event, report.workerID, report.generation, mode)
    if (
      assignment.task_id !== event.data.taskID ||
      assignment.worker_id !== report.workerID ||
      assignment.node_id !== report.nodeID
    )
      return yield* invalid(event, event.data.taskID, "Candidate does not match its Assignment")
    yield* Effect.forEach(report.detailRefs, (ref) => requireDetail(db, event, ref), { discard: true })
    return undefined
  })

const validateAgentAndAssignment = (
  db: DatabaseService,
  event: AdaptiveEvent.ToolCalled | AdaptiveEvent.ToolSettled | AdaptiveEvent.ContextSplitRequired,
  agentID: AdaptiveTask.AgentID,
  generation: number,
  assignmentID: AdaptiveOperation.AssignmentID | undefined,
  mode: ProjectionMode,
) =>
  Effect.gen(function* () {
    yield* requireAgent(db, event, agentID, generation, mode)
    if (!assignmentID) return undefined
    const assignment = yield* requireAssignment(db, event, assignmentID)
    if (assignment.task_id !== event.data.taskID || assignment.worker_id !== agentID)
      return yield* invalid(event, event.data.taskID, "Event Assignment does not belong to its Agent and Task")
    return undefined
  })

const validateAgentEvent = (
  db: DatabaseService,
  event: AdaptiveEvent.AgentGenerationStarted | AdaptiveEvent.AgentGenerationLost,
  agentID: AdaptiveTask.AgentID,
  role: AdaptiveTask.Role,
  generation: number,
  mode: ProjectionMode,
) =>
  Effect.gen(function* () {
    const agent = yield* requireAgent(db, event, agentID, generation, mode)
    if (agent.role !== role) return yield* invalid(event, event.data.taskID, "Agent role does not match its root row")
    return agent
  })

const requireTask = (db: DatabaseService, taskID: AdaptiveTask.ID) =>
  Effect.gen(function* () {
    const task = yield* db
      .select()
      .from(AdaptiveTaskTable)
      .where(eq(AdaptiveTaskTable.id, taskID))
      .get()
      .pipe(Effect.orDie)
    if (!task) return yield* new TaskNotFoundError({ taskID })
    return task
  })

const requireRoadmapSource = (db: DatabaseService, event: AdaptiveEvent.RoadmapCommitted, mode: ProjectionMode) =>
  Effect.gen(function* () {
    const agent = yield* db
      .select({ taskID: AdaptiveAgentProcessTable.task_id, generation: AdaptiveAgentProcessTable.generation })
      .from(AdaptiveAgentProcessTable)
      .where(eq(AdaptiveAgentProcessTable.id, event.data.sourceAgentID))
      .get()
      .pipe(Effect.orDie)
    if (
      !agent ||
      agent.taskID !== event.data.taskID ||
      (mode === "live" && agent.generation !== event.data.sourceGeneration) ||
      (mode !== "live" && agent.generation < event.data.sourceGeneration)
    )
      return yield* new AdaptiveRoadmapStore.SourceGenerationMismatchError({
        agentID: event.data.sourceAgentID,
        expectedGeneration: event.data.sourceGeneration,
        actualGeneration: agent?.generation ?? -1,
      })
    return agent
  })

const requireAgent = (
  db: DatabaseService,
  event: AdaptiveEvent.DurableEvent,
  agentID: AdaptiveTask.AgentID,
  generation: number,
  mode: ProjectionMode,
) =>
  Effect.gen(function* () {
    const agent = yield* db
      .select()
      .from(AdaptiveAgentProcessTable)
      .where(eq(AdaptiveAgentProcessTable.id, agentID))
      .get()
      .pipe(Effect.orDie)
    if (!agent || agent.task_id !== event.data.taskID)
      return yield* invalid(event, event.data.taskID, `Agent ${agentID} is not rooted in this Task`)
    if ((mode === "live" && agent.generation !== generation) || (mode !== "live" && agent.generation < generation))
      return yield* invalid(
        event,
        event.data.taskID,
        `Agent generation ${generation} is incompatible with preserved generation ${agent.generation}`,
      )
    return agent
  })

const requireAssignment = (
  db: DatabaseService,
  event: AdaptiveEvent.DurableEvent,
  assignmentID: AdaptiveOperation.AssignmentID,
) =>
  Effect.gen(function* () {
    const assignment = yield* db
      .select()
      .from(AdaptiveAssignmentTable)
      .where(eq(AdaptiveAssignmentTable.id, assignmentID))
      .get()
      .pipe(Effect.orDie)
    if (!assignment || assignment.task_id !== event.data.taskID)
      return yield* invalid(event, event.data.taskID, `Assignment ${assignmentID} does not belong to this Task`)
    return assignment
  })

const requireRoadmapNode = (db: DatabaseService, event: AdaptiveEvent.DurableEvent, revision: number, nodeID: string) =>
  Effect.gen(function* () {
    const row = yield* db
      .select({ roadmap: AdaptiveRoadmapRevisionTable.roadmap })
      .from(AdaptiveRoadmapRevisionTable)
      .where(
        and(
          eq(AdaptiveRoadmapRevisionTable.task_id, event.data.taskID),
          eq(AdaptiveRoadmapRevisionTable.revision, revision),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!row || !row.roadmap.nodes.some((node) => node.id === nodeID))
      return yield* invalid(event, event.data.taskID, `Node ${nodeID} is absent from Roadmap r${revision}`)
    return undefined
  })

const requireNode = (db: DatabaseService, event: AdaptiveEvent.DurableEvent, nodeID: string) =>
  Effect.gen(function* () {
    const task = yield* requireTask(db, event.data.taskID)
    if (task.roadmap_revision === 0)
      return yield* invalid(event, event.data.taskID, `Node ${nodeID} cannot resolve without a Roadmap`)
    yield* requireRoadmapNode(db, event, task.roadmap_revision, nodeID)
    return undefined
  })

const requireDetail = (
  db: DatabaseService,
  event: AdaptiveEvent.DurableEvent,
  ref: AdaptiveRoadmap.DetailRef,
  nodeID?: string,
) =>
  Effect.gen(function* () {
    const detail = yield* db
      .select({
        nodeID: AdaptiveDetailTable.node_id,
        kind: AdaptiveDetailTable.kind,
        status: AdaptiveDetailTable.status,
      })
      .from(AdaptiveDetailTable)
      .where(
        and(
          eq(AdaptiveDetailTable.task_id, event.data.taskID),
          eq(AdaptiveDetailTable.key, ref.key),
          eq(AdaptiveDetailTable.version, ref.version),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (!detail || detail.kind !== ref.kind || detail.status !== ref.status || (nodeID && detail.nodeID !== nodeID)) {
      if (event.type === AdaptiveEvent.RoadmapCommitted.type)
        return yield* new AdaptiveRoadmapStore.MissingDetailReferenceError({
          taskID: event.data.taskID,
          key: ref.key,
          version: ref.version,
        })
      return yield* invalid(event, event.data.taskID, `Detail ${ref.key}@${ref.version} does not resolve exactly`)
    }
    return undefined
  })

const requireDecisionRef = (
  db: DatabaseService,
  event: AdaptiveEvent.CheckpointSaved,
  ref: AdaptiveOperation.VersionRef,
) =>
  Effect.gen(function* () {
    const detail = yield* db
      .select({ kind: AdaptiveDetailTable.kind })
      .from(AdaptiveDetailTable)
      .where(
        and(
          eq(AdaptiveDetailTable.task_id, event.data.taskID),
          eq(AdaptiveDetailTable.key, ref.key),
          eq(AdaptiveDetailTable.version, ref.version),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    if (detail?.kind !== "decisions")
      return yield* invalid(event, event.data.taskID, `Decision ${ref.key}@${ref.version} does not resolve exactly`)
    return undefined
  })

const invalid = (event: AdaptiveEvent.DurableEvent, taskID: AdaptiveTask.ID, reason: string) =>
  new InvalidRelationshipError({ taskID, eventType: event.type, reason })

const conflict = (taskID: AdaptiveTask.ID, entity: string, reason: string) =>
  new ProjectionConflictError({ taskID, entity, reason })

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
