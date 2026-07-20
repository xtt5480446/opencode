import { Effect, Exit, FileSystem, PlatformError, Schema } from "effect"
import { join } from "node:path"

export class WriteError extends Schema.TaggedErrorClass<WriteError>()("AdaptiveEvidence.WriteError", {
  reason: Schema.Literals(["exists", "write", "cleanup"]),
}) {}

export const write = Effect.fn("AdaptiveEvidence.write")(function* (
  fs: Pick<FileSystem.FileSystem, "makeDirectory" | "writeFileString" | "remove">,
  output: string,
  files: Readonly<Record<string, string>>,
) {
  yield* fs.makeDirectory(output, { mode: 0o700 }).pipe(
    Effect.mapError(
      (cause) =>
        new WriteError({
          reason:
            cause.reason instanceof PlatformError.SystemError && cause.reason._tag === "AlreadyExists"
              ? "exists"
              : "write",
        }),
    ),
  )
  const written = yield* Effect.forEach(Object.entries(files), ([name, value]) =>
    fs.writeFileString(join(output, name), value, { flag: "wx", mode: 0o600 }),
  ).pipe(Effect.exit)
  if (Exit.isSuccess(written)) return

  const cleanup = yield* fs.remove(output, { recursive: true, force: true }).pipe(Effect.exit)
  if (Exit.isFailure(cleanup)) return yield* new WriteError({ reason: "cleanup" })
  return yield* new WriteError({ reason: "write" })
})

export * as AdaptiveEvidence from "./evidence"
