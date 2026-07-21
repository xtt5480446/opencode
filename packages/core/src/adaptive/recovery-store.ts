export * as AdaptiveRecoveryStore from "./recovery-store"

import { and, eq, getTableColumns, sql } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { AdaptiveEvent } from "@opencode-ai/schema/adaptive-event"
import { AdaptiveOperation } from "@opencode-ai/schema/adaptive-operation"
import { AdaptiveRoadmap } from "@opencode-ai/schema/adaptive-roadmap"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { AdaptiveProjectorIdentity } from "./projector-identity"
import {
  AdaptiveAgentProcessTable,
  AdaptiveAssignmentTable,
  AdaptiveCheckpointTable,
  AdaptiveDetailTable,
  AdaptiveRoadmapRevisionTable,
  AdaptiveTaskTable,
} from "./sql"

export interface AssignmentRecord {
  readonly assignment: AdaptiveOperation.Assignment
  readonly supersededAt?: number
}

export interface CheckpointRecord {
  readonly checkpoint: AdaptiveOperation.Checkpoint
}

export interface SaveCheckpointInput {
  readonly checkpoint: AdaptiveOperation.Checkpoint
  readonly observedHead: string
  readonly observedDiffHash: AdaptiveOperation.Hash
}

export class TaskNotFoundError extends Schema.TaggedErrorClass<TaskNotFoundError>()(
  "AdaptiveRecoveryStore.TaskNotFound",
  { taskID: AdaptiveTask.ID },
) {}

export class AssignmentNotFoundError extends Schema.TaggedErrorClass<AssignmentNotFoundError>()(
  "AdaptiveRecoveryStore.AssignmentNotFound",
  { assignmentID: AdaptiveOperation.AssignmentID },
) {}

export class CheckpointNotFoundError extends Schema.TaggedErrorClass<CheckpointNotFoundError>()(
  "AdaptiveRecoveryStore.CheckpointNotFound",
  { workerID: AdaptiveTask.AgentID, sequence: Schema.Number },
) {}

export class DuplicateAssignmentError extends Schema.TaggedErrorClass<DuplicateAssignmentError>()(
  "AdaptiveRecoveryStore.DuplicateAssignment",
  { assignmentID: AdaptiveOperation.AssignmentID },
) {}

export class InvalidAssignmentError extends Schema.TaggedErrorClass<InvalidAssignmentError>()(
  "AdaptiveRecoveryStore.InvalidAssignment",
  { assignmentID: AdaptiveOperation.AssignmentID, reason: Schema.String },
) {}

export class CorruptAssignmentError extends Schema.TaggedErrorClass<CorruptAssignmentError>()(
  "AdaptiveRecoveryStore.CorruptAssignment",
  { assignmentID: AdaptiveOperation.AssignmentID, reason: Schema.String },
) {}

export class StaleGenerationError extends Schema.TaggedErrorClass<StaleGenerationError>()(
  "AdaptiveRecoveryStore.StaleGeneration",
  { workerID: AdaptiveTask.AgentID, expectedGeneration: Schema.Number, actualGeneration: Schema.Number },
) {}

export class WorkspaceStateMismatchError extends Schema.TaggedErrorClass<WorkspaceStateMismatchError>()(
  "AdaptiveRecoveryStore.WorkspaceStateMismatch",
  {
    workerID: AdaptiveTask.AgentID,
    expectedHead: Schema.String,
    observedHead: Schema.String,
    expectedDiffHash: AdaptiveOperation.Hash,
    observedDiffHash: AdaptiveOperation.Hash,
  },
) {}

export class CheckpointSequenceConflictError extends Schema.TaggedErrorClass<CheckpointSequenceConflictError>()(
  "AdaptiveRecoveryStore.CheckpointSequenceConflict",
  { workerID: AdaptiveTask.AgentID, expectedSequence: Schema.Number, actualSequence: Schema.Number },
) {}

export class CheckpointCursorConflictError extends Schema.TaggedErrorClass<CheckpointCursorConflictError>()(
  "AdaptiveRecoveryStore.CheckpointCursorConflict",
  {
    workerID: AdaptiveTask.AgentID,
    currentCursor: Schema.Number,
    checkpointCursor: Schema.Number,
    eventSequence: Schema.Number,
  },
) {}

export class CorruptCheckpointError extends Schema.TaggedErrorClass<CorruptCheckpointError>()(
  "AdaptiveRecoveryStore.CorruptCheckpoint",
  { workerID: AdaptiveTask.AgentID, sequence: Schema.Number, reason: Schema.String },
) {}

export type AssignmentError =
  | TaskNotFoundError
  | DuplicateAssignmentError
  | InvalidAssignmentError
  | StaleGenerationError

export type CheckpointError =
  | AssignmentNotFoundError
  | CorruptAssignmentError
  | InvalidAssignmentError
  | StaleGenerationError
  | WorkspaceStateMismatchError
  | CheckpointSequenceConflictError
  | CheckpointCursorConflictError

export interface Interface {
  readonly createAssignment: (input: AdaptiveOperation.Assignment) => Effect.Effect<AssignmentRecord, AssignmentError>
  readonly getAssignment: (
    id: AdaptiveOperation.AssignmentID,
  ) => Effect.Effect<AssignmentRecord, AssignmentNotFoundError | CorruptAssignmentError>
  readonly saveCheckpoint: (input: SaveCheckpointInput) => Effect.Effect<CheckpointRecord, CheckpointError>
  readonly getCheckpoint: (
    workerID: AdaptiveTask.AgentID,
    sequence: number,
  ) => Effect.Effect<CheckpointRecord, CheckpointNotFoundError | CorruptCheckpointError>
  readonly getLatestCheckpoint: (
    workerID: AdaptiveTask.AgentID,
  ) => Effect.Effect<CheckpointRecord, CheckpointNotFoundError | CorruptCheckpointError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AdaptiveRecoveryStore") {}

const decodeAssignment = Schema.decodeUnknownSync(AdaptiveOperation.Assignment)
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)
const decodeCheckpoint = Schema.decodeUnknownSync(Schema.fromJsonString(AdaptiveOperation.Checkpoint))
const decodeRoadmap = Schema.decodeUnknownSync(AdaptiveRoadmap.Info)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const getAssignment = Effect.fn("AdaptiveRecoveryStore.getAssignment")(function* (
      id: AdaptiveOperation.AssignmentID,
    ) {
      const row = yield* db
        .select({
          ...getTableColumns(AdaptiveAssignmentTable),
          detail_refs: sql<string>`${AdaptiveAssignmentTable.detail_refs}`,
          permitted_paths: sql<string>`${AdaptiveAssignmentTable.permitted_paths}`,
          acceptance_commands: sql<string>`${AdaptiveAssignmentTable.acceptance_commands}`,
        })
        .from(AdaptiveAssignmentTable)
        .where(eq(AdaptiveAssignmentTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new AssignmentNotFoundError({ assignmentID: id })
      return yield* decodeAssignmentRecord(row)
    })

    const getCheckpoint = Effect.fn("AdaptiveRecoveryStore.getCheckpoint")(function* (
      workerID: AdaptiveTask.AgentID,
      sequence: number,
    ) {
      const row = yield* db
        .select({
          ...getTableColumns(AdaptiveCheckpointTable),
          checkpoint: sql<string>`${AdaptiveCheckpointTable.checkpoint}`,
        })
        .from(AdaptiveCheckpointTable)
        .where(
          and(
            eq(AdaptiveCheckpointTable.worker_id, workerID),
            eq(AdaptiveCheckpointTable.sequence, sequence),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new CheckpointNotFoundError({ workerID, sequence })
      return yield* decodeCheckpointRecord(row)
    })

    const getLatestCheckpoint = Effect.fn("AdaptiveRecoveryStore.getLatestCheckpoint")(function* (
      workerID: AdaptiveTask.AgentID,
    ) {
      const agent = yield* db
        .select({ sequence: AdaptiveAgentProcessTable.checkpoint_sequence })
        .from(AdaptiveAgentProcessTable)
        .where(eq(AdaptiveAgentProcessTable.id, workerID))
        .get()
        .pipe(Effect.orDie)
      if (agent?.sequence === null || agent?.sequence === undefined)
        return yield* new CheckpointNotFoundError({ workerID, sequence: -1 })
      return yield* getCheckpoint(workerID, agent.sequence)
    })

    const createAssignment = Effect.fn("AdaptiveRecoveryStore.createAssignment")(function* (
      assignment: AdaptiveOperation.Assignment,
    ) {
      yield* events
        .publish(
          AdaptiveEvent.AssignmentCreated,
          { taskID: assignment.taskID, timeCreated: assignment.timeCreated, assignment },
          {
            commit: (eventSequence, projectedByEvent) =>
              Effect.gen(function* () {
                const projected = yield* db
                  .select()
                  .from(AdaptiveAssignmentTable)
                  .where(eq(AdaptiveAssignmentTable.id, assignment.id))
                  .get()
                  .pipe(Effect.orDie)
                const projectedWorker = yield* db
                  .select({
                    assignmentID: AdaptiveAgentProcessTable.assignment_id,
                    nodeID: AdaptiveAgentProcessTable.node_id,
                    eventCursor: AdaptiveAgentProcessTable.event_cursor,
                  })
                  .from(AdaptiveAgentProcessTable)
                  .where(eq(AdaptiveAgentProcessTable.id, assignment.workerID))
                  .get()
                  .pipe(Effect.orDie)
                if (
                  projectedByEvent.has(AdaptiveProjectorIdentity) &&
                  projected &&
                  projected.task_id === assignment.taskID &&
                  projected.worker_id === assignment.workerID &&
                  projected.node_id === assignment.nodeID &&
                  projected.generation === assignment.generation &&
                  projected.roadmap_revision === assignment.roadmapRevision &&
                  JSON.stringify(projected.detail_refs) === JSON.stringify(assignment.detailRefs) &&
                  JSON.stringify(projected.permitted_paths) === JSON.stringify(assignment.permittedPaths) &&
                  projected.base_commit === assignment.baseCommit &&
                  JSON.stringify(projected.acceptance_commands) === JSON.stringify(assignment.acceptanceCommands) &&
                  projected.time_created === assignment.timeCreated &&
                  projected.superseded_at === null &&
                  projectedWorker?.assignmentID === assignment.id &&
                  projectedWorker.nodeID === assignment.nodeID &&
                  projectedWorker.eventCursor === eventSequence
                )
                  return undefined
                const task = yield* db
                  .select({ revision: AdaptiveTaskTable.roadmap_revision })
                  .from(AdaptiveTaskTable)
                  .where(eq(AdaptiveTaskTable.id, assignment.taskID))
                  .get()
                  .pipe(Effect.orDie)
                if (!task) return yield* new TaskNotFoundError({ taskID: assignment.taskID })
                if (task.revision !== assignment.roadmapRevision)
                  return yield* new InvalidAssignmentError({
                    assignmentID: assignment.id,
                    reason: `Assignment Roadmap r${assignment.roadmapRevision} does not match current r${task.revision}`,
                  })

                const worker = yield* db
                  .select({
                    taskID: AdaptiveAgentProcessTable.task_id,
                    generation: AdaptiveAgentProcessTable.generation,
                    role: AdaptiveAgentProcessTable.role,
                    assignmentID: AdaptiveAgentProcessTable.assignment_id,
                  })
                  .from(AdaptiveAgentProcessTable)
                  .where(eq(AdaptiveAgentProcessTable.id, assignment.workerID))
                  .get()
                  .pipe(Effect.orDie)
                if (!worker || worker.taskID !== assignment.taskID || worker.role !== "implementation")
                  return yield* new InvalidAssignmentError({
                    assignmentID: assignment.id,
                    reason: "Assignment Worker must be an implementation Agent owned by the same Task",
                  })
                if (worker.generation !== assignment.generation)
                  return yield* new StaleGenerationError({
                    workerID: assignment.workerID,
                    expectedGeneration: assignment.generation,
                    actualGeneration: worker.generation,
                  })
                if (worker.assignmentID !== null)
                  return yield* new InvalidAssignmentError({
                    assignmentID: assignment.id,
                    reason: `Worker already owns Assignment ${worker.assignmentID}`,
                  })

                const roadmap = yield* db
                  .select({ roadmap: AdaptiveRoadmapRevisionTable.roadmap })
                  .from(AdaptiveRoadmapRevisionTable)
                  .where(
                    and(
                      eq(AdaptiveRoadmapRevisionTable.task_id, assignment.taskID),
                      eq(AdaptiveRoadmapRevisionTable.revision, assignment.roadmapRevision),
                    ),
                  )
                  .get()
                  .pipe(Effect.orDie)
                if (!roadmap || !decodeRoadmap(roadmap.roadmap).nodes.some((node) => node.id === assignment.nodeID))
                  return yield* new InvalidAssignmentError({
                    assignmentID: assignment.id,
                    reason: `Assignment node ${assignment.nodeID} is absent from Roadmap r${assignment.roadmapRevision}`,
                  })

                yield* Effect.forEach(
                  assignment.detailRefs,
                  (ref) =>
                    Effect.gen(function* () {
                      const stored = yield* db
                        .select({ kind: AdaptiveDetailTable.kind, status: AdaptiveDetailTable.status })
                        .from(AdaptiveDetailTable)
                        .where(
                          and(
                            eq(AdaptiveDetailTable.task_id, assignment.taskID),
                            eq(AdaptiveDetailTable.key, ref.key),
                            eq(AdaptiveDetailTable.version, ref.version),
                          ),
                        )
                        .get()
                        .pipe(Effect.orDie)
                      if (!stored || stored.kind !== ref.kind || stored.status !== ref.status)
                        return yield* new InvalidAssignmentError({
                          assignmentID: assignment.id,
                          reason: `Assignment Detail ${ref.key}@${ref.version} does not resolve exactly`,
                        })
                      return undefined
                    }),
                  { discard: true },
                )

                const inserted = yield* db
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
                  .onConflictDoNothing()
                  .returning({ id: AdaptiveAssignmentTable.id })
                  .get()
                  .pipe(Effect.orDie)
                if (!inserted) return yield* new DuplicateAssignmentError({ assignmentID: assignment.id })
                yield* db
                  .update(AdaptiveAgentProcessTable)
                  .set({
                    node_id: assignment.nodeID,
                    assignment_id: assignment.id,
                    event_cursor: eventSequence,
                  })
                  .where(
                    and(
                      eq(AdaptiveAgentProcessTable.id, assignment.workerID),
                      eq(AdaptiveAgentProcessTable.generation, assignment.generation),
                    ),
                  )
                  .run()
                  .pipe(Effect.orDie)
                return undefined
              }).pipe(Effect.orDie),
          },
        )
        .pipe(recoverAssignmentError)
      return { assignment }
    })

    const saveCheckpoint = Effect.fn("AdaptiveRecoveryStore.saveCheckpoint")(function* (
      input: SaveCheckpointInput,
    ) {
      if (
        input.checkpoint.worktreeHead !== input.observedHead ||
        input.checkpoint.diffHash !== input.observedDiffHash
      )
        return yield* new WorkspaceStateMismatchError({
          workerID: input.checkpoint.workerID,
          expectedHead: input.checkpoint.worktreeHead,
          observedHead: input.observedHead,
          expectedDiffHash: input.checkpoint.diffHash,
          observedDiffHash: input.observedDiffHash,
        })

      const checkpoint = input.checkpoint
      const assignment = yield* db
        .select({ taskID: AdaptiveAssignmentTable.task_id })
        .from(AdaptiveAssignmentTable)
        .where(eq(AdaptiveAssignmentTable.id, checkpoint.assignmentID))
        .get()
        .pipe(Effect.orDie)
      if (!assignment) return yield* new AssignmentNotFoundError({ assignmentID: checkpoint.assignmentID })

      yield* events
        .publish(
          AdaptiveEvent.CheckpointSaved,
          { taskID: assignment.taskID, timeCreated: checkpoint.timeCreated, checkpoint },
          {
            commit: (eventSequence, projectedByEvent) =>
              Effect.gen(function* () {
                const projected = yield* db
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
                const projectedWorker = yield* db
                  .select({
                    checkpointSequence: AdaptiveAgentProcessTable.checkpoint_sequence,
                    eventCursor: AdaptiveAgentProcessTable.event_cursor,
                  })
                  .from(AdaptiveAgentProcessTable)
                  .where(eq(AdaptiveAgentProcessTable.id, checkpoint.workerID))
                  .get()
                  .pipe(Effect.orDie)
                if (
                  projectedByEvent.has(AdaptiveProjectorIdentity) &&
                  projected &&
                  projected.assignment_id === checkpoint.assignmentID &&
                  projected.generation === checkpoint.generation &&
                  projected.roadmap_revision === checkpoint.roadmapRevision &&
                  JSON.stringify(projected.checkpoint) === JSON.stringify(checkpoint) &&
                  projected.worktree_head === checkpoint.worktreeHead &&
                  projected.diff_hash === checkpoint.diffHash &&
                  projected.event_cursor === checkpoint.eventCursor &&
                  projected.time_created === checkpoint.timeCreated &&
                  projectedWorker?.checkpointSequence === checkpoint.sequence &&
                  projectedWorker.eventCursor === checkpoint.eventCursor
                )
                  return undefined
                const worker = yield* db
                  .select({
                    taskID: AdaptiveAgentProcessTable.task_id,
                    generation: AdaptiveAgentProcessTable.generation,
                    assignmentID: AdaptiveAgentProcessTable.assignment_id,
                    checkpointSequence: AdaptiveAgentProcessTable.checkpoint_sequence,
                    eventCursor: AdaptiveAgentProcessTable.event_cursor,
                  })
                  .from(AdaptiveAgentProcessTable)
                  .where(eq(AdaptiveAgentProcessTable.id, checkpoint.workerID))
                  .get()
                  .pipe(Effect.orDie)
                if (!worker || worker.generation !== checkpoint.generation)
                  return yield* new StaleGenerationError({
                    workerID: checkpoint.workerID,
                    expectedGeneration: checkpoint.generation,
                    actualGeneration: worker?.generation ?? -1,
                  })
                const storedAssignment = (yield* getAssignment(checkpoint.assignmentID)).assignment
                if (
                  storedAssignment.taskID !== worker.taskID ||
                  storedAssignment.workerID !== checkpoint.workerID ||
                  storedAssignment.roadmapRevision !== checkpoint.roadmapRevision ||
                  storedAssignment.nodeID !== checkpoint.nodeID ||
                  worker.assignmentID !== checkpoint.assignmentID
                )
                  return yield* new InvalidAssignmentError({
                    assignmentID: checkpoint.assignmentID,
                    reason: "Checkpoint does not match the Worker's active Assignment tuple",
                  })
                const task = yield* db
                  .select({ revision: AdaptiveTaskTable.roadmap_revision })
                  .from(AdaptiveTaskTable)
                  .where(eq(AdaptiveTaskTable.id, worker.taskID))
                  .get()
                  .pipe(Effect.orDie)
                if (!task || task.revision < checkpoint.roadmapRevision)
                  return yield* new InvalidAssignmentError({
                    assignmentID: checkpoint.assignmentID,
                    reason: "Checkpoint references a Roadmap revision newer than the Task",
                  })
                const expectedSequence = (worker.checkpointSequence ?? 0) + 1
                if (checkpoint.sequence !== expectedSequence)
                  return yield* new CheckpointSequenceConflictError({
                    workerID: checkpoint.workerID,
                    expectedSequence,
                    actualSequence: checkpoint.sequence,
                  })
                if (checkpoint.eventCursor < worker.eventCursor || checkpoint.eventCursor > eventSequence)
                  return yield* new CheckpointCursorConflictError({
                    workerID: checkpoint.workerID,
                    currentCursor: worker.eventCursor,
                    checkpointCursor: checkpoint.eventCursor,
                    eventSequence,
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
                  .set({
                    checkpoint_sequence: checkpoint.sequence,
                    event_cursor: checkpoint.eventCursor,
                  })
                  .where(
                    and(
                      eq(AdaptiveAgentProcessTable.id, checkpoint.workerID),
                      eq(AdaptiveAgentProcessTable.generation, checkpoint.generation),
                    ),
                  )
                  .run()
                  .pipe(Effect.orDie)

                return undefined
              }).pipe(Effect.orDie),
          },
        )
        .pipe(recoverCheckpointError)
      return { checkpoint }
    })

    return Service.of({ createAssignment, getAssignment, saveCheckpoint, getCheckpoint, getLatestCheckpoint })
  }),
)

type AssignmentRow = Omit<
  typeof AdaptiveAssignmentTable.$inferSelect,
  "detail_refs" | "permitted_paths" | "acceptance_commands"
> & {
  readonly detail_refs: string
  readonly permitted_paths: string
  readonly acceptance_commands: string
}

const decodeAssignmentRecord = (row: AssignmentRow) =>
  Effect.try({
    try: (): AssignmentRecord => ({
      assignment: decodeAssignment({
        id: row.id,
        taskID: row.task_id,
        workerID: row.worker_id,
        nodeID: row.node_id,
        roadmapRevision: row.roadmap_revision,
        detailRefs: decodeJson(row.detail_refs),
        permittedPaths: decodeJson(row.permitted_paths),
        baseCommit: row.base_commit,
        acceptanceCommands: decodeJson(row.acceptance_commands),
        generation: row.generation,
        timeCreated: row.time_created,
      }),
      ...(row.superseded_at === null ? {} : { supersededAt: row.superseded_at }),
    }),
    catch: (cause) =>
      new CorruptAssignmentError({
        assignmentID: row.id,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })

type CheckpointRow = Omit<typeof AdaptiveCheckpointTable.$inferSelect, "checkpoint"> & {
  readonly checkpoint: string
}

const decodeCheckpointRecord = (row: CheckpointRow) =>
  Effect.try({
    try: (): CheckpointRecord => {
      const checkpoint = decodeCheckpoint(row.checkpoint)
      if (
        checkpoint.workerID !== row.worker_id ||
        checkpoint.sequence !== row.sequence ||
        checkpoint.assignmentID !== row.assignment_id ||
        checkpoint.generation !== row.generation ||
        checkpoint.roadmapRevision !== row.roadmap_revision ||
        checkpoint.worktreeHead !== row.worktree_head ||
        checkpoint.diffHash !== row.diff_hash ||
        checkpoint.eventCursor !== row.event_cursor ||
        checkpoint.timeCreated !== row.time_created
      )
        throw new Error("Checkpoint JSON disagrees with normalized columns")
      return { checkpoint }
    },
    catch: (cause) =>
      new CorruptCheckpointError({
        workerID: row.worker_id,
        sequence: row.sequence,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })

const recoverAssignmentError = <A>(effect: Effect.Effect<A>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = Cause.squash(cause)
      if (isAssignmentError(defect)) return Effect.fail(defect)
      return Effect.failCause(cause)
    }),
  )

const recoverCheckpointError = <A>(effect: Effect.Effect<A>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = Cause.squash(cause)
      if (isCheckpointError(defect)) return Effect.fail(defect)
      return Effect.failCause(cause)
    }),
  )

function isAssignmentError(value: unknown): value is AssignmentError {
  return (
    value instanceof TaskNotFoundError ||
    value instanceof DuplicateAssignmentError ||
    value instanceof InvalidAssignmentError ||
    value instanceof StaleGenerationError
  )
}

function isCheckpointError(value: unknown): value is CheckpointError {
  return (
    value instanceof AssignmentNotFoundError ||
    value instanceof CorruptAssignmentError ||
    value instanceof InvalidAssignmentError ||
    value instanceof StaleGenerationError ||
    value instanceof WorkspaceStateMismatchError ||
    value instanceof CheckpointSequenceConflictError ||
    value instanceof CheckpointCursorConflictError
  )
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
