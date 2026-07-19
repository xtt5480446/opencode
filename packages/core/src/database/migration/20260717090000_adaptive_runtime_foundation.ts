import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260717090000_adaptive_runtime_foundation",
  up(tx) {
    return Effect.gen(function* () {
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
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_adaptive_agent_process_task_id_adaptive_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`adaptive_task\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "adaptive_agent_role_check" CHECK("role" IN ('coordinator', 'roadmap-reviewer', 'discovery', 'implementation', 'validator', 'integration')),
          CONSTRAINT "adaptive_agent_state_check" CHECK("state" IN ('idle', 'starting', 'running', 'stopped', 'lost', 'failed')),
          CONSTRAINT "adaptive_agent_generation_check" CHECK("generation" >= 0),
          CONSTRAINT "adaptive_agent_owner_tuple_check" CHECK(("owner" IS NULL AND "pid" IS NULL AND "lease_expires_at" IS NULL) OR ("owner" IS NOT NULL AND length("owner") > 0 AND "pid" > 0 AND "lease_expires_at" > 0)),
          CONSTRAINT "adaptive_agent_state_owner_check" CHECK(("state" IN ('starting', 'running') AND "owner" IS NOT NULL) OR ("state" IN ('idle', 'stopped', 'lost', 'failed') AND "owner" IS NULL))
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
          \`estimated_tokens\` integer NOT NULL,
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
          CONSTRAINT "adaptive_model_request_input_tokens_check" CHECK("input_tokens" IS NULL OR "input_tokens" >= 0),
          CONSTRAINT "adaptive_model_request_output_tokens_check" CHECK("output_tokens" IS NULL OR "output_tokens" >= 0),
          CONSTRAINT "adaptive_model_request_completion_check" CHECK(("status" IN ('admitted', 'streaming') AND "time_completed" IS NULL) OR ("status" IN ('succeeded', 'failed', 'interrupted') AND "time_completed" IS NOT NULL))
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
      yield* tx.run(
        `CREATE INDEX \`adaptive_agent_task_state_idx\` ON \`adaptive_agent_process\` (\`task_id\`,\`state\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`adaptive_manifest_agent_time_idx\` ON \`adaptive_context_manifest\` (\`agent_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`adaptive_model_request_task_idx\` ON \`adaptive_model_request\` (\`task_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`adaptive_model_request_agent_idx\` ON \`adaptive_model_request\` (\`agent_id\`,\`generation\`);`,
      )
      yield* tx.run(`CREATE INDEX \`adaptive_task_directory_idx\` ON \`adaptive_task\` (\`directory\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
