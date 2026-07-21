import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260721092343_adaptive_recovery_state",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`ALTER TABLE \`adaptive_agent_process\` ADD \`node_id\` text;`)
      yield* tx.run(`ALTER TABLE \`adaptive_agent_process\` ADD \`tool_session_id\` text;`)
      yield* tx.run(`ALTER TABLE \`adaptive_agent_process\` ADD \`assignment_id\` text;`)
      yield* tx.run(`ALTER TABLE \`adaptive_agent_process\` ADD \`event_cursor\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`adaptive_agent_process\` ADD \`checkpoint_sequence\` integer;`)
      yield* tx.run(`ALTER TABLE \`adaptive_agent_process\` ADD \`recovery_state\` text DEFAULT 'ready' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`adaptive_agent_process\` ADD \`restart_required\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`adaptive_context_manifest\` ADD \`omissions\` text DEFAULT '[]' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`adaptive_context_manifest\` ADD \`roadmap_revision\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`adaptive_context_manifest\` ADD \`turn\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`adaptive_context_manifest\` ADD \`restart_reason\` text;`)
      yield* tx.run(
        `CREATE INDEX \`adaptive_assignment_task_node_idx\` ON \`adaptive_assignment\` (\`task_id\`,\`node_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`adaptive_assignment_worker_generation_idx\` ON \`adaptive_assignment\` (\`worker_id\`,\`generation\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`adaptive_checkpoint_assignment_idx\` ON \`adaptive_checkpoint\` (\`assignment_id\`,\`sequence\`);`,
      )
      yield* tx.run(`CREATE INDEX \`adaptive_detail_task_node_idx\` ON \`adaptive_detail\` (\`task_id\`,\`node_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`adaptive_roadmap_task_event_idx\` ON \`adaptive_roadmap_revision\` (\`task_id\`,\`event_sequence\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
