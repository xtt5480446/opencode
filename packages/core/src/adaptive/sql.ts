import { sql } from "drizzle-orm"
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { AdaptiveOperation } from "@opencode-ai/schema/adaptive-operation"
import { AdaptiveRoadmap } from "@opencode-ai/schema/adaptive-roadmap"
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
export type AdaptiveRecoveryState = "ready" | "verifying" | "blocked"

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
    node_id: text(),
    tool_session_id: text(),
    assignment_id: text().$type<AdaptiveOperation.AssignmentID>(),
    event_cursor: integer().notNull().default(0),
    checkpoint_sequence: integer(),
    recovery_state: text().$type<AdaptiveRecoveryState>().notNull().default("ready"),
    restart_required: integer({ mode: "boolean" }).notNull().default(false),
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
      sql`(${table.owner} IS NULL AND ${table.pid} IS NULL AND ${table.lease_expires_at} IS NULL) OR (${table.owner} IS NOT NULL AND length(${table.owner}) > 0 AND ${table.pid} > 0 AND ((${table.state} IN ('starting', 'running') AND ${table.lease_expires_at} > 0) OR (${table.state} = 'failed' AND ${table.lease_expires_at} IS NULL)))`,
    ),
    check(
      "adaptive_agent_state_owner_check",
      sql`(${table.state} IN ('starting', 'running') AND ${table.owner} IS NOT NULL) OR (${table.state} IN ('idle', 'stopped', 'lost') AND ${table.owner} IS NULL) OR ${table.state} = 'failed'`,
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
    omissions: text({ mode: "json" }).$type<readonly unknown[]>().notNull().default([]),
    estimated_tokens: integer().notNull(),
    roadmap_revision: integer().notNull().default(0),
    turn: integer().notNull().default(0),
    restart_reason: text(),
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
    resolved_provider_id: text(),
    resolved_model_id: text(),
    resolved_variant: text(),
    resolved_effective_context_limit: integer(),
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
    check(
      "adaptive_model_request_resolved_tuple_check",
      sql`(${table.resolved_provider_id} IS NULL AND ${table.resolved_model_id} IS NULL AND ${table.resolved_variant} IS NULL AND ${table.resolved_effective_context_limit} IS NULL) OR (${table.resolved_provider_id} IS NOT NULL AND length(${table.resolved_provider_id}) > 0 AND ${table.resolved_model_id} IS NOT NULL AND length(${table.resolved_model_id}) > 0 AND ${table.resolved_effective_context_limit} > 0)`,
    ),
    check(
      "adaptive_model_request_input_tokens_check",
      sql`${table.input_tokens} IS NULL OR ${table.input_tokens} >= 0`,
    ),
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

export const AdaptiveBootstrapTable = sqliteTable(
  "adaptive_bootstrap",
  {
    task_id: text()
      .$type<AdaptiveTask.ID>()
      .primaryKey()
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
    request_id: text()
      .$type<AdaptiveTask.RequestID>()
      .notNull()
      .unique()
      .references(() => AdaptiveModelRequestTable.id),
    output: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [check("adaptive_bootstrap_generation_check", sql`${table.generation} >= 0`)],
)

export const AdaptiveRoadmapRevisionTable = sqliteTable(
  "adaptive_roadmap_revision",
  {
    task_id: text()
      .$type<AdaptiveTask.ID>()
      .notNull()
      .references(() => AdaptiveTaskTable.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    requirement: text({ mode: "json" }).$type<AdaptiveRoadmap.RequirementBaseline>().notNull(),
    roadmap: text({ mode: "json" }).$type<AdaptiveRoadmap.Info>().notNull(),
    content_hash: text().$type<AdaptiveOperation.Hash>().notNull(),
    source_agent_id: text()
      .$type<AdaptiveTask.AgentID>()
      .notNull()
      .references(() => AdaptiveAgentProcessTable.id, { onDelete: "cascade" }),
    source_generation: integer().notNull(),
    event_sequence: integer().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.task_id, table.revision] }),
    uniqueIndex("adaptive_roadmap_task_event_idx").on(table.task_id, table.event_sequence),
    check("adaptive_roadmap_revision_check", sql`${table.revision} > 0`),
    check("adaptive_roadmap_hash_check", hashCheck(table.content_hash)),
    check("adaptive_roadmap_source_generation_check", sql`${table.source_generation} > 0`),
    check("adaptive_roadmap_event_sequence_check", sql`${table.event_sequence} >= 0`),
  ],
)

export const AdaptiveDetailTable = sqliteTable(
  "adaptive_detail",
  {
    task_id: text()
      .$type<AdaptiveTask.ID>()
      .notNull()
      .references(() => AdaptiveTaskTable.id, { onDelete: "cascade" }),
    key: text().notNull(),
    version: integer().notNull(),
    node_id: text().notNull(),
    kind: text().$type<AdaptiveRoadmap.DetailKind>().notNull(),
    status: text().$type<AdaptiveRoadmap.DetailStatus>().notNull(),
    body: text().notNull(),
    content_hash: text().$type<AdaptiveOperation.Hash>().notNull(),
    source_agent_id: text()
      .$type<AdaptiveTask.AgentID>()
      .notNull()
      .references(() => AdaptiveAgentProcessTable.id, { onDelete: "cascade" }),
    source_generation: integer().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.task_id, table.key, table.version] }),
    index("adaptive_detail_task_node_idx").on(table.task_id, table.node_id),
    check("adaptive_detail_key_check", sql`length(${table.key}) > 0`),
    check("adaptive_detail_version_check", sql`${table.version} >= 0`),
    check("adaptive_detail_kind_check", sql`${table.kind} IN ('requirements', 'contracts', 'decisions', 'validation')`),
    check("adaptive_detail_status_check", sql`${table.status} IN ('unresolved', 'draft', 'ready', 'superseded')`),
    check("adaptive_detail_hash_check", hashCheck(table.content_hash)),
    check("adaptive_detail_source_generation_check", sql`${table.source_generation} > 0`),
  ],
)

export const AdaptiveAssignmentTable = sqliteTable(
  "adaptive_assignment",
  {
    id: text().$type<AdaptiveOperation.AssignmentID>().primaryKey(),
    task_id: text()
      .$type<AdaptiveTask.ID>()
      .notNull()
      .references(() => AdaptiveTaskTable.id, { onDelete: "cascade" }),
    worker_id: text()
      .$type<AdaptiveTask.AgentID>()
      .notNull()
      .references(() => AdaptiveAgentProcessTable.id, { onDelete: "cascade" }),
    node_id: text().notNull(),
    generation: integer().notNull(),
    roadmap_revision: integer().notNull(),
    detail_refs: text({ mode: "json" }).$type<readonly AdaptiveRoadmap.DetailRef[]>().notNull(),
    permitted_paths: text({ mode: "json" }).$type<readonly AdaptiveOperation.RepositoryGlob[]>().notNull(),
    base_commit: text().notNull(),
    acceptance_commands: text({ mode: "json" }).$type<readonly string[]>().notNull(),
    time_created: integer().notNull(),
    superseded_at: integer(),
  },
  (table) => [
    index("adaptive_assignment_task_node_idx").on(table.task_id, table.node_id),
    uniqueIndex("adaptive_assignment_worker_generation_idx").on(table.worker_id, table.generation),
    check("adaptive_assignment_node_check", sql`length(${table.node_id}) > 0`),
    check("adaptive_assignment_generation_check", sql`${table.generation} > 0`),
    check("adaptive_assignment_roadmap_revision_check", sql`${table.roadmap_revision} > 0`),
    check("adaptive_assignment_base_commit_check", sql`length(${table.base_commit}) > 0`),
  ],
)

export const AdaptiveCheckpointTable = sqliteTable(
  "adaptive_checkpoint",
  {
    worker_id: text()
      .$type<AdaptiveTask.AgentID>()
      .notNull()
      .references(() => AdaptiveAgentProcessTable.id, { onDelete: "cascade" }),
    sequence: integer().notNull(),
    assignment_id: text()
      .$type<AdaptiveOperation.AssignmentID>()
      .notNull()
      .references(() => AdaptiveAssignmentTable.id, { onDelete: "cascade" }),
    generation: integer().notNull(),
    roadmap_revision: integer().notNull(),
    checkpoint: text({ mode: "json" }).$type<AdaptiveOperation.Checkpoint>().notNull(),
    worktree_head: text().notNull(),
    diff_hash: text().$type<AdaptiveOperation.Hash>().notNull(),
    event_cursor: integer().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.worker_id, table.sequence] }),
    index("adaptive_checkpoint_assignment_idx").on(table.assignment_id, table.sequence),
    check("adaptive_checkpoint_sequence_check", sql`${table.sequence} >= 0`),
    check("adaptive_checkpoint_generation_check", sql`${table.generation} > 0`),
    check("adaptive_checkpoint_roadmap_revision_check", sql`${table.roadmap_revision} > 0`),
    check("adaptive_checkpoint_diff_hash_check", hashCheck(table.diff_hash)),
    check("adaptive_checkpoint_event_cursor_check", sql`${table.event_cursor} >= 0`),
  ],
)

export const AdaptiveBlobTable = sqliteTable(
  "adaptive_blob",
  {
    hash: text().$type<AdaptiveOperation.Hash>().primaryKey(),
    media_type: text().notNull(),
    byte_count: integer().notNull(),
    relative_path: text().notNull().unique(),
    time_created: integer().notNull(),
    time_last_accessed: integer().notNull(),
  },
  (table) => [
    check("adaptive_blob_hash_check", hashCheck(table.hash)),
    check("adaptive_blob_media_type_check", sql`length(${table.media_type}) > 0`),
    check("adaptive_blob_byte_count_check", sql`${table.byte_count} >= 0`),
    check("adaptive_blob_relative_path_check", sql`length(${table.relative_path}) > 0`),
  ],
)
