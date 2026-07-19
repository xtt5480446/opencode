import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260719162735_adaptive_agent_quarantine",
  foreignKeys: "disabled",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`__new_adaptive_agent_process\` (
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
          CONSTRAINT "adaptive_agent_owner_tuple_check" CHECK(("owner" IS NULL AND "pid" IS NULL AND "lease_expires_at" IS NULL) OR ("owner" IS NOT NULL AND length("owner") > 0 AND "pid" > 0 AND (("state" IN ('starting', 'running') AND "lease_expires_at" > 0) OR ("state" = 'failed' AND "lease_expires_at" IS NULL)))),
          CONSTRAINT "adaptive_agent_state_owner_check" CHECK(("state" IN ('starting', 'running') AND "owner" IS NOT NULL) OR ("state" IN ('idle', 'stopped', 'lost') AND "owner" IS NULL) OR "state" = 'failed')
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_adaptive_agent_process\`(\`id\`, \`task_id\`, \`role\`, \`generation\`, \`state\`, \`owner\`, \`pid\`, \`lease_expires_at\`, \`exit_code\`, \`exit_reason\`, \`time_created\`, \`time_updated\`) SELECT \`id\`, \`task_id\`, \`role\`, \`generation\`, \`state\`, \`owner\`, \`pid\`, \`lease_expires_at\`, \`exit_code\`, \`exit_reason\`, \`time_created\`, \`time_updated\` FROM \`adaptive_agent_process\`;`,
      )
      yield* tx.run(`DROP TABLE \`adaptive_agent_process\`;`)
      yield* tx.run(`ALTER TABLE \`__new_adaptive_agent_process\` RENAME TO \`adaptive_agent_process\`;`)
      yield* tx.run(
        `CREATE INDEX \`adaptive_agent_task_state_idx\` ON \`adaptive_agent_process\` (\`task_id\`,\`state\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
