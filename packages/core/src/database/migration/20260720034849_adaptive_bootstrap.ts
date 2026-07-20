import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260720034849_adaptive_bootstrap",
  up(tx) {
    return Effect.gen(function* () {
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
    })
  },
} satisfies DatabaseMigration.Migration
