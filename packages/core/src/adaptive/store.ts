export * as AdaptiveStore from "./store"

import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { AdaptiveModelPolicy } from "./model-policy"
import {
  AdaptiveAgentProcessTable,
  AdaptiveContextManifestTable,
  AdaptiveModelRequestTable,
  AdaptiveTaskTable,
  type AdaptiveAgentState,
  type AdaptiveModelRequestStatus,
} from "./sql"

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

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface PutManifestInput {
  readonly id: AdaptiveTask.ContextManifestID
  readonly taskID: AdaptiveTask.ID
  readonly agentID: AdaptiveTask.AgentID
  readonly generation: number
  readonly owner: string
  readonly purpose: string
  readonly system: readonly string[]
  readonly messages: readonly unknown[]
  readonly tools: readonly unknown[]
  readonly components: readonly unknown[]
  readonly estimatedTokens: number
  readonly requestHash: string
}

export interface ManifestRecord extends Omit<PutManifestInput, "owner" | "messages" | "tools" | "components"> {
  readonly messages: readonly JsonValue[]
  readonly tools: readonly JsonValue[]
  readonly components: readonly JsonValue[]
  readonly timeCreated: number
}

export interface ModelRequestInput {
  readonly id: AdaptiveTask.RequestID
  readonly taskID: AdaptiveTask.ID
  readonly agentID: AdaptiveTask.AgentID
  readonly generation: number
  readonly manifestID: AdaptiveTask.ContextManifestID
  readonly retryOf?: AdaptiveTask.RequestID
  readonly modelPolicy: AdaptiveTask.ModelPolicy
}

export interface ModelRequestRecord extends ModelRequestInput {
  readonly status: AdaptiveModelRequestStatus
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly failure?: string
  readonly timeCreated: number
  readonly timeCompleted?: number
}

export interface ModelRequestSettlement {
  readonly requestID: AdaptiveTask.RequestID
  readonly status: "succeeded" | "failed" | "interrupted"
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly failure?: string
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

export class InvalidManifestError extends Schema.TaggedErrorClass<InvalidManifestError>()(
  "AdaptiveStore.InvalidManifest",
  { manifestID: AdaptiveTask.ContextManifestID, reason: Schema.String },
) {}

export class DuplicateManifestError extends Schema.TaggedErrorClass<DuplicateManifestError>()(
  "AdaptiveStore.DuplicateManifest",
  { manifestID: AdaptiveTask.ContextManifestID },
) {}

export class ManifestNotFoundError extends Schema.TaggedErrorClass<ManifestNotFoundError>()(
  "AdaptiveStore.ManifestNotFound",
  { manifestID: AdaptiveTask.ContextManifestID },
) {}

export class ManifestOwnershipMismatchError extends Schema.TaggedErrorClass<ManifestOwnershipMismatchError>()(
  "AdaptiveStore.ManifestOwnershipMismatch",
  {
    manifestID: AdaptiveTask.ContextManifestID,
    agentID: AdaptiveTask.AgentID,
    generation: Schema.Number,
    owner: Schema.String,
  },
) {}

export class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()(
  "AdaptiveStore.InvalidRequest",
  {
    requestID: AdaptiveTask.RequestID,
    reason: Schema.String,
  },
) {}

export class DuplicateRequestError extends Schema.TaggedErrorClass<DuplicateRequestError>()(
  "AdaptiveStore.DuplicateRequest",
  { requestID: AdaptiveTask.RequestID },
) {}

export class RequestNotFoundError extends Schema.TaggedErrorClass<RequestNotFoundError>()(
  "AdaptiveStore.RequestNotFound",
  { requestID: AdaptiveTask.RequestID },
) {}

export class RequestReferenceMismatchError extends Schema.TaggedErrorClass<RequestReferenceMismatchError>()(
  "AdaptiveStore.RequestReferenceMismatch",
  { requestID: AdaptiveTask.RequestID, reason: Schema.String },
) {}

export class RequestAlreadySettledError extends Schema.TaggedErrorClass<RequestAlreadySettledError>()(
  "AdaptiveStore.RequestAlreadySettled",
  { requestID: AdaptiveTask.RequestID },
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
  readonly putManifest: (
    input: PutManifestInput,
  ) => Effect.Effect<ManifestRecord, InvalidManifestError | DuplicateManifestError | ManifestOwnershipMismatchError>
  readonly getManifest: (
    id: AdaptiveTask.ContextManifestID,
  ) => Effect.Effect<ManifestRecord, InvalidManifestError | ManifestNotFoundError>
  readonly insertModelRequest: (
    input: ModelRequestInput,
  ) => Effect.Effect<ModelRequestRecord, InvalidRequestError | DuplicateRequestError | RequestReferenceMismatchError>
  readonly getModelRequest: (
    id: AdaptiveTask.RequestID,
  ) => Effect.Effect<ModelRequestRecord, RequestNotFoundError | CorruptModelPolicyError>
  readonly settleModelRequest: (
    input: ModelRequestSettlement,
  ) => Effect.Effect<
    ModelRequestRecord,
    InvalidRequestError | RequestNotFoundError | RequestAlreadySettledError | CorruptModelPolicyError
  >
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

const jsonValue = (value: unknown, stack = new WeakSet<object>()): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value
    throw new Error("JSON numbers must be finite")
  }
  if (typeof value !== "object") throw new Error(`unsupported JSON value: ${typeof value}`)
  if (stack.has(value)) throw new Error("cyclic JSON value")
  stack.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => jsonValue(item, stack))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error("JSON objects must be plain objects")
    const output: Record<string, JsonValue> = {}
    for (const key of Object.keys(value)) output[key] = jsonValue((value as Record<string, unknown>)[key], stack)
    return output
  } finally {
    stack.delete(value)
  }
}

const manifestValues = (input: Pick<PutManifestInput, "system" | "messages" | "tools" | "components">) => {
  if (!Array.isArray(input.system) || input.system.some((part) => typeof part !== "string"))
    throw new Error("Manifest system must contain only strings")
  const array = (name: string, value: readonly unknown[]) => {
    if (!Array.isArray(value)) throw new Error(`Manifest ${name} must be an array`)
    return value.map((item) => jsonValue(item))
  }
  return {
    system: [...input.system],
    messages: array("messages", input.messages),
    tools: array("tools", input.tools),
    components: array("components", input.components),
  }
}

const manifestRecord = (row: typeof AdaptiveContextManifestTable.$inferSelect): ManifestRecord => {
  const values = manifestValues(row)
  return {
    id: row.id,
    taskID: row.task_id,
    agentID: row.agent_id,
    generation: row.generation,
    purpose: row.purpose,
    ...values,
    estimatedTokens: row.estimated_tokens,
    requestHash: row.request_hash,
    timeCreated: row.time_created,
  }
}

const decodeManifest = (row: typeof AdaptiveContextManifestTable.$inferSelect) =>
  Effect.try({
    try: () => manifestRecord(row),
    catch: (cause) =>
      new InvalidManifestError({
        manifestID: row.id,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  })

const requestRecord = (row: typeof AdaptiveModelRequestTable.$inferSelect): ModelRequestRecord => {
  const modelPolicy = AdaptiveTask.ModelPolicy.make({
    providerID: Provider.ID.make(row.provider_id),
    modelID: Model.ID.make(row.model_id),
    ...(row.variant === null ? {} : { variant: Model.VariantID.make(row.variant) }),
    effectiveContextLimit: row.effective_context_limit,
    outputReserve: row.output_reserve,
    safetyReserve: row.safety_reserve,
    hash: row.model_policy_hash,
  })
  AdaptiveModelPolicy.assertEqual(modelPolicy, modelPolicy)
  return {
    id: row.id,
    taskID: row.task_id,
    agentID: row.agent_id,
    generation: row.generation,
    manifestID: row.manifest_id,
    ...(row.retry_of === null ? {} : { retryOf: row.retry_of }),
    modelPolicy,
    status: row.status,
    ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
    ...(row.failure === null ? {} : { failure: row.failure }),
    timeCreated: row.time_created,
    ...(row.time_completed === null ? {} : { timeCompleted: row.time_completed }),
  }
}

const decodeRequest = (row: typeof AdaptiveModelRequestTable.$inferSelect) =>
  Effect.try({
    try: () => requestRecord(row),
    catch: (cause) => new CorruptModelPolicyError({ taskID: row.task_id, cause }),
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

    const getManifest = Effect.fn("AdaptiveStore.getManifest")(function* (id: AdaptiveTask.ContextManifestID) {
      const row = yield* db
        .select()
        .from(AdaptiveContextManifestTable)
        .where(eq(AdaptiveContextManifestTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new ManifestNotFoundError({ manifestID: id })
      return yield* decodeManifest(row)
    })

    const putManifest = Effect.fn("AdaptiveStore.putManifest")(function* (input: PutManifestInput) {
      const values = yield* Effect.try({
        try: () => {
          if (input.owner.length === 0) throw new Error("Manifest owner is empty")
          if (input.purpose.length === 0) throw new Error("Manifest purpose is empty")
          if (input.requestHash.length === 0) throw new Error("Manifest request hash is empty")
          if (input.generation < 0 || !Number.isSafeInteger(input.generation))
            throw new Error("Manifest generation must be a nonnegative integer")
          if (input.estimatedTokens < 0 || !Number.isSafeInteger(input.estimatedTokens))
            throw new Error("Manifest estimated tokens must be a nonnegative integer")
          return manifestValues(input)
        },
        catch: (cause) =>
          new InvalidManifestError({
            manifestID: input.id,
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      })
      const now = yield* Clock.currentTimeMillis
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const owned = yield* tx
              .select({ id: AdaptiveAgentProcessTable.id })
              .from(AdaptiveAgentProcessTable)
              .where(
                and(
                  eq(AdaptiveAgentProcessTable.id, input.agentID),
                  eq(AdaptiveAgentProcessTable.task_id, input.taskID),
                  eq(AdaptiveAgentProcessTable.generation, input.generation),
                  eq(AdaptiveAgentProcessTable.owner, input.owner),
                  inArray(AdaptiveAgentProcessTable.state, ["starting", "running"]),
                  gt(AdaptiveAgentProcessTable.lease_expires_at, now),
                ),
              )
              .get()
              .pipe(Effect.orDie)
            if (!owned)
              return yield* new ManifestOwnershipMismatchError({
                manifestID: input.id,
                agentID: input.agentID,
                generation: input.generation,
                owner: input.owner,
              })
            const row = yield* tx
              .insert(AdaptiveContextManifestTable)
              .values({
                id: input.id,
                task_id: input.taskID,
                agent_id: input.agentID,
                generation: input.generation,
                purpose: input.purpose,
                ...values,
                estimated_tokens: input.estimatedTokens,
                request_hash: input.requestHash,
                time_created: now,
              })
              .onConflictDoNothing()
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* new DuplicateManifestError({ manifestID: input.id })
            return manifestRecord(row)
          }),
        )
        .pipe(Effect.catchTag("SqlError", (cause) => Effect.die(cause)))
    })

    const getModelRequest = Effect.fn("AdaptiveStore.getModelRequest")(function* (id: AdaptiveTask.RequestID) {
      const row = yield* db
        .select()
        .from(AdaptiveModelRequestTable)
        .where(eq(AdaptiveModelRequestTable.id, id))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new RequestNotFoundError({ requestID: id })
      return yield* decodeRequest(row)
    })

    const insertModelRequest = Effect.fn("AdaptiveStore.insertModelRequest")(function* (input: ModelRequestInput) {
      if (input.generation < 0 || !Number.isSafeInteger(input.generation))
        return yield* new InvalidRequestError({
          requestID: input.id,
          reason: "Request generation must be a nonnegative integer",
        })
      AdaptiveModelPolicy.assertEqual(input.modelPolicy, input.modelPolicy)
      const now = yield* Clock.currentTimeMillis
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const manifest = yield* tx
              .select({
                taskID: AdaptiveContextManifestTable.task_id,
                agentID: AdaptiveContextManifestTable.agent_id,
                generation: AdaptiveContextManifestTable.generation,
              })
              .from(AdaptiveContextManifestTable)
              .where(eq(AdaptiveContextManifestTable.id, input.manifestID))
              .get()
              .pipe(Effect.orDie)
            if (
              !manifest ||
              manifest.taskID !== input.taskID ||
              manifest.agentID !== input.agentID ||
              manifest.generation !== input.generation
            )
              return yield* new RequestReferenceMismatchError({
                requestID: input.id,
                reason: "Manifest task, agent, or generation does not match the Request",
              })
            if (input.retryOf) {
              const parent = yield* tx
                .select({ taskID: AdaptiveModelRequestTable.task_id })
                .from(AdaptiveModelRequestTable)
                .where(eq(AdaptiveModelRequestTable.id, input.retryOf))
                .get()
                .pipe(Effect.orDie)
              if (!parent || parent.taskID !== input.taskID)
                return yield* new RequestReferenceMismatchError({
                  requestID: input.id,
                  reason: "Retry parent is missing or belongs to another Task",
                })
            }
            const row = yield* tx
              .insert(AdaptiveModelRequestTable)
              .values({
                id: input.id,
                task_id: input.taskID,
                agent_id: input.agentID,
                generation: input.generation,
                manifest_id: input.manifestID,
                retry_of: input.retryOf,
                provider_id: input.modelPolicy.providerID,
                model_id: input.modelPolicy.modelID,
                variant: input.modelPolicy.variant,
                effective_context_limit: input.modelPolicy.effectiveContextLimit,
                output_reserve: input.modelPolicy.outputReserve,
                safety_reserve: input.modelPolicy.safetyReserve,
                model_policy_hash: input.modelPolicy.hash,
                status: "admitted",
                time_created: now,
              })
              .onConflictDoNothing()
              .returning()
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* new DuplicateRequestError({ requestID: input.id })
            return requestRecord(row)
          }),
        )
        .pipe(Effect.catchTag("SqlError", (cause) => Effect.die(cause)))
    })

    const invalidTokens = (input: ModelRequestSettlement) => {
      for (const [name, value] of [
        ["inputTokens", input.inputTokens],
        ["outputTokens", input.outputTokens],
      ] as const) {
        if (value !== undefined && (value < 0 || !Number.isSafeInteger(value)))
          return new InvalidRequestError({
            requestID: input.requestID,
            reason: `${name} must be a nonnegative integer`,
          })
      }
    }

    const settleModelRequest = Effect.fn("AdaptiveStore.settleModelRequest")(function* (input: ModelRequestSettlement) {
      const invalid = invalidTokens(input)
      if (invalid) return yield* invalid
      const now = yield* Clock.currentTimeMillis
      const row = yield* db
        .update(AdaptiveModelRequestTable)
        .set({
          status: input.status,
          input_tokens: input.inputTokens ?? null,
          output_tokens: input.outputTokens ?? null,
          failure: input.failure ?? null,
          time_completed: now,
        })
        .where(
          and(
            eq(AdaptiveModelRequestTable.id, input.requestID),
            inArray(AdaptiveModelRequestTable.status, ["admitted", "streaming"]),
          ),
        )
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!row) {
        const existing = yield* db
          .select({ id: AdaptiveModelRequestTable.id })
          .from(AdaptiveModelRequestTable)
          .where(eq(AdaptiveModelRequestTable.id, input.requestID))
          .get()
          .pipe(Effect.orDie)
        if (!existing) return yield* new RequestNotFoundError({ requestID: input.requestID })
        return yield* new RequestAlreadySettledError({ requestID: input.requestID })
      }
      return yield* decodeRequest(row)
    })

    return Service.of({
      createTask,
      getTask,
      createAgent,
      getAgent,
      claimAgent,
      heartbeat,
      settleAgent,
      putManifest,
      getManifest,
      insertModelRequest,
      getModelRequest,
      settleModelRequest,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
