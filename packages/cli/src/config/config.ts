export * as Config from "./config"

import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { Context, Effect, FileSystem, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { produce, type Draft } from "immer"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import path from "path"
import { ConfigMigration } from "./migrate"
import { Info } from "./schema"

export * from "./schema"

export interface Interface {
  readonly path: string
  readonly get: () => Effect.Effect<Info>
  readonly update: (update: (draft: Draft<Info>) => void) => Effect.Effect<Info, Error>
  readonly changes: Stream.Stream<Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/cli/config/Config") {}

const decode = Schema.decodeUnknownOption(Info)
const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Any))
const empty: Info = {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const global = yield* Global.Service
    const file = path.join(global.config, "cli.json")
    const lock = yield* Semaphore.make(1)

    const readJson = Effect.fnUntraced(function* () {
      const text = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (text === undefined) return undefined
      const errors: ParseError[] = []
      const value: any = parse(text, errors, { allowTrailingComma: true })
      if (errors.length) return undefined
      return Option.getOrUndefined(decodeRecord(value))
    })

    const write = Effect.fnUntraced(function* (text: string) {
      const temp = file + ".tmp"
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(temp, text, { mode: 0o600 })
      yield* fs.rename(temp, file)
    })

    const migrate = ConfigMigration.run({ file, config: global.config, state: global.state }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    )
    const withFileLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(Flock.effect("cli-config", { dir: path.join(global.state, "locks") }).pipe(Effect.andThen(effect)))

    const get = Effect.fn("cli.config.get")(function* () {
      yield* withFileLock(migrate).pipe(
        Effect.catchCause((cause) => Effect.logWarning("failed to migrate cli config", { cause })),
      )
      return Option.getOrElse(decode(yield* readJson()), () => empty)
    })

    const update = Effect.fn("cli.config.update")((update: (draft: Draft<Info>) => void) =>
      lock
        .withPermits(1)(
          withFileLock(
            Effect.gen(function* () {
              yield* migrate
              const current = Option.getOrElse(decode(yield* readJson()), () => empty)
              const next = produce(current, update)
              const edits = diff(current, next)
              if (!edits.length) return current
              const text = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("{}")))
              const updated = edits.reduce(
                (text, edit) =>
                  applyEdits(
                    text,
                    modify(text, edit.path, edit.value, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
                  ),
                text,
              )
              const errors: ParseError[] = []
              const config = Option.getOrUndefined(decode(parse(updated, errors, { allowTrailingComma: true })))
              if (errors.length || config === undefined)
                return yield* Effect.fail(new Error("Invalid CLI config update"))
              yield* write(updated.endsWith("\n") ? updated : updated + "\n")
              return config
            }),
          ),
        )
        .pipe(Effect.mapError((cause) => new Error("Failed to update CLI config", { cause }))),
    )

    const changes = fs.watch(path.dirname(file)).pipe(
      Stream.filter((event) => path.resolve(path.dirname(file), event.path) === path.resolve(file)),
      Stream.debounce("50 millis"),
      Stream.mapEffect(() => get()),
      Stream.catchCause((cause) =>
        Stream.fromEffect(Effect.logWarning("failed to watch cli config", { cause })).pipe(Stream.drain),
      ),
    )

    return Service.of({ path: file, get, update, changes })
  }),
)

type Edit = { readonly path: (string | number)[]; readonly value: any }

function diff(before: any, after: any, path: (string | number)[] = []): Edit[] {
  if (Object.is(before, after)) return []
  if (
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => {
      if (!(key in after)) return [{ path: [...path, key], value: undefined }]
      if (!(key in before)) return [{ path: [...path, key], value: after[key] }]
      return diff(before[key], after[key], [...path, key])
    })
  }
  return [{ path, value: after }]
}
