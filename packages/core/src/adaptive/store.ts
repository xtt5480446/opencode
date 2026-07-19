export * as AdaptiveStore from "./store"

import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { AdaptiveModelPolicy } from "./model-policy"
import { AdaptiveTaskTable } from "./sql"

export interface CreateTaskInput {
  readonly id: AdaptiveTask.ID
  readonly directory: string
  readonly mode: AdaptiveTask.Mode
  readonly status: AdaptiveTask.Status
  readonly requirement: string
  readonly modelPolicy: AdaptiveTask.ModelPolicy
  readonly roadmapRevision: number
  readonly baseSnapshotHash: string
}

export interface TaskRecord extends CreateTaskInput {
  readonly timeCreated: number
  readonly timeUpdated: number
}

export class DuplicateTaskError extends Schema.TaggedErrorClass<DuplicateTaskError>()(
  "AdaptiveStore.DuplicateTask",
  { taskID: AdaptiveTask.ID },
) {}

export class TaskNotFoundError extends Schema.TaggedErrorClass<TaskNotFoundError>()("AdaptiveStore.TaskNotFound", {
  taskID: AdaptiveTask.ID,
}) {}

export class CorruptModelPolicyError extends Schema.TaggedErrorClass<CorruptModelPolicyError>()(
  "AdaptiveStore.CorruptModelPolicy",
  { taskID: AdaptiveTask.ID, cause: Schema.Defect() },
) {}

export interface Interface {
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<TaskRecord, DuplicateTaskError>
  readonly getTask: (id: AdaptiveTask.ID) => Effect.Effect<TaskRecord, TaskNotFoundError | CorruptModelPolicyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AdaptiveStore") {}

const taskPolicy = (row: typeof AdaptiveTaskTable.$inferSelect) =>
  AdaptiveTask.ModelPolicy.make({
    providerID: Provider.ID.make(row.provider_id),
    modelID: Model.ID.make(row.model_id),
    ...(row.variant === null ? {} : { variant: Model.VariantID.make(row.variant) }),
    effectiveContextLimit: row.effective_context_limit,
    outputReserve: row.output_reserve,
    safetyReserve: row.safety_reserve,
    hash: row.model_policy_hash,
  })

const taskRecord = (row: typeof AdaptiveTaskTable.$inferSelect): TaskRecord => {
  const modelPolicy = taskPolicy(row)
  AdaptiveModelPolicy.assertEqual(modelPolicy, modelPolicy)
  return {
    id: row.id,
    directory: row.directory,
    mode: row.mode,
    status: row.status,
    requirement: row.requirement,
    modelPolicy,
    roadmapRevision: row.roadmap_revision,
    baseSnapshotHash: row.base_snapshot_hash,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  }
}

const decodeTask = (row: typeof AdaptiveTaskTable.$inferSelect) =>
  Effect.try({
    try: () => taskRecord(row),
    catch: (cause) => new CorruptModelPolicyError({ taskID: row.id, cause }),
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const getTask = Effect.fn("AdaptiveStore.getTask")(function* (id: AdaptiveTask.ID) {
      const row = yield* db
        .select()
        .from(AdaptiveTaskTable)
        .where(eq(AdaptiveTaskTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new TaskNotFoundError({ taskID: id })
      return yield* decodeTask(row)
    })

    const createTask = Effect.fn("AdaptiveStore.createTask")(function* (input: CreateTaskInput) {
      AdaptiveModelPolicy.assertEqual(input.modelPolicy, input.modelPolicy)
      const now = yield* Clock.currentTimeMillis
      const row = yield* db
        .insert(AdaptiveTaskTable)
        .values({
          id: input.id,
          directory: input.directory,
          mode: input.mode,
          status: input.status,
          requirement: input.requirement,
          provider_id: input.modelPolicy.providerID,
          model_id: input.modelPolicy.modelID,
          variant: input.modelPolicy.variant,
          effective_context_limit: input.modelPolicy.effectiveContextLimit,
          output_reserve: input.modelPolicy.outputReserve,
          safety_reserve: input.modelPolicy.safetyReserve,
          model_policy_hash: input.modelPolicy.hash,
          roadmap_revision: input.roadmapRevision,
          base_snapshot_hash: input.baseSnapshotHash,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new DuplicateTaskError({ taskID: input.id })
      return taskRecord(row)
    })

    return Service.of({ createTask, getTask })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
