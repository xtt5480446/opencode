/* oxlint-disable */
import type { MigrationConfig, MigrationFromJournalConfig, MigrationsJournal } from "drizzle-orm/migrator"
import { readMigrationFiles } from "drizzle-orm/migrator"
import type { AnyRelations } from "drizzle-orm/relations"
import crypto from "node:crypto"
import { migrate as coreMigrate } from "../sqlite-core/effect/session"
import type { EffectSQLiteDatabase } from "./driver"

export function migrate<TRelations extends AnyRelations>(
  db: EffectSQLiteDatabase<TRelations>,
  config: MigrationConfig,
) {
  const migrations = readMigrationFiles(config)
  return coreMigrate(migrations, db.session, config)
}

export function migrateFromJournal<TRelations extends AnyRelations>(
  db: EffectSQLiteDatabase<TRelations>,
  journal: MigrationsJournal,
  config: Omit<MigrationFromJournalConfig, "migrationsJournal"> = {},
) {
  return coreMigrate(
    journal.map((migration) => ({
      sql: migration.sql.split("--> statement-breakpoint"),
      bps: true,
      folderMillis: migration.timestamp,
      hash: crypto.createHash("sha256").update(migration.sql).digest("hex"),
      name: migration.name,
    })),
    db.session,
    { migrationsFolder: "", migrationsTable: config.migrationsTable },
  )
}
