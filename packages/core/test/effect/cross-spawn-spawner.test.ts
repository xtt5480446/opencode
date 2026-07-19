import { describe, expect } from "bun:test"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import type * as PlatformError from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { testEffect } from "../lib/effect"

const live = LayerNode.compile(CrossSpawnSpawner.node)
const fx = testEffect(live)
const probeFx = testEffect(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))

function js(code: string, opts?: ChildProcess.CommandOptions) {
  return ChildProcess.make("node", ["-e", code], opts)
}

function decodeByteStream(stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) {
  return Stream.runCollect(stream).pipe(
    Effect.map((chunks) => {
      const total = chunks.reduce((acc, x) => acc + x.length, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const chunk of chunks) {
        out.set(chunk, off)
        off += chunk.length
      }
      return new TextDecoder("utf-8").decode(out).trim()
    }),
  )
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-core-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function gone(pid: number, timeout = 5_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

const waitExists = (file: string) =>
  Effect.callback<void>((resume) => {
    const check = () => {
      if (!existsSync(file)) return
      clearInterval(timer)
      resume(Effect.void)
    }
    const timer = setInterval(check, 5)
    check()
    return Effect.sync(() => clearInterval(timer))
  }).pipe(Effect.timeout("5 seconds"))

describe("cross-spawn spawner", () => {
  describe("basic spawning", () => {
    fx.effect(
      "captures stdout",
      Effect.gen(function* () {
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(ChildProcess.make(process.execPath, ["-e", 'process.stdout.write("ok")'])),
        )
        expect(out).toBe("ok")
      }),
    )

    fx.effect(
      "captures multiple lines",
      Effect.gen(function* () {
        const handle = yield* js('console.log("line1"); console.log("line2"); console.log("line3")')
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("line1\nline2\nline3")
      }),
    )

    fx.effect(
      "returns exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(0)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )

    fx.effect(
      "returns non-zero exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(42)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(42))
      }),
    )
  })

  describe("cwd option", () => {
    fx.effect(
      "uses cwd when spawning commands",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: tmp.path }),
          ),
        )
        expect(yield* Effect.promise(() => fs.realpath(out))).toBe(yield* Effect.promise(() => fs.realpath(tmp.path)))
      }),
    )

    fx.effect(
      "fails for invalid cwd",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
            svc.spawn(ChildProcess.make("echo", ["test"], { cwd: "/nonexistent/directory/path" })),
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  describe("env option", () => {
    fx.effect(
      "passes environment variables with extendEnv",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write(process.env.TEST_VAR ?? "")', {
          env: { TEST_VAR: "test_value" },
          extendEnv: true,
        })
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("test_value")
      }),
    )

    fx.effect(
      "passes multiple environment variables",
      Effect.gen(function* () {
        const handle = yield* js(
          "process.stdout.write(`${process.env.VAR1}-${process.env.VAR2}-${process.env.VAR3}`)",
          {
            env: { VAR1: "one", VAR2: "two", VAR3: "three" },
            extendEnv: true,
          },
        )
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("one-two-three")
      }),
    )
  })

  describe("stderr", () => {
    fx.effect(
      "captures stderr output",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error message")')
        const err = yield* decodeByteStream(handle.stderr)
        expect(err).toBe("error message")
      }),
    )

    fx.effect(
      "captures both stdout and stderr",
      Effect.gen(function* () {
        const handle = yield* js(
          [
            "let pending = 2",
            "const done = () => {",
            "  pending -= 1",
            "  if (pending === 0) setTimeout(() => process.exit(0), 0)",
            "}",
            'process.stdout.write("stdout\\n", done)',
            'process.stderr.write("stderr\\n", done)',
          ].join("\n"),
        )
        const [stdout, stderr] = yield* Effect.all([decodeByteStream(handle.stdout), decodeByteStream(handle.stderr)], {
          concurrency: 2,
        })
        expect(stdout).toBe("stdout")
        expect(stderr).toBe("stderr")
      }),
    )
  })

  describe("combined output (all)", () => {
    fx.effect(
      "captures stdout via .all when no stderr",
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make("echo", ["hello from stdout"])
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stdout")
      }),
    )

    fx.effect(
      "captures stderr via .all when no stdout",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("hello from stderr")')
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stderr")
      }),
    )
  })

  describe("stdin", () => {
    fx.effect(
      "allows providing standard input to a command",
      Effect.gen(function* () {
        const input = "a b c"
        const stdin = Stream.make(Buffer.from(input, "utf-8"))
        const handle = yield* js(
          'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
          { stdin },
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("a b c")
      }),
    )
  })

  describe("process control", () => {
    fx.effect(
      "kills a running process",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js("setTimeout(() => {}, 10_000)")
            yield* handle.kill()
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "kills a child when scope exits",
      Effect.gen(function* () {
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* js("setInterval(() => {}, 10_000)")
            return Number(handle.pid)
          }),
        )
        const done = yield* Effect.promise(() => gone(pid))
        expect(done).toBe(true)
      }),
    )

    fx.effect(
      "forceKillAfter escalates for stubborn processes",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const started = Date.now()
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js('process.on("SIGTERM", () => {}); setInterval(() => {}, 10_000)')
            yield* handle.kill({ forceKillAfter: 100 })
            return yield* handle.exitCode
          }),
        )

        expect(Date.now() - started).toBeLessThan(1_000)
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "forceKillAfter escalates a live group after its parent exits on SIGTERM",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        yield* TestClock.setTime(1_000)
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const term = path.join(tmp.path, ".grandchild-term")
        const grandchild = [
          'const { writeFileSync } = require("node:fs")',
          `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(term)}, "received"))`,
          'process.stdout.write(String(process.pid) + "\\n")',
          "setInterval(() => {}, 10_000)",
        ].join("\n")
        const parent = [
          'const { spawn } = require("node:child_process")',
          `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", "pipe", "ignore"] })`,
          'child.stdout.once("data", (chunk) => process.stdout.write(chunk))',
          'process.on("SIGTERM", () => process.exit(0))',
          "setInterval(() => {}, 10_000)",
        ].join("\n")
        const handle = yield* js(parent)
        const first = yield* Stream.runHead(handle.stdout)
        if (Option.isNone(first)) return yield* Effect.die("grandchild did not report its PID")
        const grandchildPID = Number(new TextDecoder().decode(first.value).trim())
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(-Number(handle.pid), "SIGKILL")
            } catch {
              // The group may already have completed through the expected escalation.
            }
          }),
        )

        const received = yield* waitExists(term).pipe(Effect.forkChild({ startImmediately: true }))
        const killed = yield* Deferred.make<void>()
        const killing = yield* handle
          .kill({ forceKillAfter: 3_000 })
          .pipe(Effect.ensuring(Deferred.succeed(killed, undefined)), Effect.forkChild({ startImmediately: true }))
        yield* Fiber.join(received)
        expect(yield* Effect.promise(() => gone(Number(handle.pid)))).toBe(true)
        expect(yield* Deferred.isDone(killed)).toBe(false)
        yield* TestClock.adjust(2_999)
        expect(alive(grandchildPID)).toBe(true)
        yield* TestClock.adjust(1)
        yield* Fiber.join(killing)
        expect(alive(grandchildPID)).toBe(false)
        expect(groupAlive(Number(handle.pid))).toBe(false)
      }),
    )

    fx.effect(
      "forceKillAfter escalates a stubborn direct child when detached is false",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        yield* TestClock.setTime(5_000)
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const term = path.join(tmp.path, ".direct-term")
        const handle = yield* js(
          [
            'const { writeFileSync } = require("node:fs")',
            `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(term)}, "received"))`,
            'process.stdout.write("ready\\n")',
            "setInterval(() => {}, 10_000)",
          ].join("\n"),
          { detached: false },
        )
        yield* Stream.runHead(handle.stdout)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(Number(handle.pid), "SIGKILL")
            } catch {
              // The direct child may already have completed through escalation.
            }
          }),
        )
        const received = yield* waitExists(term).pipe(Effect.forkChild({ startImmediately: true }))
        const killed = yield* Deferred.make<void>()
        const killing = yield* handle
          .kill({ forceKillAfter: 100 })
          .pipe(Effect.ensuring(Deferred.succeed(killed, undefined)), Effect.forkChild({ startImmediately: true }))
        yield* Fiber.join(received)

        expect(yield* Deferred.isDone(killed)).toBe(false)
        yield* TestClock.adjust(99)
        expect(alive(Number(handle.pid))).toBe(true)
        yield* TestClock.adjust(1)
        yield* Fiber.join(killing)
        expect(alive(Number(handle.pid))).toBe(false)
      }),
    )

    fx.effect(
      "scope cleanup escalates a group after its parent exits on SIGTERM",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        yield* TestClock.setTime(10_000)
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const term = path.join(tmp.path, ".scope-grandchild-term")
        const grandchild = [
          'const { writeFileSync } = require("node:fs")',
          `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(term)}, "received"))`,
          'process.stdout.write(String(process.pid) + "\\n")',
          "setInterval(() => {}, 10_000)",
        ].join("\n")
        const parent = [
          'const { spawn } = require("node:child_process")',
          `const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", "pipe", "ignore"] })`,
          'child.stdout.once("data", (chunk) => process.stdout.write(chunk))',
          'process.on("SIGTERM", () => process.exit(0))',
          "setInterval(() => {}, 10_000)",
        ].join("\n")
        const pids = yield* Deferred.make<{ parent: number; grandchild: number }>()
        const release = yield* Deferred.make<void>()
        const running = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* js(parent, { forceKillAfter: 3_000 })
            const first = yield* Stream.runHead(handle.stdout)
            if (Option.isNone(first)) return yield* Effect.die("grandchild did not report its PID")
            yield* Deferred.succeed(pids, {
              parent: Number(handle.pid),
              grandchild: Number(new TextDecoder().decode(first.value).trim()),
            })
            yield* Deferred.await(release)
          }),
        ).pipe(Effect.forkChild({ startImmediately: true }))
        const processes = yield* Deferred.await(pids)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(-processes.parent, "SIGKILL")
            } catch {
              // The group may already have completed through scope cleanup.
            }
          }),
        )
        const received = yield* waitExists(term).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(received)
        expect(yield* Effect.promise(() => gone(processes.parent))).toBe(true)

        yield* TestClock.adjust(2_999)
        expect(alive(processes.grandchild)).toBe(true)
        yield* TestClock.adjust(1)
        yield* Fiber.join(running)
        expect(alive(processes.grandchild)).toBe(false)
        expect(groupAlive(processes.parent)).toBe(false)
      }),
    )

    probeFx.live(
      "bounds final group observation after SIGKILL with a typed platform error",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const spawner = yield* CrossSpawnSpawner.makeWithOptions({
          groupAlive: () => true,
          forceKillObservationMs: 100,
        })
        const handle = yield* spawner.spawn(
          js('process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 10_000)'),
        )
        yield* Stream.runHead(handle.stdout)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(-Number(handle.pid), "SIGKILL")
            } catch {
              // The real group is expected to be gone even though the injected probe stays alive.
            }
          }),
        )

        const started = Date.now()
        const exit = yield* handle.kill({ forceKillAfter: 100 }).pipe(Effect.exit)
        expect(Date.now() - started).toBeLessThan(1_000)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "PlatformError",
            reason: {
              _tag: "TimedOut",
              method: "kill",
            },
          })
      }),
    )

    for (const detached of [true, false]) {
      probeFx.live(
        `treats ESRCH after the liveness probe as an already-gone ${detached ? "group" : "direct child"}`,
        Effect.gen(function* () {
          if (process.platform === "win32") return

          const delivered: Array<{ pid: number; detached: boolean; signal: NodeJS.Signals }> = []
          const spawner = yield* CrossSpawnSpawner.makeWithOptions({
            groupAlive: () => true,
            signal: (pid: number, signal: NodeJS.Signals, grouped: boolean) => {
              delivered.push({ pid, signal, detached: grouped })
              const error = new Error("process exited before signal delivery") as NodeJS.ErrnoException
              error.code = "ESRCH"
              throw error
            },
          } as CrossSpawnSpawner.MakeOptions & {
            signal: (pid: number, signal: NodeJS.Signals, detached: boolean) => boolean
          })
          const handle = yield* spawner.spawn(
            js('process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 10_000)', {
              detached,
            }),
          )
          yield* Stream.runHead(handle.stdout)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              try {
                process.kill(detached ? -Number(handle.pid) : Number(handle.pid), "SIGKILL")
              } catch {
                // The fixture may have completed if signal injection was not active.
              }
            }),
          )

          expect(Exit.isSuccess(yield* handle.kill({ forceKillAfter: 100 }).pipe(Effect.exit))).toBe(true)
          expect(delivered).toEqual([{ pid: Number(handle.pid), detached, signal: "SIGTERM" }])
        }),
      )
    }

    probeFx.live(
      "keeps non-ESRCH signal delivery failures typed",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const spawner = yield* CrossSpawnSpawner.makeWithOptions({
          groupAlive: () => true,
          signal: () => {
            const error = new Error("signal permission denied") as NodeJS.ErrnoException
            error.code = "EPERM"
            throw error
          },
        } as CrossSpawnSpawner.MakeOptions & {
          signal: (pid: number, signal: NodeJS.Signals, detached: boolean) => boolean
        })
        const handle = yield* spawner.spawn(js('process.stdout.write("ready\\n"); setInterval(() => {}, 10_000)'))
        yield* Stream.runHead(handle.stdout)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(-Number(handle.pid), "SIGKILL")
            } catch {
              // The group may already be gone.
            }
          }),
        )

        const exit = yield* handle.kill().pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "PlatformError",
            reason: { _tag: "PermissionDenied", method: "kill" },
          })
      }),
    )

    fx.effect(
      "isRunning reflects process state",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("done")')
        yield* handle.exitCode
        const running = yield* handle.isRunning
        expect(running).toBe(false)
      }),
    )
  })

  describe("error handling", () => {
    fx.effect(
      "fails for invalid command",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* ChildProcess.make("nonexistent-command-12345")
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )
  })

  describe("pipeline", () => {
    fx.effect(
      "pipes stdout of one command to stdin of another",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO WORLD")
      }),
    )

    fx.effect(
      "three-stage pipeline",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.replaceAll(" ", "-")))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO-WORLD")
      }),
    )

    fx.effect(
      "pipes stderr with { from: 'stderr' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "stderr" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("error")
      }),
    )

    fx.effect(
      "pipes combined output with { from: 'all' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("stdout\\n"); process.stderr.write("stderr\\n")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "all" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toContain("stdout")
        expect(out).toContain("stderr")
      }),
    )
  })

  describe("Windows-specific", () => {
    fx.effect(
      "uses shell routing on Windows",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make("set", ["OPENCODE_TEST_SHELL"], {
              shell: true,
              extendEnv: true,
              env: { OPENCODE_TEST_SHELL: "ok" },
            }),
          ),
        )
        expect(out).toContain("OPENCODE_TEST_SHELL=ok")
      }),
    )

    fx.effect(
      "runs cmd scripts with spaces on Windows without shell",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = path.join(tmp.path, "with space")
        const file = path.join(dir, "echo cmd.cmd")

        yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n"))

        const code = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.exitCode(
            ChildProcess.make(file, ["--stdio"], {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          ),
        )
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )
  })
})
