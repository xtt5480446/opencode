import { describe, expect, test } from "bun:test"
import { Effect, Exit, FileSystem, PlatformError } from "effect"
import { AdaptiveEvidence } from "@/adaptive/evidence"

describe("AdaptiveEvidence", () => {
  test("removes its newly created directory when an evidence write fails", async () => {
    const paths = new Set<string>()
    const removed: string[] = []
    let writes = 0
    const fs = FileSystem.makeNoop({
      makeDirectory: (path) =>
        Effect.sync(() => {
          paths.add(path)
        }),
      writeFileString: (path) =>
        Effect.gen(function* () {
          writes += 1
          if (writes === 2)
            return yield* PlatformError.systemError({
              _tag: "WriteZero",
              module: "FileSystem",
              method: "writeFileString",
              pathOrDescriptor: path,
            })
          paths.add(path)
        }),
      remove: (path) =>
        Effect.sync(() => {
          removed.push(path)
          for (const entry of paths) if (entry === path || entry.startsWith(path + "/")) paths.delete(entry)
        }),
    })

    const result = await Effect.runPromise(
      AdaptiveEvidence.write(fs, "/evidence", {
        "doctor.json": "{}\n",
        "model-requests.jsonl": "{}\n",
      }).pipe(Effect.exit),
    )

    expect(Exit.isFailure(result)).toBe(true)
    expect(removed).toEqual(["/evidence"])
    expect(paths.size).toBe(0)
  })
})
