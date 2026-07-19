export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  foreignKeys?: "disabled"
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

const readForeignKeys = (db: Database) =>
  db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`).pipe(
    Effect.flatMap((row) => {
      const value = row?.foreign_keys
      return value === 0 || value === 1
        ? Effect.succeed(value as 0 | 1)
        : Effect.fail(new Error("Database migration could not read PRAGMA foreign_keys"))
    }),
  )

const setForeignKeys = (db: Database, value: 0 | 1) =>
  db.run(value === 0 ? sql`PRAGMA foreign_keys = OFF` : sql`PRAGMA foreign_keys = ON`).pipe(
    Effect.andThen(readForeignKeys(db)),
    Effect.flatMap((actual) =>
      actual === value
        ? Effect.void
        : Effect.fail(new Error(`Database migration could not set PRAGMA foreign_keys to ${value}`)),
    ),
  )

export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations)
      if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          yield* Effect.forEach(migrations, (migration) =>
            tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            ),
          )
        }),
      )
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        yield* db.run(sql`
          INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
          SELECT name, ${Date.now()}
          FROM ${sql.identifier("__drizzle_migrations")}
          WHERE name IS NOT NULL
        `)
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      const run = (checkForeignKeys: boolean) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* migration.up(tx)
            yield* tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            )
            if (!checkForeignKeys) return
            const violations = yield* tx.all<{ table: string; rowid: number; parent: string; fkid: number }>(
              sql`PRAGMA foreign_key_check`,
            )
            if (violations.length > 0)
              return yield* Effect.fail(
                new Error(
                  `Database migration foreign key check failed for ${migration.id}: ${JSON.stringify(violations)}`,
                ),
              )
          }),
        )
      if (migration.foreignKeys !== "disabled") {
        yield* run(false)
        continue
      }

      const originalForeignKeys = yield* readForeignKeys(db)
      yield* Effect.gen(function* () {
        yield* setForeignKeys(db, 0)
        yield* run(true)
      }).pipe(Effect.ensuring(setForeignKeys(db, originalForeignKeys).pipe(Effect.orDie)))
    }
  })
}
