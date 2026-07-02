export * as Database from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Config, Context, Effect, Layer, Option } from "effect"
import { Global } from "../global"
import { truthy } from "../flag/flag"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration"
import { InstallationChannel } from "../installation/version"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

/** One placement rule shared by the config-backed layer and the V1 `path()` helper. */
export function resolvePath(input: { readonly file: string | undefined; readonly disableChannelDb: boolean }) {
  if (input.file) {
    if (input.file === ":memory:" || isAbsolute(input.file)) return input.file
    return join(Global.Path.data, input.file)
  }
  if (["latest", "beta", "prod"].includes(InstallationChannel) || input.disableChannelDb)
    return join(Global.Path.data, "opencode.db")
  return join(Global.Path.data, `opencode-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}

/** V1 compatibility helper; reads the process environment at call time. */
export function path() {
  return resolvePath({
    file: process.env.OPENCODE_DB,
    disableChannelDb: truthy("OPENCODE_DISABLE_CHANNEL_DB"),
  })
}

// Placement is resolved through Effect Config when the layer is built, not at
// module import, so tests and tooling can override it with a ConfigProvider.
const configuredLayer = Layer.unwrap(
  Effect.gen(function* () {
    const file = yield* Config.option(Config.string("OPENCODE_DB"))
    const disableChannelDb = yield* Config.boolean("OPENCODE_DISABLE_CHANNEL_DB").pipe(Config.withDefault(false))
    return layerFromPath(resolvePath({ file: Option.getOrUndefined(file), disableChannelDb }))
  }).pipe(Effect.orDie),
)

export const node = makeGlobalNode({ service: Service, layer: configuredLayer, deps: [] })
