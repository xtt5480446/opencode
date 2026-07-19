import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260719101547_adaptive_model_request_resolved_observation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA defer_foreign_keys=ON;`)
      yield* tx.run(`ALTER TABLE \`adaptive_model_request\` ADD \`resolved_provider_id\` text;`)
      yield* tx.run(`ALTER TABLE \`adaptive_model_request\` ADD \`resolved_model_id\` text;`)
      yield* tx.run(`ALTER TABLE \`adaptive_model_request\` ADD \`resolved_variant\` text;`)
      yield* tx.run(`ALTER TABLE \`adaptive_model_request\` ADD \`resolved_effective_context_limit\` integer;`)
      yield* tx.run(`
        CREATE TABLE \`__new_adaptive_model_request\` (
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
          CONSTRAINT \`adaptive_model_request_retry_fk\` FOREIGN KEY (\`retry_of\`) REFERENCES \`__new_adaptive_model_request\`(\`id\`),
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
      yield* tx.run(
        `INSERT INTO \`__new_adaptive_model_request\`(\`id\`, \`task_id\`, \`agent_id\`, \`generation\`, \`manifest_id\`, \`retry_of\`, \`provider_id\`, \`model_id\`, \`variant\`, \`effective_context_limit\`, \`output_reserve\`, \`safety_reserve\`, \`model_policy_hash\`, \`status\`, \`input_tokens\`, \`output_tokens\`, \`failure\`, \`time_created\`, \`time_completed\`) SELECT \`id\`, \`task_id\`, \`agent_id\`, \`generation\`, \`manifest_id\`, \`retry_of\`, \`provider_id\`, \`model_id\`, \`variant\`, \`effective_context_limit\`, \`output_reserve\`, \`safety_reserve\`, \`model_policy_hash\`, \`status\`, \`input_tokens\`, \`output_tokens\`, \`failure\`, \`time_created\`, \`time_completed\` FROM \`adaptive_model_request\`;`,
      )
      yield* tx.run(`DROP TABLE \`adaptive_model_request\`;`)
      yield* tx.run(`ALTER TABLE \`__new_adaptive_model_request\` RENAME TO \`adaptive_model_request\`;`)
      yield* tx.run(
        `CREATE INDEX \`adaptive_model_request_task_idx\` ON \`adaptive_model_request\` (\`task_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`adaptive_model_request_agent_idx\` ON \`adaptive_model_request\` (\`agent_id\`,\`generation\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
