export * as AdaptiveStore from "./store"

import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { AdaptiveModelPolicy } from "./model-policy"
import { AdaptiveAgentProcessTable, AdaptiveTaskTable, type AdaptiveAgentState } from "./sql"

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

export interface CreateAgentInput {
  readonly id: AdaptiveTask.AgentID
  readonly taskID: AdaptiveTask.ID
  readonly role: AdaptiveTask.Role
}

export interface AgentRecord extends CreateAgentInput {
  readonly generation: number
  readonly state: AdaptiveAgentState
  readonly owner?: string
  readonly pid?: number
  readonly leaseExpiresAt?: number
  readonly exitCode?: number
  readonly exitReason?: string
  readonly timeCreated: number
  readonly timeUpdated: number
}

export interface ClaimAgentInput {
  readonly agentID: AdaptiveTask.AgentID
  readonly expectedGeneration: number
  readonly owner: string
  readonly pid: number
  readonly leaseDurationMs: number
}

export interface HeartbeatInput {
  readonly agentID: AdaptiveTask.AgentID
  readonly generation: number
  readonly owner: string
  readonly leaseDurationMs: number
}

export interface SettleAgentInput {
  readonly agentID: AdaptiveTask.AgentID
  readonly generation: number
  readonly owner: string
  readonly state: "stopped" | "lost" | "failed"
  readonly exitCode?: number
  readonly exitReason?: string
}

export class DuplicateTaskError extends Schema.TaggedErrorClass<DuplicateTaskError>()("AdaptiveStore.DuplicateTask", {
  taskID: AdaptiveTask.ID,
}) {}

export class TaskNotFoundError extends Schema.TaggedErrorClass<TaskNotFoundError>()("AdaptiveStore.TaskNotFound", {
  taskID: AdaptiveTask.ID,
}) {}

export class CorruptModelPolicyError extends Schema.TaggedErrorClass<CorruptModelPolicyError>()(
  "AdaptiveStore.CorruptModelPolicy",
  { taskID: AdaptiveTask.ID, cause: Schema.Defect() },
) {}

export class DuplicateAgentError extends Schema.TaggedErrorClass<DuplicateAgentError>()(
  "AdaptiveStore.DuplicateAgent",
  {
    agentID: AdaptiveTask.AgentID,
  },
) {}

export class AgentNotFoundError extends Schema.TaggedErrorClass<AgentNotFoundError>()("AdaptiveStore.AgentNotFound", {
  agentID: AdaptiveTask.AgentID,
}) {}

export class InvalidLeaseError extends Schema.TaggedErrorClass<InvalidLeaseError>()("AdaptiveStore.InvalidLease", {
  agentID: AdaptiveTask.AgentID,
  reason: Schema.String,
}) {}

export class AgentClaimConflictError extends Schema.TaggedErrorClass<AgentClaimConflictError>()(
  "AdaptiveStore.AgentClaimConflict",
  {
    agentID: AdaptiveTask.AgentID,
    expectedGeneration: Schema.Number,
    actualGeneration: Schema.Number,
  },
) {}

export class AgentOwnershipConflictError extends Schema.TaggedErrorClass<AgentOwnershipConflictError>()(
  "AdaptiveStore.AgentOwnershipConflict",
  {
    agentID: AdaptiveTask.AgentID,
    generation: Schema.Number,
    owner: Schema.String,
  },
) {}

export interface Interface {
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<TaskRecord, DuplicateTaskError>
  readonly getTask: (id: AdaptiveTask.ID) => Effect.Effect<TaskRecord, TaskNotFoundError | CorruptModelPolicyError>
  readonly createAgent: (input: CreateAgentInput) => Effect.Effect<AgentRecord, DuplicateAgentError | TaskNotFoundError>
  readonly getAgent: (id: AdaptiveTask.AgentID) => Effect.Effect<AgentRecord, AgentNotFoundError>
  readonly claimAgent: (
    input: ClaimAgentInput,
  ) => Effect.Effect<AgentRecord, InvalidLeaseError | AgentNotFoundError | AgentClaimConflictError>
  readonly heartbeat: (
    input: HeartbeatInput,
  ) => Effect.Effect<AgentRecord, InvalidLeaseError | AgentNotFoundError | AgentOwnershipConflictError>
  readonly settleAgent: (
    input: SettleAgentInput,
  ) => Effect.Effect<AgentRecord, AgentNotFoundError | AgentOwnershipConflictError>
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

const agentRecord = (row: typeof AdaptiveAgentProcessTable.$inferSelect): AgentRecord => ({
  id: row.id,
  taskID: row.task_id,
  role: row.role,
  generation: row.generation,
  state: row.state,
  ...(row.owner === null ? {} : { owner: row.owner }),
  ...(row.pid === null ? {} : { pid: row.pid }),
  ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
  ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
  ...(row.exit_reason === null ? {} : { exitReason: row.exit_reason }),
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
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

    const getAgent = Effect.fn("AdaptiveStore.getAgent")(function* (id: AdaptiveTask.AgentID) {
      const row = yield* db
        .select()
        .from(AdaptiveAgentProcessTable)
        .where(eq(AdaptiveAgentProcessTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new AgentNotFoundError({ agentID: id })
      return agentRecord(row)
    })

    const createAgent = Effect.fn("AdaptiveStore.createAgent")(function* (input: CreateAgentInput) {
      const now = yield* Clock.currentTimeMillis
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const parent = yield* tx
              .select({ id: AdaptiveTaskTable.id })
              .from(AdaptiveTaskTable)
              .where(eq(AdaptiveTaskTable.id, input.taskID))
              .get()
              .pipe(Effect.orDie)
            if (!parent) return yield* new TaskNotFoundError({ taskID: input.taskID })
            const row = yield* tx
              .insert(AdaptiveAgentProcessTable)
              .values({
                id: input.id,
                task_id: input.taskID,
                role: input.role,
                generation: 0,
                state: "idle",
                time_created: now,
                time_updated: now,
              })
              .onConflictDoNothing()
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* new DuplicateAgentError({ agentID: input.id })
            return agentRecord(row)
          }),
        )
        .pipe(Effect.catchTag("SqlError", (cause) => Effect.die(cause)))
    })

    const invalidLease = (input: {
      agentID: AdaptiveTask.AgentID
      owner: string
      leaseDurationMs: number
      pid?: number
    }) => {
      if (input.owner.length === 0) return new InvalidLeaseError({ agentID: input.agentID, reason: "owner is empty" })
      if (input.leaseDurationMs <= 0 || !Number.isSafeInteger(input.leaseDurationMs))
        return new InvalidLeaseError({ agentID: input.agentID, reason: "lease duration must be a positive integer" })
      if (input.pid !== undefined && (input.pid <= 0 || !Number.isSafeInteger(input.pid)))
        return new InvalidLeaseError({ agentID: input.agentID, reason: "pid must be a positive integer" })
    }

    const claimConflict = Effect.fnUntraced(function* (input: ClaimAgentInput) {
      const row = yield* db
        .select({ generation: AdaptiveAgentProcessTable.generation })
        .from(AdaptiveAgentProcessTable)
        .where(eq(AdaptiveAgentProcessTable.id, input.agentID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new AgentNotFoundError({ agentID: input.agentID })
      return yield* new AgentClaimConflictError({
        agentID: input.agentID,
        expectedGeneration: input.expectedGeneration,
        actualGeneration: row.generation,
      })
    })

    const ownershipConflict = Effect.fnUntraced(function* (input: {
      agentID: AdaptiveTask.AgentID
      generation: number
      owner: string
    }) {
      const row = yield* db
        .select({ id: AdaptiveAgentProcessTable.id })
        .from(AdaptiveAgentProcessTable)
        .where(eq(AdaptiveAgentProcessTable.id, input.agentID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new AgentNotFoundError({ agentID: input.agentID })
      return yield* new AgentOwnershipConflictError(input)
    })

    const claimAgent = Effect.fn("AdaptiveStore.claimAgent")(function* (input: ClaimAgentInput) {
      const invalid = invalidLease(input)
      if (invalid) return yield* invalid
      if (input.expectedGeneration < 0 || !Number.isSafeInteger(input.expectedGeneration))
        return yield* new InvalidLeaseError({
          agentID: input.agentID,
          reason: "expected generation must be a nonnegative integer",
        })
      const now = yield* Clock.currentTimeMillis
      const row = yield* db
        .update(AdaptiveAgentProcessTable)
        .set({
          generation: sql`${AdaptiveAgentProcessTable.generation} + 1`,
          state: "starting",
          owner: input.owner,
          pid: input.pid,
          lease_expires_at: now + input.leaseDurationMs,
          exit_code: null,
          exit_reason: null,
          time_updated: now,
        })
        .where(
          and(
            eq(AdaptiveAgentProcessTable.id, input.agentID),
            eq(AdaptiveAgentProcessTable.generation, input.expectedGeneration),
            or(isNull(AdaptiveAgentProcessTable.owner), lte(AdaptiveAgentProcessTable.lease_expires_at, now)),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* claimConflict(input)
      return agentRecord(row)
    })

    const heartbeat = Effect.fn("AdaptiveStore.heartbeat")(function* (input: HeartbeatInput) {
      const invalid = invalidLease(input)
      if (invalid) return yield* invalid
      const now = yield* Clock.currentTimeMillis
      const row = yield* db
        .update(AdaptiveAgentProcessTable)
        .set({ state: "running", lease_expires_at: now + input.leaseDurationMs, time_updated: now })
        .where(
          and(
            eq(AdaptiveAgentProcessTable.id, input.agentID),
            eq(AdaptiveAgentProcessTable.generation, input.generation),
            eq(AdaptiveAgentProcessTable.owner, input.owner),
            inArray(AdaptiveAgentProcessTable.state, ["starting", "running"]),
            gt(AdaptiveAgentProcessTable.lease_expires_at, now),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* ownershipConflict(input)
      return agentRecord(row)
    })

    const settleAgent = Effect.fn("AdaptiveStore.settleAgent")(function* (input: SettleAgentInput) {
      const now = yield* Clock.currentTimeMillis
      const row = yield* db
        .update(AdaptiveAgentProcessTable)
        .set({
          state: input.state,
          owner: null,
          pid: null,
          lease_expires_at: null,
          exit_code: input.exitCode ?? null,
          exit_reason: input.exitReason ?? null,
          time_updated: now,
        })
        .where(
          and(
            eq(AdaptiveAgentProcessTable.id, input.agentID),
            eq(AdaptiveAgentProcessTable.generation, input.generation),
            eq(AdaptiveAgentProcessTable.owner, input.owner),
            inArray(AdaptiveAgentProcessTable.state, ["starting", "running"]),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* ownershipConflict(input)
      return agentRecord(row)
    })

    return Service.of({ createTask, getTask, createAgent, getAgent, claimAgent, heartbeat, settleAgent })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
