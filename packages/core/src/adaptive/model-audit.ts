export * as AdaptiveModelAudit from "./model-audit"

import { and, eq, inArray } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { AdaptiveModelPolicy } from "./model-policy"
import { AdaptiveStore } from "./store"
import {
  AdaptiveAgentProcessTable,
  AdaptiveContextManifestTable,
  AdaptiveModelRequestTable,
  AdaptiveTaskTable,
} from "./sql"

export interface AdmissionInput {
  readonly requestID: AdaptiveTask.RequestID
  readonly taskID: AdaptiveTask.ID
  readonly agentID: AdaptiveTask.AgentID
  readonly generation: number
  readonly manifestID: AdaptiveTask.ContextManifestID
  readonly retryOf?: AdaptiveTask.RequestID
  readonly modelPolicy: AdaptiveTask.ModelPolicy
}

export interface Admission extends AdmissionInput {
  readonly directory: string
}

export interface SettlementInput {
  readonly requestID: AdaptiveTask.RequestID
  readonly status: "succeeded" | "failed" | "interrupted"
  readonly providerID: Provider.ID
  readonly modelID: Model.ID
  readonly variant?: Model.VariantID
  readonly effectiveContextLimit: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly failure?: string
}

export type ValidityProof =
  | {
      readonly valid: true
      readonly providerID: string
      readonly modelID: string
      readonly policyHash: string
      readonly requests: number
    }
  | {
      readonly valid: false
      readonly code: "INVALID_MODEL_MIXING"
      readonly reasons: readonly string[]
      readonly requests: number
    }

export class MissingStateError extends Schema.TaggedErrorClass<MissingStateError>()("AdaptiveModelAudit.MissingState", {
  requestID: AdaptiveTask.RequestID,
  state: Schema.Literals(["task", "agent", "manifest"]),
}) {}

export class StaleGenerationError extends Schema.TaggedErrorClass<StaleGenerationError>()(
  "AdaptiveModelAudit.StaleGeneration",
  {
    requestID: AdaptiveTask.RequestID,
    agentID: AdaptiveTask.AgentID,
    requestedGeneration: Schema.Number,
    actualGeneration: Schema.Number,
  },
) {}

export class AgentTaskMismatchError extends Schema.TaggedErrorClass<AgentTaskMismatchError>()(
  "AdaptiveModelAudit.AgentTaskMismatch",
  {
    requestID: AdaptiveTask.RequestID,
    agentID: AdaptiveTask.AgentID,
    taskID: AdaptiveTask.ID,
  },
) {}

export class AgentNotClaimedError extends Schema.TaggedErrorClass<AgentNotClaimedError>()(
  "AdaptiveModelAudit.AgentNotClaimed",
  {
    requestID: AdaptiveTask.RequestID,
    agentID: AdaptiveTask.AgentID,
    generation: Schema.Number,
  },
) {}

export class ManifestMismatchError extends Schema.TaggedErrorClass<ManifestMismatchError>()(
  "AdaptiveModelAudit.ManifestMismatch",
  {
    requestID: AdaptiveTask.RequestID,
    manifestID: AdaptiveTask.ContextManifestID,
    reason: Schema.Literals(["owner", "generation"]),
  },
) {}

export class PolicyMismatchError extends Schema.TaggedErrorClass<PolicyMismatchError>()(
  "AdaptiveModelAudit.PolicyMismatch",
  {
    requestID: AdaptiveTask.RequestID,
    reason: Schema.Literals(["immutable policy", "effective context limit"]),
  },
) {}

export class InvalidRetryLineageError extends Schema.TaggedErrorClass<InvalidRetryLineageError>()(
  "AdaptiveModelAudit.InvalidRetryLineage",
  {
    requestID: AdaptiveTask.RequestID,
    retryOf: AdaptiveTask.RequestID,
    reason: Schema.Literals(["missing", "task", "agent", "policy"]),
  },
) {}

export class DuplicateRequestError extends Schema.TaggedErrorClass<DuplicateRequestError>()(
  "AdaptiveModelAudit.DuplicateRequest",
  { requestID: AdaptiveTask.RequestID },
) {}

export type AdmissionError =
  | MissingStateError
  | StaleGenerationError
  | AgentTaskMismatchError
  | AgentNotClaimedError
  | ManifestMismatchError
  | PolicyMismatchError
  | InvalidRetryLineageError
  | DuplicateRequestError

export class RequestNotFoundError extends Schema.TaggedErrorClass<RequestNotFoundError>()(
  "AdaptiveModelAudit.RequestNotFound",
  { requestID: AdaptiveTask.RequestID },
) {}

export class InvalidTransitionError extends Schema.TaggedErrorClass<InvalidTransitionError>()(
  "AdaptiveModelAudit.InvalidTransition",
  {
    requestID: AdaptiveTask.RequestID,
    expected: Schema.String,
    actual: Schema.String,
  },
) {}

export class InvalidSettlementError extends Schema.TaggedErrorClass<InvalidSettlementError>()(
  "AdaptiveModelAudit.InvalidSettlement",
  {
    requestID: AdaptiveTask.RequestID,
    reason: Schema.String,
  },
) {}

export interface Interface {
  readonly admit: (input: AdmissionInput) => Effect.Effect<Admission, AdmissionError>
  readonly streaming: (
    requestID: AdaptiveTask.RequestID,
  ) => Effect.Effect<void, RequestNotFoundError | InvalidTransitionError>
  readonly settle: (
    input: SettlementInput,
  ) => Effect.Effect<void, InvalidSettlementError | RequestNotFoundError | InvalidTransitionError>
  readonly verify: (taskID: AdaptiveTask.ID) => Effect.Effect<ValidityProof>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AdaptiveModelAudit") {}

const storedPolicy = (row: typeof AdaptiveTaskTable.$inferSelect) =>
  AdaptiveTask.ModelPolicy.make({
    providerID: Provider.ID.make(row.provider_id),
    modelID: Model.ID.make(row.model_id),
    ...(row.variant === null ? {} : { variant: Model.VariantID.make(row.variant) }),
    effectiveContextLimit: row.effective_context_limit,
    outputReserve: row.output_reserve,
    safetyReserve: row.safety_reserve,
    hash: row.model_policy_hash,
  })

const transitionFailure = Effect.fnUntraced(function* (
  requestID: AdaptiveTask.RequestID,
  expected: string,
  db: Database.Interface["db"],
) {
  const row = yield* db
    .select({ status: AdaptiveModelRequestTable.status })
    .from(AdaptiveModelRequestTable)
    .where(eq(AdaptiveModelRequestTable.id, requestID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return yield* new RequestNotFoundError({ requestID })
  return yield* new InvalidTransitionError({ requestID, expected, actual: row.status })
})

const invalidSettlement = (input: SettlementInput) => {
  if (input.providerID.length === 0) return "providerID must not be empty"
  if (input.modelID.length === 0) return "modelID must not be empty"
  if (input.effectiveContextLimit <= 0 || !Number.isSafeInteger(input.effectiveContextLimit))
    return "effectiveContextLimit must be a positive integer"
  for (const [name, value] of [
    ["inputTokens", input.inputTokens],
    ["outputTokens", input.outputTokens],
  ] as const) {
    if (value !== undefined && (value < 0 || !Number.isSafeInteger(value)))
      return `${name} must be a nonnegative integer`
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const admit = Effect.fn("AdaptiveModelAudit.admit")(function* (input: AdmissionInput) {
      const now = yield* Clock.currentTimeMillis
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const task = yield* tx
              .select()
              .from(AdaptiveTaskTable)
              .where(eq(AdaptiveTaskTable.id, input.taskID))
              .get()
              .pipe(Effect.orDie)
            if (!task) return yield* new MissingStateError({ requestID: input.requestID, state: "task" })

            const agent = yield* tx
              .select()
              .from(AdaptiveAgentProcessTable)
              .where(eq(AdaptiveAgentProcessTable.id, input.agentID))
              .get()
              .pipe(Effect.orDie)
            if (!agent) return yield* new MissingStateError({ requestID: input.requestID, state: "agent" })
            if (agent.task_id !== input.taskID)
              return yield* new AgentTaskMismatchError({
                requestID: input.requestID,
                agentID: input.agentID,
                taskID: input.taskID,
              })
            if (agent.generation !== input.generation)
              return yield* new StaleGenerationError({
                requestID: input.requestID,
                agentID: input.agentID,
                requestedGeneration: input.generation,
                actualGeneration: agent.generation,
              })
            if (
              agent.owner === null ||
              agent.lease_expires_at === null ||
              agent.lease_expires_at <= now ||
              (agent.state !== "starting" && agent.state !== "running")
            )
              return yield* new AgentNotClaimedError({
                requestID: input.requestID,
                agentID: input.agentID,
                generation: input.generation,
              })

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
            if (!manifest) return yield* new MissingStateError({ requestID: input.requestID, state: "manifest" })
            if (manifest.taskID !== input.taskID || manifest.agentID !== input.agentID)
              return yield* new ManifestMismatchError({
                requestID: input.requestID,
                manifestID: input.manifestID,
                reason: "owner",
              })
            if (manifest.generation !== input.generation)
              return yield* new ManifestMismatchError({
                requestID: input.requestID,
                manifestID: input.manifestID,
                reason: "generation",
              })

            const taskPolicy = storedPolicy(task)
            if (taskPolicy.effectiveContextLimit !== input.modelPolicy.effectiveContextLimit)
              return yield* new PolicyMismatchError({
                requestID: input.requestID,
                reason: "effective context limit",
              })
            yield* Effect.try({
              try: () => AdaptiveModelPolicy.assertEqual(taskPolicy, input.modelPolicy),
              catch: () => new PolicyMismatchError({ requestID: input.requestID, reason: "immutable policy" }),
            })

            if (input.retryOf) {
              const parent = yield* tx
                .select({
                  taskID: AdaptiveModelRequestTable.task_id,
                  agentID: AdaptiveModelRequestTable.agent_id,
                  policyHash: AdaptiveModelRequestTable.model_policy_hash,
                })
                .from(AdaptiveModelRequestTable)
                .where(eq(AdaptiveModelRequestTable.id, input.retryOf))
                .get()
                .pipe(Effect.orDie)
              if (!parent)
                return yield* new InvalidRetryLineageError({
                  requestID: input.requestID,
                  retryOf: input.retryOf,
                  reason: "missing",
                })
              if (parent.taskID !== input.taskID)
                return yield* new InvalidRetryLineageError({
                  requestID: input.requestID,
                  retryOf: input.retryOf,
                  reason: "task",
                })
              if (parent.agentID !== input.agentID)
                return yield* new InvalidRetryLineageError({
                  requestID: input.requestID,
                  retryOf: input.retryOf,
                  reason: "agent",
                })
              if (parent.policyHash !== input.modelPolicy.hash)
                return yield* new InvalidRetryLineageError({
                  requestID: input.requestID,
                  retryOf: input.retryOf,
                  reason: "policy",
                })
            }

            const row = yield* tx
              .insert(AdaptiveModelRequestTable)
              .values({
                id: input.requestID,
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
              .returning({ id: AdaptiveModelRequestTable.id })
              .get()
              .pipe(Effect.orDie)
            if (!row) return yield* new DuplicateRequestError({ requestID: input.requestID })
            return { ...input, directory: task.directory }
          }),
        )
        .pipe(Effect.catchTag("SqlError", (cause) => Effect.die(cause)))
    })

    const streaming = Effect.fn("AdaptiveModelAudit.streaming")(function* (requestID: AdaptiveTask.RequestID) {
      const row = yield* db
        .update(AdaptiveModelRequestTable)
        .set({ status: "streaming" })
        .where(and(eq(AdaptiveModelRequestTable.id, requestID), eq(AdaptiveModelRequestTable.status, "admitted")))
        .returning({ id: AdaptiveModelRequestTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* transitionFailure(requestID, "admitted", db)
    })

    const settle = Effect.fn("AdaptiveModelAudit.settle")(function* (input: SettlementInput) {
      const invalid = invalidSettlement(input)
      if (invalid) return yield* new InvalidSettlementError({ requestID: input.requestID, reason: invalid })
      const now = yield* Clock.currentTimeMillis
      const row = yield* db
        .update(AdaptiveModelRequestTable)
        .set({
          provider_id: input.providerID,
          model_id: input.modelID,
          variant: input.variant ?? null,
          effective_context_limit: input.effectiveContextLimit,
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
        .returning({ id: AdaptiveModelRequestTable.id })
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* transitionFailure(input.requestID, "admitted|streaming", db)
    })

    const verify = Effect.fn("AdaptiveModelAudit.verify")(function* (taskID: AdaptiveTask.ID) {
      const task = yield* db
        .select()
        .from(AdaptiveTaskTable)
        .where(eq(AdaptiveTaskTable.id, taskID))
        .get()
        .pipe(Effect.orDie)
      const requests = yield* db
        .select()
        .from(AdaptiveModelRequestTable)
        .where(eq(AdaptiveModelRequestTable.task_id, taskID))
        .all()
        .pipe(Effect.orDie)
      const ordered = requests.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      const reasons: string[] = []
      if (!task) reasons.push(`TASK_NOT_FOUND:${taskID}`)
      if (ordered.length === 0 && task) reasons.push("NO_MODEL_REQUEST")
      reasons.push(
        ...ordered
          .filter((request) => request.status === "admitted" || request.status === "streaming")
          .map((request) => `UNSETTLED_MODEL_REQUEST:${request.id}`),
      )

      const identities = [...new Set(ordered.map((request) => `${request.provider_id}/${request.model_id}`))].toSorted()
      if (identities.length > 1) reasons.push(`MULTIPLE_MODEL_IDENTITIES:${identities.join(",")}`)
      if (task && identities.length === 1) {
        const expected = `${task.provider_id}/${task.model_id}`
        if (identities[0] !== expected) reasons.push(`MODEL_IDENTITY_MISMATCH:${identities[0]}!=${expected}`)
      }
      if (task)
        reasons.push(
          ...ordered
            .filter((request) => request.variant !== task.variant)
            .map(
              (request) =>
                `MODEL_VARIANT_MISMATCH:${request.id}:${request.variant ?? "<none>"}!=${task.variant ?? "<none>"}`,
            ),
        )

      const hashes = [...new Set(ordered.map((request) => request.model_policy_hash))].toSorted()
      if (hashes.length > 1) reasons.push(`MULTIPLE_POLICY_HASHES:${hashes.join(",")}`)
      if (task && hashes.length === 1 && hashes[0] !== task.model_policy_hash)
        reasons.push(`POLICY_HASH_MISMATCH:${hashes[0]}!=${task.model_policy_hash}`)
      if (task)
        reasons.push(
          ...ordered
            .filter((request) => request.effective_context_limit > task.effective_context_limit)
            .map(
              (request) =>
                `CONTEXT_LIMIT_EXCEEDS_TASK_POLICY:${request.id}:${request.effective_context_limit}>${task.effective_context_limit}`,
            ),
        )

      if (reasons.length > 0)
        return {
          valid: false as const,
          code: "INVALID_MODEL_MIXING" as const,
          reasons,
          requests: ordered.length,
        }
      return {
        valid: true as const,
        providerID: ordered[0]!.provider_id,
        modelID: ordered[0]!.model_id,
        policyHash: hashes[0]!,
        requests: ordered.length,
      }
    })

    return Service.of({ admit, streaming, settle, verify })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [AdaptiveStore.node, Database.node] })
