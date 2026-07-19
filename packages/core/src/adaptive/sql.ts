import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Timestamps } from "../database/schema.sql"

const hashCheck = (column: ReturnType<typeof text>) =>
  sql`length(${column}) = 71 AND substr(${column}, 1, 7) = 'sha256:' AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*'`

export const AdaptiveTaskTable = sqliteTable(
  "adaptive_task",
  {
    id: text().$type<AdaptiveTask.ID>().primaryKey(),
    directory: text().notNull(),
    mode: text().$type<AdaptiveTask.Mode>().notNull(),
    status: text().$type<AdaptiveTask.Status>().notNull(),
    requirement: text().notNull(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    variant: text(),
    effective_context_limit: integer().notNull(),
    output_reserve: integer().notNull(),
    safety_reserve: integer().notNull(),
    model_policy_hash: text().notNull(),
    roadmap_revision: integer().notNull(),
    base_snapshot_hash: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("adaptive_task_directory_idx").on(table.directory),
    check("adaptive_task_mode_check", sql`${table.mode} IN ('normal', 'benchmark')`),
    check(
      "adaptive_task_status_check",
      sql`${table.status} IN ('planning', 'running', 'needs_input', 'stopped', 'cancelled', 'failed', 'completed', 'invalid')`,
    ),
    check("adaptive_task_requirement_check", sql`length(${table.requirement}) > 0`),
    check("adaptive_task_directory_check", sql`length(${table.directory}) > 0`),
    check("adaptive_task_model_check", sql`length(${table.provider_id}) > 0 AND length(${table.model_id}) > 0`),
    check("adaptive_task_effective_limit_check", sql`${table.effective_context_limit} > 0`),
    check("adaptive_task_output_reserve_check", sql`${table.output_reserve} > 0`),
    check("adaptive_task_safety_reserve_check", sql`${table.safety_reserve} > 0`),
    check(
      "adaptive_task_reserve_total_check",
      sql`${table.output_reserve} + ${table.safety_reserve} < ${table.effective_context_limit}`,
    ),
    check("adaptive_task_policy_hash_check", hashCheck(table.model_policy_hash)),
    check("adaptive_task_roadmap_revision_check", sql`${table.roadmap_revision} >= 0`),
    check("adaptive_task_base_snapshot_hash_check", sql`length(${table.base_snapshot_hash}) > 0`),
  ],
)

export type AdaptiveAgentState = "idle" | "starting" | "running" | "stopped" | "lost" | "failed"

export const AdaptiveAgentProcessTable = sqliteTable(
  "adaptive_agent_process",
  {
    id: text().$type<AdaptiveTask.AgentID>().primaryKey(),
    task_id: text()
      .$type<AdaptiveTask.ID>()
      .notNull()
      .references(() => AdaptiveTaskTable.id, { onDelete: "cascade" }),
    role: text().$type<AdaptiveTask.Role>().notNull(),
    generation: integer().notNull(),
    state: text().$type<AdaptiveAgentState>().notNull(),
    owner: text(),
    pid: integer(),
    lease_expires_at: integer(),
    exit_code: integer(),
    exit_reason: text(),
    ...Timestamps,
  },
  (table) => [
    index("adaptive_agent_task_state_idx").on(table.task_id, table.state),
    check(
      "adaptive_agent_role_check",
      sql`${table.role} IN ('coordinator', 'roadmap-reviewer', 'discovery', 'implementation', 'validator', 'integration')`,
    ),
    check(
      "adaptive_agent_state_check",
      sql`${table.state} IN ('idle', 'starting', 'running', 'stopped', 'lost', 'failed')`,
    ),
    check("adaptive_agent_generation_check", sql`${table.generation} >= 0`),
    check(
      "adaptive_agent_owner_tuple_check",
      sql`(${table.owner} IS NULL AND ${table.pid} IS NULL AND ${table.lease_expires_at} IS NULL) OR (${table.owner} IS NOT NULL AND length(${table.owner}) > 0 AND ${table.pid} > 0 AND ${table.lease_expires_at} > 0)`,
    ),
    check(
      "adaptive_agent_state_owner_check",
      sql`(${table.state} IN ('starting', 'running') AND ${table.owner} IS NOT NULL) OR (${table.state} IN ('idle', 'stopped', 'lost', 'failed') AND ${table.owner} IS NULL)`,
    ),
  ],
)

export const AdaptiveContextManifestTable = sqliteTable(
  "adaptive_context_manifest",
  {
    id: text().$type<AdaptiveTask.ContextManifestID>().primaryKey(),
    task_id: text()
      .$type<AdaptiveTask.ID>()
      .notNull()
      .references(() => AdaptiveTaskTable.id, { onDelete: "cascade" }),
    agent_id: text()
      .$type<AdaptiveTask.AgentID>()
      .notNull()
      .references(() => AdaptiveAgentProcessTable.id, { onDelete: "cascade" }),
    generation: integer().notNull(),
    purpose: text().notNull(),
    system: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    messages: text({ mode: "json" }).$type<readonly unknown[]>().notNull(),
    tools: text({ mode: "json" }).$type<readonly unknown[]>().notNull(),
    components: text({ mode: "json" }).$type<readonly unknown[]>().notNull(),
    estimated_tokens: integer().notNull(),
    request_hash: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("adaptive_manifest_agent_time_idx").on(table.agent_id, table.time_created),
    check("adaptive_manifest_generation_check", sql`${table.generation} >= 0`),
    check("adaptive_manifest_purpose_check", sql`length(${table.purpose}) > 0`),
    check("adaptive_manifest_estimated_tokens_check", sql`${table.estimated_tokens} >= 0`),
    check("adaptive_manifest_request_hash_check", sql`length(${table.request_hash}) > 0`),
  ],
)

export type AdaptiveModelRequestStatus = "admitted" | "streaming" | "succeeded" | "failed" | "interrupted"

export const AdaptiveModelRequestTable = sqliteTable(
  "adaptive_model_request",
  {
    id: text().$type<AdaptiveTask.RequestID>().primaryKey(),
    task_id: text()
      .$type<AdaptiveTask.ID>()
      .notNull()
      .references(() => AdaptiveTaskTable.id, { onDelete: "cascade" }),
    agent_id: text()
      .$type<AdaptiveTask.AgentID>()
      .notNull()
      .references(() => AdaptiveAgentProcessTable.id, { onDelete: "cascade" }),
    generation: integer().notNull(),
    manifest_id: text()
      .$type<AdaptiveTask.ContextManifestID>()
      .notNull()
      .references(() => AdaptiveContextManifestTable.id),
    retry_of: text().$type<AdaptiveTask.RequestID>(),
    provider_id: text().notNull(),
    model_id: text().notNull(),
    variant: text(),
    effective_context_limit: integer().notNull(),
    output_reserve: integer().notNull(),
    safety_reserve: integer().notNull(),
    model_policy_hash: text().notNull(),
    status: text().$type<AdaptiveModelRequestStatus>().notNull(),
    input_tokens: integer(),
    output_tokens: integer(),
    failure: text(),
    time_created: integer().notNull(),
    time_completed: integer(),
  },
  (table) => [
    index("adaptive_model_request_task_idx").on(table.task_id, table.time_created),
    index("adaptive_model_request_agent_idx").on(table.agent_id, table.generation),
    foreignKey({
      name: "adaptive_model_request_retry_fk",
      columns: [table.retry_of],
      foreignColumns: [table.id],
    }),
    check("adaptive_model_request_generation_check", sql`${table.generation} >= 0`),
    check(
      "adaptive_model_request_status_check",
      sql`${table.status} IN ('admitted', 'streaming', 'succeeded', 'failed', 'interrupted')`,
    ),
    check("adaptive_model_request_effective_limit_check", sql`${table.effective_context_limit} > 0`),
    check("adaptive_model_request_output_reserve_check", sql`${table.output_reserve} > 0`),
    check("adaptive_model_request_safety_reserve_check", sql`${table.safety_reserve} > 0`),
    check(
      "adaptive_model_request_reserve_total_check",
      sql`${table.output_reserve} + ${table.safety_reserve} < ${table.effective_context_limit}`,
    ),
    check("adaptive_model_request_policy_hash_check", hashCheck(table.model_policy_hash)),
    check("adaptive_model_request_input_tokens_check", sql`${table.input_tokens} IS NULL OR ${table.input_tokens} >= 0`),
    check(
      "adaptive_model_request_output_tokens_check",
      sql`${table.output_tokens} IS NULL OR ${table.output_tokens} >= 0`,
    ),
    check(
      "adaptive_model_request_completion_check",
      sql`(${table.status} IN ('admitted', 'streaming') AND ${table.time_completed} IS NULL) OR (${table.status} IN ('succeeded', 'failed', 'interrupted') AND ${table.time_completed} IS NOT NULL)`,
    ),
  ],
)
