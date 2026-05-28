export * as Config from "./config"

import path from "path"
import { type ParseError, parse } from "jsonc-parser"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { AppFileSystem } from "../filesystem"
import { Global } from "../global"
import { Location } from "../location"
import { Policy } from "../policy"
import { AbsolutePath } from "../schema"
import { ConfigV2 } from "./schema"

export interface Interface {
  /** Returns supplemental config directories from lowest to highest priority. */
  readonly directories: () => Effect.Effect<AbsolutePath[]>
  /** Loads location config files from lowest to highest priority. */
  readonly get: () => Effect.Effect<ConfigV2.Loaded[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Config") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const policy = yield* Policy.Service
    const names = ["config.json", "opencode.json", "opencode.jsonc"]

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      const text = yield* fs.readFileStringSafe(filepath)
      if (!text) return

      const errors: ParseError[] = []
      const input: unknown = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return

      // Accept legacy fields while v2 is migrated incrementally; recognized
      // fields still have to satisfy the v2 schema.
      const info = Option.getOrUndefined(
        Schema.decodeUnknownOption(ConfigV2.Info)(input, { errors: "all", onExcessProperty: "ignore" }),
      )
      if (!info) return
      return new ConfigV2.Loaded({ source: new ConfigV2.FileSource({ type: "file", path: filepath }), info })
    })

    const loadDirectory = Effect.fnUntraced(function* (directory: AbsolutePath) {
      return yield* Effect.forEach(names, (file) => loadFile(path.join(directory, file))).pipe(
        Effect.map((configs) => configs.filter((config): config is ConfigV2.Loaded => config !== undefined)),
      )
    })

    const globalDirectory = AbsolutePath.make(global.config)
    const locationIsGlobal = path.resolve(location.directory) === path.resolve(global.config)
    // Read configuration once when this location opens. Later calls reuse these
    // values until the location is reopened.
    const directories = locationIsGlobal
      ? [globalDirectory]
      : [
          globalDirectory,
          ...(yield* fs
            .up({ targets: [".opencode"], start: location.directory, stop: location.project.directory })
            .pipe(Effect.orDie))
            .toReversed()
            .map((directory) => AbsolutePath.make(directory)),
        ]
    // A config closer to the opened directory should win over one higher up.
    // Search starts nearby, so reverse the results before applying them.
    const directPaths = locationIsGlobal
      ? []
      : (yield* fs
          .up({ targets: names.toReversed(), start: location.directory, stop: location.project.directory })
          .pipe(Effect.orDie)).toReversed()
    const direct = yield* Effect.forEach(directPaths, loadFile).pipe(
      Effect.orDie,
      Effect.map((configs) => configs.filter((config): config is ConfigV2.Loaded => config !== undefined)),
    )
    const supplementary = yield* Effect.forEach(directories, loadDirectory).pipe(Effect.orDie)
    // Apply general settings first and more specific settings last:
    // global config, project files, then `.opencode` files.
    const configs = [...(supplementary[0] ?? []), ...direct, ...supplementary.slice(1).flat()]
    // Rules use the opposite order so a user-global rule can override a
    // repository rule. Statement order inside each file stays unchanged.
    yield* policy.load(configs.toReversed().flatMap((config) => config.info.policies ?? []))

    return Service.of({
      directories: Effect.fn("Config.directories")(function* () {
        return directories
      }),
      get: Effect.fn("Config.get")(function* () {
        return configs
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Global.defaultLayer),
)
