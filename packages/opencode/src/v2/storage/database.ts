import { Database as LegacyDatabase } from "@/storage/db"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Context, Effect, Layer } from "effect"
import path from "path"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export class Service extends Context.Service<Service, DatabaseShape>()("@opencode/v2/storage/Database") {}

export const layer = Layer.unwrap(
  Effect.sync(() => {
    const filename = LegacyDatabase.getPath()
    return Layer.effect(
      Service,
      Effect.gen(function* () {
        LegacyDatabase.Client()
        const db = yield* makeDatabase
        yield* db.run("PRAGMA journal_mode = WAL")
        yield* db.run("PRAGMA synchronous = NORMAL")
        yield* db.run("PRAGMA busy_timeout = 5000")
        yield* db.run("PRAGMA cache_size = -64000")
        yield* db.run("PRAGMA foreign_keys = ON")
        yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
        if (filename === ":memory:") {
          yield* EffectDrizzleSqlite.migrate(db, {
            migrationsFolder: path.join(import.meta.dirname, "../../../migration"),
          })
        }
        return db
      }),
    ).pipe(Layer.provide(SqliteClient.layer({ filename, disableWAL: filename === ":memory:" })))
  }),
)

export const defaultLayer = layer

export * as StorageDatabase from "./database"
