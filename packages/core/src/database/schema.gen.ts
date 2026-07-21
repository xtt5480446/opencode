import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`adaptive_agent_process\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`state\` text NOT NULL,
          \`owner\` text,
          \`pid\` integer,
          \`lease_expires_at\` integer,
          \`exit_code\` integer,
          \`exit_reason\` text,
          \`node_id\` text,
          \`tool_session_id\` text,
          \`assignment_id\` text,
          \`event_cursor\` integer DEFAULT 0 NOT NULL,
          \`checkpoint_sequence\` integer,
          \`recovery_state\` text DEFAULT 'ready' NOT NULL,
          \`restart_required\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_adaptive_agent_process_task_id_adaptive_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`adaptive_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "adaptive_agent_role_check" CHECK("role" IN ('coordinator', 'roadmap-reviewer', 'discovery', 'implementation', 'validator', 'integration')),
          CONSTRAINT "adaptive_agent_state_check" CHECK("state" IN ('idle', 'starting', 'running', 'stopped', 'lost', 'failed')),
          CONSTRAINT "adaptive_agent_generation_check" CHECK("generation" >= 0),
          CONSTRAINT "adaptive_agent_owner_tuple_check" CHECK(("owner" IS NULL AND "pid" IS NULL AND "lease_expires_at" IS NULL) OR ("owner" IS NOT NULL AND length("owner") > 0 AND "pid" > 0 AND (("state" IN ('starting', 'running') AND "lease_expires_at" > 0) OR ("state" = 'failed' AND "lease_expires_at" IS NULL)))),
          CONSTRAINT "adaptive_agent_state_owner_check" CHECK(("state" IN ('starting', 'running') AND "owner" IS NOT NULL) OR ("state" IN ('idle', 'stopped', 'lost') AND "owner" IS NULL) OR "state" = 'failed')
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`adaptive_assignment\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`worker_id\` text NOT NULL,
          \`node_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`roadmap_revision\` integer NOT NULL,
          \`detail_refs\` text NOT NULL,
          \`permitted_paths\` text NOT NULL,
          \`base_commit\` text NOT NULL,
          \`acceptance_commands\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`superseded_at\` integer,
          CONSTRAINT \`fk_adaptive_assignment_task_id_adaptive_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`adaptive_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_adaptive_assignment_worker_id_adaptive_agent_process_id_fk\` FOREIGN KEY (\`worker_id\`) REFERENCES \`adaptive_agent_process\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "adaptive_assignment_node_check" CHECK(length("node_id") > 0),
          CONSTRAINT "adaptive_assignment_generation_check" CHECK("generation" > 0),
          CONSTRAINT "adaptive_assignment_roadmap_revision_check" CHECK("roadmap_revision" > 0),
          CONSTRAINT "adaptive_assignment_base_commit_check" CHECK(length("base_commit") > 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`adaptive_blob\` (
          \`hash\` text PRIMARY KEY,
          \`media_type\` text NOT NULL,
          \`byte_count\` integer NOT NULL,
          \`relative_path\` text NOT NULL UNIQUE,
          \`time_created\` integer NOT NULL,
          \`time_last_accessed\` integer NOT NULL,
          CONSTRAINT "adaptive_blob_hash_check" CHECK(length("hash") = 71 AND substr("hash", 1, 7) = 'sha256:' AND substr("hash", 8) NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "adaptive_blob_media_type_check" CHECK(length("media_type") > 0),
          CONSTRAINT "adaptive_blob_byte_count_check" CHECK("byte_count" >= 0),
          CONSTRAINT "adaptive_blob_relative_path_check" CHECK(length("relative_path") > 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`adaptive_bootstrap\` (
          \`task_id\` text PRIMARY KEY,
          \`agent_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`manifest_id\` text NOT NULL,
          \`request_id\` text NOT NULL UNIQUE,
          \`output\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_adaptive_bootstrap_task_id_adaptive_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`adaptive_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_adaptive_bootstrap_agent_id_adaptive_agent_process_id_fk\` FOREIGN KEY (\`agent_id\`) REFERENCES \`adaptive_agent_process\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_adaptive_bootstrap_manifest_id_adaptive_context_manifest_id_fk\` FOREIGN KEY (\`manifest_id\`) REFERENCES \`adaptive_context_manifest\`(\`id\`),
          CONSTRAINT \`fk_adaptive_bootstrap_request_id_adaptive_model_request_id_fk\` FOREIGN KEY (\`request_id\`) REFERENCES \`adaptive_model_request\`(\`id\`),
          CONSTRAINT "adaptive_bootstrap_generation_check" CHECK("generation" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`adaptive_checkpoint\` (
          \`worker_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`assignment_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`roadmap_revision\` integer NOT NULL,
          \`checkpoint\` text NOT NULL,
          \`worktree_head\` text NOT NULL,
          \`diff_hash\` text NOT NULL,
          \`event_cursor\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`adaptive_checkpoint_pk\` PRIMARY KEY(\`worker_id\`, \`sequence\`),
          CONSTRAINT \`fk_adaptive_checkpoint_worker_id_adaptive_agent_process_id_fk\` FOREIGN KEY (\`worker_id\`) REFERENCES \`adaptive_agent_process\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_adaptive_checkpoint_assignment_id_adaptive_assignment_id_fk\` FOREIGN KEY (\`assignment_id\`) REFERENCES \`adaptive_assignment\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "adaptive_checkpoint_sequence_check" CHECK("sequence" >= 0),
          CONSTRAINT "adaptive_checkpoint_generation_check" CHECK("generation" > 0),
          CONSTRAINT "adaptive_checkpoint_roadmap_revision_check" CHECK("roadmap_revision" > 0),
          CONSTRAINT "adaptive_checkpoint_diff_hash_check" CHECK(length("diff_hash") = 71 AND substr("diff_hash", 1, 7) = 'sha256:' AND substr("diff_hash", 8) NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "adaptive_checkpoint_event_cursor_check" CHECK("event_cursor" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`adaptive_context_manifest\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`purpose\` text NOT NULL,
          \`system\` text NOT NULL,
          \`messages\` text NOT NULL,
          \`tools\` text NOT NULL,
          \`components\` text NOT NULL,
          \`omissions\` text DEFAULT '[]' NOT NULL,
          \`estimated_tokens\` integer NOT NULL,
          \`roadmap_revision\` integer DEFAULT 0 NOT NULL,
          \`turn\` integer DEFAULT 0 NOT NULL,
          \`restart_reason\` text,
          \`request_hash\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_adaptive_context_manifest_task_id_adaptive_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`adaptive_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_adaptive_context_manifest_agent_id_adaptive_agent_process_id_fk\` FOREIGN KEY (\`agent_id\`) REFERENCES \`adaptive_agent_process\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "adaptive_manifest_generation_check" CHECK("generation" >= 0),
          CONSTRAINT "adaptive_manifest_purpose_check" CHECK(length("purpose") > 0),
          CONSTRAINT "adaptive_manifest_estimated_tokens_check" CHECK("estimated_tokens" >= 0),
          CONSTRAINT "adaptive_manifest_request_hash_check" CHECK(length("request_hash") > 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`adaptive_detail\` (
          \`task_id\` text NOT NULL,
          \`key\` text NOT NULL,
          \`version\` integer NOT NULL,
          \`node_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`status\` text NOT NULL,
          \`body\` text NOT NULL,
          \`content_hash\` text NOT NULL,
          \`source_agent_id\` text NOT NULL,
          \`source_generation\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`adaptive_detail_pk\` PRIMARY KEY(\`task_id\`, \`key\`, \`version\`),
          CONSTRAINT \`fk_adaptive_detail_task_id_adaptive_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`adaptive_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_adaptive_detail_source_agent_id_adaptive_agent_process_id_fk\` FOREIGN KEY (\`source_agent_id\`) REFERENCES \`adaptive_agent_process\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "adaptive_detail_key_check" CHECK(length("key") > 0),
          CONSTRAINT "adaptive_detail_version_check" CHECK("version" >= 0),
          CONSTRAINT "adaptive_detail_kind_check" CHECK("kind" IN ('requirements', 'contracts', 'decisions', 'validation')),
          CONSTRAINT "adaptive_detail_status_check" CHECK("status" IN ('unresolved', 'draft', 'ready', 'superseded')),
          CONSTRAINT "adaptive_detail_hash_check" CHECK(length("content_hash") = 71 AND substr("content_hash", 1, 7) = 'sha256:' AND substr("content_hash", 8) NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "adaptive_detail_source_generation_check" CHECK("source_generation" > 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`adaptive_model_request\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`agent_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`manifest_id\` text NOT NULL,
          \`retry_of\` text,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`variant\` text,
          \`effective_context_limit\` integer NOT NULL,
          \`output_reserve\` integer NOT NULL,
          \`safety_reserve\` integer NOT NULL,
          \`model_policy_hash\` text NOT NULL,
          \`resolved_provider_id\` text,
          \`resolved_model_id\` text,
          \`resolved_variant\` text,
          \`resolved_effective_context_limit\` integer,
          \`status\` text NOT NULL,
          \`input_tokens\` integer,
          \`output_tokens\` integer,
          \`failure\` text,
          \`time_created\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_adaptive_model_request_task_id_adaptive_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`adaptive_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_adaptive_model_request_agent_id_adaptive_agent_process_id_fk\` FOREIGN KEY (\`agent_id\`) REFERENCES \`adaptive_agent_process\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_adaptive_model_request_manifest_id_adaptive_context_manifest_id_fk\` FOREIGN KEY (\`manifest_id\`) REFERENCES \`adaptive_context_manifest\`(\`id\`),
          CONSTRAINT \`adaptive_model_request_retry_fk\` FOREIGN KEY (\`retry_of\`) REFERENCES \`adaptive_model_request\`(\`id\`),
          CONSTRAINT "adaptive_model_request_generation_check" CHECK("generation" >= 0),
          CONSTRAINT "adaptive_model_request_status_check" CHECK("status" IN ('admitted', 'streaming', 'succeeded', 'failed', 'interrupted')),
          CONSTRAINT "adaptive_model_request_effective_limit_check" CHECK("effective_context_limit" > 0),
          CONSTRAINT "adaptive_model_request_output_reserve_check" CHECK("output_reserve" > 0),
          CONSTRAINT "adaptive_model_request_safety_reserve_check" CHECK("safety_reserve" > 0),
          CONSTRAINT "adaptive_model_request_reserve_total_check" CHECK("output_reserve" + "safety_reserve" < "effective_context_limit"),
          CONSTRAINT "adaptive_model_request_policy_hash_check" CHECK(length("model_policy_hash") = 71 AND substr("model_policy_hash", 1, 7) = 'sha256:' AND substr("model_policy_hash", 8) NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "adaptive_model_request_resolved_tuple_check" CHECK(("resolved_provider_id" IS NULL AND "resolved_model_id" IS NULL AND "resolved_variant" IS NULL AND "resolved_effective_context_limit" IS NULL) OR ("resolved_provider_id" IS NOT NULL AND length("resolved_provider_id") > 0 AND "resolved_model_id" IS NOT NULL AND length("resolved_model_id") > 0 AND "resolved_effective_context_limit" > 0)),
          CONSTRAINT "adaptive_model_request_input_tokens_check" CHECK("input_tokens" IS NULL OR "input_tokens" >= 0),
          CONSTRAINT "adaptive_model_request_output_tokens_check" CHECK("output_tokens" IS NULL OR "output_tokens" >= 0),
          CONSTRAINT "adaptive_model_request_completion_check" CHECK(("status" IN ('admitted', 'streaming') AND "time_completed" IS NULL) OR ("status" IN ('succeeded', 'failed', 'interrupted') AND "time_completed" IS NOT NULL))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`adaptive_roadmap_revision\` (
          \`task_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`requirement\` text NOT NULL,
          \`roadmap\` text NOT NULL,
          \`content_hash\` text NOT NULL,
          \`source_agent_id\` text NOT NULL,
          \`source_generation\` integer NOT NULL,
          \`event_sequence\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`adaptive_roadmap_revision_pk\` PRIMARY KEY(\`task_id\`, \`revision\`),
          CONSTRAINT \`fk_adaptive_roadmap_revision_task_id_adaptive_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`adaptive_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_adaptive_roadmap_revision_source_agent_id_adaptive_agent_process_id_fk\` FOREIGN KEY (\`source_agent_id\`) REFERENCES \`adaptive_agent_process\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "adaptive_roadmap_revision_check" CHECK("revision" > 0),
          CONSTRAINT "adaptive_roadmap_hash_check" CHECK(length("content_hash") = 71 AND substr("content_hash", 1, 7) = 'sha256:' AND substr("content_hash", 8) NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "adaptive_roadmap_source_generation_check" CHECK("source_generation" > 0),
          CONSTRAINT "adaptive_roadmap_event_sequence_check" CHECK("event_sequence" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`adaptive_task\` (
          \`id\` text PRIMARY KEY,
          \`directory\` text NOT NULL,
          \`mode\` text NOT NULL,
          \`status\` text NOT NULL,
          \`requirement\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`variant\` text,
          \`effective_context_limit\` integer NOT NULL,
          \`output_reserve\` integer NOT NULL,
          \`safety_reserve\` integer NOT NULL,
          \`model_policy_hash\` text NOT NULL,
          \`roadmap_revision\` integer NOT NULL,
          \`base_snapshot_hash\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT "adaptive_task_mode_check" CHECK("mode" IN ('normal', 'benchmark')),
          CONSTRAINT "adaptive_task_status_check" CHECK("status" IN ('planning', 'running', 'needs_input', 'stopped', 'cancelled', 'failed', 'completed', 'invalid')),
          CONSTRAINT "adaptive_task_requirement_check" CHECK(length("requirement") > 0),
          CONSTRAINT "adaptive_task_directory_check" CHECK(length("directory") > 0),
          CONSTRAINT "adaptive_task_model_check" CHECK(length("provider_id") > 0 AND length("model_id") > 0),
          CONSTRAINT "adaptive_task_effective_limit_check" CHECK("effective_context_limit" > 0),
          CONSTRAINT "adaptive_task_output_reserve_check" CHECK("output_reserve" > 0),
          CONSTRAINT "adaptive_task_safety_reserve_check" CHECK("safety_reserve" > 0),
          CONSTRAINT "adaptive_task_reserve_total_check" CHECK("output_reserve" + "safety_reserve" < "effective_context_limit"),
          CONSTRAINT "adaptive_task_policy_hash_check" CHECK(length("model_policy_hash") = 71 AND substr("model_policy_hash", 1, 7) = 'sha256:' AND substr("model_policy_hash", 8) NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "adaptive_task_roadmap_revision_check" CHECK("roadmap_revision" >= 0),
          CONSTRAINT "adaptive_task_base_snapshot_hash_check" CHECK(length("base_snapshot_hash") > 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`adaptive_agent_task_state_idx\` ON \`adaptive_agent_process\` (\`task_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`adaptive_assignment_task_node_idx\` ON \`adaptive_assignment\` (\`task_id\`,\`node_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`adaptive_assignment_worker_generation_idx\` ON \`adaptive_assignment\` (\`worker_id\`,\`generation\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`adaptive_checkpoint_assignment_idx\` ON \`adaptive_checkpoint\` (\`assignment_id\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`adaptive_manifest_agent_time_idx\` ON \`adaptive_context_manifest\` (\`agent_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`adaptive_detail_task_node_idx\` ON \`adaptive_detail\` (\`task_id\`,\`node_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`adaptive_model_request_task_idx\` ON \`adaptive_model_request\` (\`task_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`adaptive_model_request_agent_idx\` ON \`adaptive_model_request\` (\`agent_id\`,\`generation\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`adaptive_roadmap_task_event_idx\` ON \`adaptive_roadmap_revision\` (\`task_id\`,\`event_sequence\`);`,
      )
      yield* tx.run(`CREATE INDEX \`adaptive_task_directory_idx\` ON \`adaptive_task\` (\`directory\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`message_session_time_created_id_idx\` ON \`message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_message_id_id_idx\` ON \`part\` (\`message_id\`,\`id\`);`)
      yield* tx.run(`CREATE INDEX \`part_session_idx\` ON \`part\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
