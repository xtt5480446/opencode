import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260613210000_backfill_project_copy_strategy",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `UPDATE \`project_directory\` SET \`strategy\` = 'git_worktree' WHERE \`type\` = 'git_worktree' AND \`strategy\` IS NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
