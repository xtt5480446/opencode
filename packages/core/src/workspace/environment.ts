export * as WorkspaceEnvironment from "./environment"

import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { PlatformError, systemError } from "effect/PlatformError"
import { ChildProcessSpawner, make } from "effect/unstable/process/ChildProcessSpawner"
import { AppProcess } from "../process"
import { makeLocationNode, tags } from "../effect/app-node"
import { LayerNode } from "../effect/layer-node"
import { FSUtil } from "../fs-util"
import { KeyedMutex } from "../effect/keyed-mutex"
import { Location } from "../location"
import { RipgrepBinary } from "../ripgrep/binary"
import { ShellSelect } from "../shell/select"
import { WorkspaceV2 } from "../workspace"
import path from "path"

export class Error extends Schema.TaggedErrorClass<Error>()("WorkspaceEnvironment.Error", {
  operation: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class StaleContentError extends Schema.TaggedErrorClass<StaleContentError>()(
  "WorkspaceEnvironment.StaleContentError",
  { path: Schema.String },
) {}

export interface FileInfo {
  readonly type: FileSystem.File.Type
}

export interface ResolvedPath extends FileInfo {
  readonly canonical: string
  readonly directory: string
}

export interface DirectoryEntry {
  readonly name: string
  readonly type: "file" | "directory" | "symlink" | "other"
}

export interface FileBackend {
  readonly inspect: (path: string) => Effect.Effect<FileInfo, Error>
  readonly resolve: (path: string) => Effect.Effect<ResolvedPath, Error>
  readonly read: (path: string) => Effect.Effect<Uint8Array, Error>
  readonly list: (path: string) => Effect.Effect<readonly DirectoryEntry[], Error>
  readonly ensureDirectory: (path: string) => Effect.Effect<void, Error>
  readonly createExclusive: (path: string, content: Uint8Array) => Effect.Effect<void, Error>
  readonly write: (path: string, content: Uint8Array) => Effect.Effect<void, Error>
  readonly writeIfUnchanged: (
    path: string,
    expected: Uint8Array,
    content: Uint8Array,
  ) => Effect.Effect<void, Error | StaleContentError>
  readonly remove: (path: string) => Effect.Effect<void, Error>
}

export interface Shell {
  readonly executable: string
  readonly args: (command: string) => readonly string[]
  readonly environmentOverrides: Readonly<Record<string, string>>
  readonly detached: boolean
}

export interface Interface {
  readonly platform: NodeJS.Platform
  readonly directory: string
  readonly files: FileBackend
  readonly process: ChildProcessSpawner["Service"]
  readonly shell: Shell
  readonly ripgrep: Effect.Effect<string, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkspaceEnvironment") {}

export const node = LayerNode.unbound(Service, tags.values.location)

const wrap = <A>(operation: string, path: string | undefined, effect: Effect.Effect<A, unknown>) =>
  effect.pipe(Effect.mapError((cause) => new Error({ operation, path, cause })))

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

const local = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FSUtil.Service
  const proc = yield* AppProcess.Service
  const ripgrep = yield* RipgrepBinary.Service
  const locks = KeyedMutex.makeUnsafe<string>()
  const mutate = (path: string, effect: Effect.Effect<void, unknown>) =>
    locks.withLock(path)(Effect.uninterruptible(effect))
  const notFound = <A>(effect: Effect.Effect<A, FSUtil.Error>) =>
    effect.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
  const resolve = Effect.fn("WorkspaceEnvironment.resolve")(function* (absolute: string) {
    const existing = yield* notFound(fs.realPath(absolute))
    if (existing) {
      const info = yield* fs.stat(existing)
      return {
        canonical: existing,
        directory: info.type === "Directory" ? existing : path.dirname(existing),
        type: info.type,
      }
    }

    let anchor = path.dirname(absolute)
    while (true) {
      const canonical = yield* notFound(fs.realPath(anchor))
      if (canonical) {
        const info = yield* fs.stat(canonical)
        if (info.type !== "Directory") {
          return yield* new Error({ operation: "resolve", path: absolute, cause: "Non-directory ancestor" })
        }
        return {
          canonical: path.resolve(canonical, path.relative(anchor, absolute)),
          directory: canonical,
          type: "Unknown" as const,
        }
      }
      const parent = path.dirname(anchor)
      if (parent === anchor) return yield* new Error({ operation: "resolve", path: absolute, cause: "No ancestor" })
      anchor = parent
    }
  })
  const files: FileBackend = {
    inspect: (path) => wrap("inspect", path, fs.stat(path)),
    resolve: (path) =>
      resolve(path).pipe(
        Effect.mapError((cause) => (cause instanceof Error ? cause : new Error({ operation: "resolve", path, cause }))),
      ),
    read: (path) => wrap("read", path, fs.readFile(path)),
    list: (path) => wrap("list", path, fs.readDirectoryEntries(path)),
    ensureDirectory: (path) => wrap("ensureDirectory", path, fs.ensureDir(path)),
    createExclusive: (path, content) =>
      wrap("createExclusive", path, mutate(path, fs.writeFile(path, content, { flag: "wx" }))),
    write: (path, content) => wrap("write", path, mutate(path, fs.writeFile(path, content))),
    writeIfUnchanged: (path, expected, content) =>
      mutate(
        path,
        Effect.gen(function* () {
          const current = yield* fs.readFile(path)
          if (!sameBytes(current, expected)) return yield* new StaleContentError({ path })
          yield* fs.writeFile(path, content)
        }),
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof StaleContentError ? cause : new Error({ operation: "writeIfUnchanged", path, cause }),
        ),
      ),
    remove: (path) => wrap("remove", path, mutate(path, fs.remove(path))),
  }
  const executable = ShellSelect.preferred() ?? "/bin/sh"
  return Service.of({
    platform: process.platform,
    directory,
    files,
    process: proc,
    shell: {
      executable,
      args: (command) => ShellSelect.args(executable, command),
      environmentOverrides: {
        TERM: "xterm-256color",
        OPENCODE_TERMINAL: "1",
      },
      detached: process.platform !== "win32",
    },
    ripgrep: ripgrep.filepath.pipe(Effect.mapError((cause) => new Error({ operation: "ripgrep", cause }))),
  })
})

const borrow = <A, E>(
  workspace: WorkspaceV2.Interface,
  id: WorkspaceV2.ID,
  use: (environment: Interface) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    workspace.borrow(id).pipe(
      Effect.mapError((cause) => new Error({ operation: "connect", cause })),
      Effect.flatMap(use),
    ),
  )

const contains = (root: string, target: string) => {
  const relative = path.posix.relative(root, target)
  return relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative)
}

const localLayer = (ref: Location.Ref) => Layer.effect(Service, local(ref.directory))

const hostedLayer = (ref: Location.Ref & { readonly workspaceID: WorkspaceV2.ID }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      const workspace = yield* WorkspaceV2.Service
      const id = ref.workspaceID
      const useFile = <A, E>(
        target: string,
        use: (files: FileBackend, resolved: ResolvedPath) => Effect.Effect<A, E>,
      ) =>
        borrow(workspace, id, (environment) =>
          Effect.gen(function* () {
            const absolute = path.posix.resolve(location.directory, target)
            const [root, resolved] = yield* Effect.all([
              environment.files.resolve(location.project.directory),
              environment.files.resolve(absolute),
            ])
            if (!contains(root.canonical, resolved.canonical)) {
              return yield* new Error({ operation: "containment", path: target })
            }
            return yield* use(environment.files, resolved)
          }),
        )
      const files: FileBackend = {
        inspect: (path) => useFile(path, (files, resolved) => files.inspect(resolved.canonical)),
        resolve: (path) => useFile(path, (_files, resolved) => Effect.succeed(resolved)),
        read: (path) => useFile(path, (files, resolved) => files.read(resolved.canonical)),
        list: (path) => useFile(path, (files, resolved) => files.list(resolved.canonical)),
        ensureDirectory: (path) => useFile(path, (files, resolved) => files.ensureDirectory(resolved.canonical)),
        createExclusive: (path, content) =>
          useFile(path, (files, resolved) => files.createExclusive(resolved.canonical, content)),
        write: (path, content) => useFile(path, (files, resolved) => files.write(resolved.canonical, content)),
        writeIfUnchanged: (path, expected, content) =>
          useFile(path, (files, resolved) => files.writeIfUnchanged(resolved.canonical, expected, content)),
        remove: (path) => useFile(path, (files, resolved) => files.remove(resolved.canonical)),
      }
      return Service.of({
        platform: "linux",
        directory: location.directory,
        files,
        process: make((command) =>
          workspace.borrow(id).pipe(
            Effect.flatMap((environment) => environment.process.spawn(command)),
            Effect.mapError((cause) =>
              cause instanceof PlatformError
                ? cause
                : systemError({
                    _tag: "Unknown",
                    module: "WorkspaceEnvironment",
                    method: "spawn",
                    cause,
                  }),
            ),
          ),
        ),
        shell: {
          executable: "/bin/sh",
          args: (command) => ["-c", command],
          environmentOverrides: {
            TERM: "xterm-256color",
            OPENCODE_TERMINAL: "1",
          },
          detached: false,
        },
        ripgrep: borrow(workspace, id, (environment) => environment.ripgrep),
      })
    }),
  )

export const boundNode = (ref: Location.Ref) => {
  if (ref.workspaceID) {
    return makeLocationNode({
      service: Service,
      layer: hostedLayer({ ...ref, workspaceID: ref.workspaceID }),
      deps: [Location.node, WorkspaceV2.node],
    })
  }
  return makeLocationNode({
    service: Service,
    layer: localLayer(ref),
    deps: [FSUtil.node, AppProcess.node, RipgrepBinary.node],
  })
}
