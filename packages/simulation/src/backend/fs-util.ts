import { Effect, FileSystem, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Glob } from "@opencode-ai/core/util/glob"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { filesystem } from "@opencode-ai/core/effect/app-node-platform"
import path from "path"
import { SimulationLog } from "../log"

/**
 * Simulation replacement for `FSUtil`.
 *
 * This implementation is intentionally self-contained and only uses the
 * injected simulated `FileSystem.FileSystem`. The default FSUtil layer has a
 * few helpers that reach host-node APIs directly; depending on it here makes it
 * easy for mutation paths to escape or miss the in-memory project tree.
 */

const layer = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const existsSafe = Effect.fn("SimulationFSUtil.existsSafe")(function* (file: string) {
      const result = yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))
      SimulationLog.add("fsutil.existsSafe", { file, result })
      return result
    })

    const isDir = Effect.fn("SimulationFSUtil.isDir")(function* (file: string) {
      const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const result = info?.type === "Directory"
      SimulationLog.add("fsutil.isDir", { file, result, type: info?.type })
      return result
    })

    const isFile = Effect.fn("SimulationFSUtil.isFile")(function* (file: string) {
      const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const result = info?.type === "File"
      SimulationLog.add("fsutil.isFile", { file, result, type: info?.type })
      return result
    })

    const realPath = Effect.fn("SimulationFSUtil.realPath")(function* (file: string) {
      SimulationLog.add("fsutil.realPath", { file })
      const result = yield* fs.realPath(file)
      SimulationLog.add("fsutil.realPath.result", { file, result })
      return result
    })

    const stat = Effect.fn("SimulationFSUtil.stat")(function* (file: string) {
      SimulationLog.add("fsutil.stat", { file })
      const result = yield* fs.stat(file)
      SimulationLog.add("fsutil.stat.result", { file, type: result.type })
      return result
    })

    const readFile = Effect.fn("SimulationFSUtil.readFile")(function* (file: string) {
      SimulationLog.add("fsutil.readFile", { file })
      const result = yield* fs.readFile(file)
      SimulationLog.add("fsutil.readFile.result", { file, bytes: result.length })
      return result
    })

    const readFileString = Effect.fn("SimulationFSUtil.readFileString")(function* (file: string) {
      SimulationLog.add("fsutil.readFileString", { file })
      const result = yield* fs.readFileString(file)
      SimulationLog.add("fsutil.readFileString.result", { file, bytes: result.length })
      return result
    })

    const readFileStringSafe = Effect.fn("SimulationFSUtil.readFileStringSafe")(function* (file: string) {
      const result = yield* fs
        .readFileString(file)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
      SimulationLog.add("fsutil.readFileStringSafe", { file, found: result !== undefined, bytes: result?.length })
      return result
    })

    const readJson = Effect.fn("SimulationFSUtil.readJson")(function* (file: string) {
      const text = yield* readFileString(file)
      return JSON.parse(text) as unknown
    })

    const writeFile = Effect.fn("SimulationFSUtil.writeFile")(function* (
      file: string,
      data: Uint8Array,
      options?: Parameters<typeof fs.writeFile>[2],
    ) {
      SimulationLog.add("fsutil.writeFile", { file, bytes: data.length })
      const result = yield* fs.writeFile(file, data, options)
      SimulationLog.add("fsutil.writeFile.result", { file, bytes: data.length })
      return result
    })

    const writeFileString = Effect.fn("SimulationFSUtil.writeFileString")(function* (
      file: string,
      data: string,
      options?: Parameters<typeof fs.writeFileString>[2],
    ) {
      SimulationLog.add("fsutil.writeFileString", { file, bytes: data.length })
      const result = yield* fs.writeFileString(file, data, options)
      SimulationLog.add("fsutil.writeFileString.result", { file, bytes: data.length })
      return result
    })

    const makeDirectory: FileSystem.FileSystem["makeDirectory"] = (file, options) => fs.makeDirectory(file, options)

    const ensureDir = Effect.fn("SimulationFSUtil.ensureDir")(function* (file: string) {
      SimulationLog.add("fsutil.ensureDir", { file })
      yield* fs.makeDirectory(file, { recursive: true })
      SimulationLog.add("fsutil.ensureDir.result", { file })
    })

    const writeWithDirs = Effect.fn("SimulationFSUtil.writeWithDirs")(function* (
      file: string,
      content: string | Uint8Array,
      mode?: number,
    ) {
      SimulationLog.add("fsutil.writeWithDirs", {
        file,
        bytes: typeof content === "string" ? content.length : content.length,
      })
      const write =
        typeof content === "string"
          ? fs.writeFileString(file, content)
          : fs.writeFile(file, content)
      yield* write.pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.andThen(write)),
        ),
      )
      if (mode !== undefined) yield* fs.chmod(file, mode)
      SimulationLog.add("fsutil.writeWithDirs.result", { file })
    })

    const writeJson = Effect.fn("SimulationFSUtil.writeJson")(function* (file: string, data: unknown, mode?: number) {
      yield* writeFileString(file, JSON.stringify(data, null, 2))
      if (mode !== undefined) yield* fs.chmod(file, mode)
    })

    const readDirectoryEntries = Effect.fn("SimulationFSUtil.readDirectoryEntries")(function* (dirPath: string) {
      SimulationLog.add("fsutil.readDirectoryEntries", { dirPath })
      const names = yield* fs.readDirectory(dirPath)
      return yield* Effect.forEach(names, (name) =>
        fs.stat(path.join(dirPath, name)).pipe(
          Effect.map(
            (info): FSUtil.DirEntry => ({
              name,
              type:
                info.type === "Directory"
                  ? "directory"
                  : info.type === "File"
                    ? "file"
                    : info.type === "SymbolicLink"
                      ? "symlink"
                      : "other",
            }),
          ),
          Effect.orElseSucceed((): FSUtil.DirEntry => ({ name, type: "other" })),
        ),
      )
    })

    const resolve = Effect.fn("SimulationFSUtil.resolve")(function* (input: string) {
      const result = path.resolve(input)
      SimulationLog.add("fsutil.resolve", { input, result })
      return result
    })

    const glob = Effect.fn("SimulationFSUtil.glob")(function* (pattern: string, options?: Glob.Options) {
      const cwd = path.resolve(options?.cwd ?? process.cwd())
      SimulationLog.add("fsutil.glob", { pattern, cwd, options })
      const entries = yield* fs
        .readDirectory(cwd, { recursive: true })
        .pipe(Effect.orElseSucceed(() => [] as string[]))
      const matches = yield* Effect.forEach(entries, (entry) =>
        fs.stat(path.join(cwd, entry)).pipe(
          Effect.map((info) => ({ entry, type: info.type })),
          Effect.orElseSucceed(() => undefined),
        ),
      )
      const result = matches
        .filter((item) => item !== undefined)
        .filter((item) => options?.include === "all" || item.type === "File")
        .filter((item) => Glob.match(pattern, item.entry))
        .map((item) => (options?.absolute ? path.join(cwd, item.entry) : item.entry))
        .sort((a, b) => a.localeCompare(b))
      SimulationLog.add("fsutil.glob.result", { pattern, cwd, result })
      return result
    })

    const globUp = Effect.fn("SimulationFSUtil.globUp")(function* (pattern: string, start: string, stop?: string) {
      SimulationLog.add("fsutil.globUp", { pattern, start, stop })
      const result: string[] = []
      let current = path.resolve(start)
      while (true) {
        result.push(...(yield* glob(pattern, { cwd: current, absolute: true, include: "file", dot: true })))
        if (stop === current) break
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
      SimulationLog.add("fsutil.globUp.result", { pattern, start, stop, result })
      return result
    })

    const up = Effect.fn("SimulationFSUtil.up")(function* (options: { targets: string[]; start: string; stop?: string }) {
      SimulationLog.add("fsutil.up", options)
      const result: string[] = []
      let current = path.resolve(options.start)
      while (true) {
        for (const target of options.targets) {
          const search = path.join(current, target)
          if (yield* fs.exists(search)) result.push(search)
        }
        if (options.stop === current) break
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
      SimulationLog.add("fsutil.up.result", { ...options, result })
      return result
    })

    const findUp = Effect.fn("SimulationFSUtil.findUp")(function* (target: string, start: string, stop?: string) {
      return yield* up({ targets: [target], start, stop })
    })

    return FSUtil.Service.of({
      ...fs,
      realPath,
      stat,
      readFile,
      readFileString,
      writeFile,
      writeFileString,
      makeDirectory,
      isDir,
      isFile,
      existsSafe,
      readFileStringSafe,
      readJson,
      writeJson,
      ensureDir,
      writeWithDirs,
      readDirectoryEntries,
      resolve,
      findUp,
      up,
      globUp,
      glob,
      globMatch: Glob.match,
    })
  }),
)

export const node = makeGlobalNode({ service: FSUtil.Service, layer, deps: [filesystem] })

export * as SimulationFSUtil from "./fs-util"
