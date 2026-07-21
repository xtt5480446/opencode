export * as AdaptiveRoadmapStore from "./roadmap-store"

import { and, eq, getTableColumns, sql } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer, Schema } from "effect"
import { AdaptiveEvent } from "@opencode-ai/schema/adaptive-event"
import { AdaptiveOperation } from "@opencode-ai/schema/adaptive-operation"
import { AdaptiveRoadmap } from "@opencode-ai/schema/adaptive-roadmap"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Hash } from "../util/hash"
import {
  AdaptiveAgentProcessTable,
  AdaptiveDetailTable,
  AdaptiveRoadmapRevisionTable,
  AdaptiveTaskTable,
} from "./sql"

export interface CommitInput {
  readonly expectedRevision: number
  readonly roadmap: AdaptiveRoadmap.Info
  readonly details: readonly AdaptiveEvent.DetailRecord[]
  readonly sourceAgentID: AdaptiveTask.AgentID
  readonly sourceGeneration: number
}

export interface RoadmapRecord {
  readonly roadmap: AdaptiveRoadmap.Info
  readonly contentHash: AdaptiveOperation.Hash
  readonly sourceAgentID: AdaptiveTask.AgentID
  readonly sourceGeneration: number
  readonly eventSequence: number
  readonly timeCreated: number
}

export interface DetailRecord extends AdaptiveEvent.DetailRecord {
  readonly taskID: AdaptiveTask.ID
  readonly sourceAgentID: AdaptiveTask.AgentID
  readonly sourceGeneration: number
  readonly timeCreated: number
}

export class TaskNotFoundError extends Schema.TaggedErrorClass<TaskNotFoundError>()(
  "AdaptiveRoadmapStore.TaskNotFound",
  { taskID: AdaptiveTask.ID },
) {}

export class RoadmapNotFoundError extends Schema.TaggedErrorClass<RoadmapNotFoundError>()(
  "AdaptiveRoadmapStore.RoadmapNotFound",
  { taskID: AdaptiveTask.ID, revision: Schema.Number },
) {}

export class DetailNotFoundError extends Schema.TaggedErrorClass<DetailNotFoundError>()(
  "AdaptiveRoadmapStore.DetailNotFound",
  { taskID: AdaptiveTask.ID, key: Schema.String, version: Schema.Number },
) {}

export class StaleRevisionError extends Schema.TaggedErrorClass<StaleRevisionError>()(
  "AdaptiveRoadmapStore.StaleRevision",
  { taskID: AdaptiveTask.ID, expectedRevision: Schema.Number, actualRevision: Schema.Number },
) {}

export class InvalidRoadmapError extends Schema.TaggedErrorClass<InvalidRoadmapError>()(
  "AdaptiveRoadmapStore.InvalidRoadmap",
  { taskID: AdaptiveTask.ID, reason: Schema.String },
) {}

export class InvalidDetailError extends Schema.TaggedErrorClass<InvalidDetailError>()(
  "AdaptiveRoadmapStore.InvalidDetail",
  { taskID: AdaptiveTask.ID, key: Schema.String, version: Schema.Number, reason: Schema.String },
) {}

export class ImmutableDetailConflictError extends Schema.TaggedErrorClass<ImmutableDetailConflictError>()(
  "AdaptiveRoadmapStore.ImmutableDetailConflict",
  { taskID: AdaptiveTask.ID, key: Schema.String, version: Schema.Number },
) {}

export class MissingDetailReferenceError extends Schema.TaggedErrorClass<MissingDetailReferenceError>()(
  "AdaptiveRoadmapStore.MissingDetailReference",
  { taskID: AdaptiveTask.ID, key: Schema.String, version: Schema.Number },
) {}

export class SourceGenerationMismatchError extends Schema.TaggedErrorClass<SourceGenerationMismatchError>()(
  "AdaptiveRoadmapStore.SourceGenerationMismatch",
  { agentID: AdaptiveTask.AgentID, expectedGeneration: Schema.Number, actualGeneration: Schema.Number },
) {}

export class CorruptRoadmapError extends Schema.TaggedErrorClass<CorruptRoadmapError>()(
  "AdaptiveRoadmapStore.CorruptRoadmap",
  { taskID: AdaptiveTask.ID, revision: Schema.Number, reason: Schema.String },
) {}

export class CorruptDetailError extends Schema.TaggedErrorClass<CorruptDetailError>()(
  "AdaptiveRoadmapStore.CorruptDetail",
  { taskID: AdaptiveTask.ID, key: Schema.String, version: Schema.Number, reason: Schema.String },
) {}

export type CommitError =
  | TaskNotFoundError
  | StaleRevisionError
  | InvalidRoadmapError
  | InvalidDetailError
  | ImmutableDetailConflictError
  | MissingDetailReferenceError
  | SourceGenerationMismatchError

export interface Interface {
  readonly commit: (input: CommitInput) => Effect.Effect<RoadmapRecord, CommitError>
  readonly getCurrent: (
    taskID: AdaptiveTask.ID,
  ) => Effect.Effect<RoadmapRecord, TaskNotFoundError | RoadmapNotFoundError | CorruptRoadmapError>
  readonly getRevision: (
    taskID: AdaptiveTask.ID,
    revision: number,
  ) => Effect.Effect<RoadmapRecord, RoadmapNotFoundError | CorruptRoadmapError>
  readonly getDetail: (
    taskID: AdaptiveTask.ID,
    key: string,
    version: number,
  ) => Effect.Effect<DetailRecord, DetailNotFoundError | CorruptDetailError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AdaptiveRoadmapStore") {}

const encodeRoadmap = Schema.encodeUnknownSync(AdaptiveRoadmap.Info)
const decodeRoadmap = Schema.decodeUnknownSync(Schema.fromJsonString(AdaptiveRoadmap.Info))
const decodeRequirement = Schema.decodeUnknownSync(Schema.fromJsonString(AdaptiveRoadmap.RequirementBaseline))
const decodeDetailRef = Schema.decodeUnknownSync(AdaptiveRoadmap.DetailRef)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const getRevision = Effect.fn("AdaptiveRoadmapStore.getRevision")(function* (
      taskID: AdaptiveTask.ID,
      revision: number,
    ) {
      const row = yield* db
        .select({
          ...getTableColumns(AdaptiveRoadmapRevisionTable),
          requirement: sql<string>`${AdaptiveRoadmapRevisionTable.requirement}`,
          roadmap: sql<string>`${AdaptiveRoadmapRevisionTable.roadmap}`,
        })
        .from(AdaptiveRoadmapRevisionTable)
        .where(
          and(
            eq(AdaptiveRoadmapRevisionTable.task_id, taskID),
            eq(AdaptiveRoadmapRevisionTable.revision, revision),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new RoadmapNotFoundError({ taskID, revision })
      return yield* decodeRoadmapRecord(row)
    })

    const getCurrent = Effect.fn("AdaptiveRoadmapStore.getCurrent")(function* (taskID: AdaptiveTask.ID) {
      const task = yield* db
        .select({ revision: AdaptiveTaskTable.roadmap_revision })
        .from(AdaptiveTaskTable)
        .where(eq(AdaptiveTaskTable.id, taskID))
        .get()
        .pipe(Effect.orDie)
      if (!task) return yield* new TaskNotFoundError({ taskID })
      return yield* getRevision(taskID, task.revision)
    })

    const getDetail = Effect.fn("AdaptiveRoadmapStore.getDetail")(function* (
      taskID: AdaptiveTask.ID,
      key: string,
      version: number,
    ) {
      const row = yield* db
        .select()
        .from(AdaptiveDetailTable)
        .where(
          and(
            eq(AdaptiveDetailTable.task_id, taskID),
            eq(AdaptiveDetailTable.key, key),
            eq(AdaptiveDetailTable.version, version),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new DetailNotFoundError({ taskID, key, version })
      return yield* decodeDetailRecord(row)
    })

    const commit = Effect.fn("AdaptiveRoadmapStore.commit")(function* (input: CommitInput) {
      const invalid = validateInput(input)
      if (invalid) return yield* invalid
      const now = yield* Clock.currentTimeMillis
      const encoded = encodeRoadmap(input.roadmap)
      const contentHash = digest(JSON.stringify(encoded))

      const published = yield* events
        .publish(
          AdaptiveEvent.RoadmapCommitted,
          {
            taskID: input.roadmap.taskID,
            timeCreated: now,
            roadmap: input.roadmap,
            details: input.details,
            contentHash,
            sourceAgentID: input.sourceAgentID,
            sourceGeneration: input.sourceGeneration,
          },
          {
            commit: (eventSequence) =>
              Effect.gen(function* () {
                const task = yield* db
                  .select({ revision: AdaptiveTaskTable.roadmap_revision })
                  .from(AdaptiveTaskTable)
                  .where(eq(AdaptiveTaskTable.id, input.roadmap.taskID))
                  .get()
                  .pipe(Effect.orDie)
                if (!task) return yield* new TaskNotFoundError({ taskID: input.roadmap.taskID })
                if (task.revision !== input.expectedRevision)
                  return yield* new StaleRevisionError({
                    taskID: input.roadmap.taskID,
                    expectedRevision: input.expectedRevision,
                    actualRevision: task.revision,
                  })

                const agent = yield* db
                  .select({ taskID: AdaptiveAgentProcessTable.task_id, generation: AdaptiveAgentProcessTable.generation })
                  .from(AdaptiveAgentProcessTable)
                  .where(eq(AdaptiveAgentProcessTable.id, input.sourceAgentID))
                  .get()
                  .pipe(Effect.orDie)
                if (
                  !agent ||
                  agent.taskID !== input.roadmap.taskID ||
                  agent.generation !== input.sourceGeneration
                )
                  return yield* new SourceGenerationMismatchError({
                    agentID: input.sourceAgentID,
                    expectedGeneration: input.sourceGeneration,
                    actualGeneration: agent?.generation ?? -1,
                  })

                yield* Effect.forEach(input.details, (detail) => insertDetail(input, detail, now), {
                  discard: true,
                })
                yield* verifyReferences(input.roadmap)

                yield* db
                  .insert(AdaptiveRoadmapRevisionTable)
                  .values({
                    task_id: input.roadmap.taskID,
                    revision: input.roadmap.revision,
                    requirement: input.roadmap.requirement,
                    roadmap: input.roadmap,
                    content_hash: contentHash,
                    source_agent_id: input.sourceAgentID,
                    source_generation: input.sourceGeneration,
                    event_sequence: eventSequence,
                    time_created: now,
                  })
                  .run()
                  .pipe(Effect.orDie)
                const updated = yield* db
                  .update(AdaptiveTaskTable)
                  .set({ roadmap_revision: input.roadmap.revision, time_updated: now })
                  .where(
                    and(
                      eq(AdaptiveTaskTable.id, input.roadmap.taskID),
                      eq(AdaptiveTaskTable.roadmap_revision, input.expectedRevision),
                    ),
                  )
                  .returning({ id: AdaptiveTaskTable.id })
                  .get()
                  .pipe(Effect.orDie)
                if (!updated)
                  return yield* new StaleRevisionError({
                    taskID: input.roadmap.taskID,
                    expectedRevision: input.expectedRevision,
                    actualRevision: task.revision,
                  })
                return undefined
              }).pipe(Effect.orDie),
          },
        )
        .pipe(recoverCommitError)

      if (!published.durable) return yield* Effect.die("Adaptive Roadmap event was not committed durably")
      return {
        roadmap: input.roadmap,
        contentHash,
        sourceAgentID: input.sourceAgentID,
        sourceGeneration: input.sourceGeneration,
        eventSequence: published.durable.seq,
        timeCreated: now,
      }
    })

    const insertDetail = (input: CommitInput, detail: AdaptiveEvent.DetailRecord, now: number) =>
      Effect.gen(function* () {
        const existing = yield* db
          .select()
          .from(AdaptiveDetailTable)
          .where(
            and(
              eq(AdaptiveDetailTable.task_id, input.roadmap.taskID),
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
          return yield* new ImmutableDetailConflictError({
            taskID: input.roadmap.taskID,
            key: detail.ref.key,
            version: detail.ref.version,
          })
        }
        yield* db
          .insert(AdaptiveDetailTable)
          .values({
            task_id: input.roadmap.taskID,
            key: detail.ref.key,
            version: detail.ref.version,
            node_id: detail.nodeID,
            kind: detail.ref.kind,
            status: detail.ref.status,
            body: detail.body,
            content_hash: detail.contentHash,
            source_agent_id: input.sourceAgentID,
            source_generation: input.sourceGeneration,
            time_created: now,
          })
          .run()
          .pipe(Effect.orDie)
        return undefined
      })

    const verifyReferences = (roadmap: AdaptiveRoadmap.Info) =>
      Effect.forEach(
        roadmap.nodes.flatMap((node) => [
          ...node.details.map((ref) => ({ ref, nodeID: node.id })),
          ...node.interfaces.map((item) => ({
            ref: new AdaptiveRoadmap.DetailRef({
              key: item.key,
              kind: "contracts",
              version: item.version,
              status: item.state,
            }),
            nodeID: node.id,
          })),
        ]),
        ({ ref }) =>
          Effect.gen(function* () {
            const stored = yield* db
              .select({ kind: AdaptiveDetailTable.kind, status: AdaptiveDetailTable.status })
              .from(AdaptiveDetailTable)
              .where(
                and(
                  eq(AdaptiveDetailTable.task_id, roadmap.taskID),
                  eq(AdaptiveDetailTable.key, ref.key),
                  eq(AdaptiveDetailTable.version, ref.version),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!stored || stored.kind !== ref.kind || stored.status !== ref.status)
              return yield* new MissingDetailReferenceError({
                taskID: roadmap.taskID,
                key: ref.key,
                version: ref.version,
              })
            return undefined
          }),
        { discard: true },
      )

    return Service.of({ commit, getCurrent, getRevision, getDetail })
  }),
)

function validateInput(input: CommitInput): CommitError | undefined {
  if (input.expectedRevision < 0 || input.roadmap.revision !== input.expectedRevision + 1)
    return new InvalidRoadmapError({
      taskID: input.roadmap.taskID,
      reason: `Roadmap revision ${input.roadmap.revision} must follow expected revision ${input.expectedRevision}`,
    })
  const nodeIDs = new Set(input.roadmap.nodes.map((node) => node.id))
  if (nodeIDs.size !== input.roadmap.nodes.length)
    return new InvalidRoadmapError({ taskID: input.roadmap.taskID, reason: "Roadmap node IDs must be unique" })
  const versions = new Set<string>()
  for (const detail of input.details) {
    const key = `${detail.ref.key}\u0000${detail.ref.version}`
    if (versions.has(key))
      return new InvalidDetailError({
        taskID: input.roadmap.taskID,
        key: detail.ref.key,
        version: detail.ref.version,
        reason: "Commit contains the same Detail version more than once",
      })
    versions.add(key)
    if (!nodeIDs.has(detail.nodeID))
      return new InvalidDetailError({
        taskID: input.roadmap.taskID,
        key: detail.ref.key,
        version: detail.ref.version,
        reason: `Detail node ${detail.nodeID} is absent from the Roadmap`,
      })
    if (detail.contentHash !== digest(detail.body))
      return new InvalidDetailError({
        taskID: input.roadmap.taskID,
        key: detail.ref.key,
        version: detail.ref.version,
        reason: "Detail content hash does not match its body",
      })
  }
  return undefined
}

type RoadmapRow = Omit<typeof AdaptiveRoadmapRevisionTable.$inferSelect, "requirement" | "roadmap"> & {
  readonly requirement: string
  readonly roadmap: string
}

const decodeRoadmapRecord = (row: RoadmapRow) =>
  Effect.try({
    try: (): RoadmapRecord => {
      const roadmap = decodeRoadmap(row.roadmap)
      const requirement = decodeRequirement(row.requirement)
      if (roadmap.taskID !== row.task_id || roadmap.revision !== row.revision)
        throw new Error("Roadmap identity disagrees with normalized columns")
      if (JSON.stringify(roadmap.requirement) !== JSON.stringify(requirement))
        throw new Error("Roadmap Requirement disagrees with its normalized copy")
      if (digest(JSON.stringify(encodeRoadmap(roadmap))) !== row.content_hash)
        throw new Error("Roadmap content does not match its SHA-256")
      return {
        roadmap,
        contentHash: row.content_hash,
        sourceAgentID: row.source_agent_id,
        sourceGeneration: row.source_generation,
        eventSequence: row.event_sequence,
        timeCreated: row.time_created,
      }
    },
    catch: (cause) =>
      new CorruptRoadmapError({
        taskID: row.task_id,
        revision: row.revision,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })

const decodeDetailRecord = (row: typeof AdaptiveDetailTable.$inferSelect) =>
  Effect.try({
    try: (): DetailRecord => {
      if (digest(row.body) !== row.content_hash) throw new Error("Detail body does not match its SHA-256")
      return {
        taskID: row.task_id,
        nodeID: row.node_id,
        ref: decodeDetailRef({ key: row.key, version: row.version, kind: row.kind, status: row.status }),
        body: row.body,
        contentHash: row.content_hash,
        sourceAgentID: row.source_agent_id,
        sourceGeneration: row.source_generation,
        timeCreated: row.time_created,
      }
    },
    catch: (cause) =>
      new CorruptDetailError({
        taskID: row.task_id,
        key: row.key,
        version: row.version,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })

const digest = (value: string) => AdaptiveOperation.Hash.make(`sha256:${Hash.sha256(value)}`)

const recoverCommitError = <A>(effect: Effect.Effect<A>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = Cause.squash(cause)
      if (isCommitError(defect)) return Effect.fail(defect)
      return Effect.failCause(cause)
    }),
  )

function isCommitError(value: unknown): value is CommitError {
  return (
    value instanceof TaskNotFoundError ||
    value instanceof StaleRevisionError ||
    value instanceof InvalidRoadmapError ||
    value instanceof InvalidDetailError ||
    value instanceof ImmutableDetailConflictError ||
    value instanceof MissingDetailReferenceError ||
    value instanceof SourceGenerationMismatchError
  )
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, EventV2.node] })
