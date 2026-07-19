import { describe, expect } from "bun:test"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { existsSync } from "node:fs"
import path from "path"
import { AdaptiveProcessSupervisor } from "@/adaptive/process/supervisor"
import { AdaptiveProcessCommand } from "@/adaptive/process/command"
import { AgentProcessProtocol } from "@/adaptive/process/protocol"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([AdaptiveStore.node, Database.node, CrossSpawnSpawner.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

const policy = () =>
  AdaptiveModelPolicy.create({
    providerID: Provider.ID.make("openai-compatible"),
    modelID: Model.ID.make("kimi-k2"),
    variant: Model.VariantID.make("default"),
    effectiveContextLimit: 262_144,
    outputReserve: 16_384,
    safetyReserve: 8_192,
  })

const seed = Effect.fnUntraced(function* (directory: string) {
  const store = yield* AdaptiveStore.Service
  const task = yield* store.createTask({
    id: AdaptiveTask.ID.create(),
    directory,
    mode: "normal",
    status: "planning",
    requirement: "Supervise an isolated adaptive agent",
    modelPolicy: policy(),
    roadmapRevision: 0,
    baseSnapshotHash: "git:0123456789abcdef",
  })
  const agent = yield* store.createAgent({
    id: AdaptiveTask.AgentID.create(),
    taskID: task.id,
    role: "implementation",
  })
  return { store, task, agent }
})

const sourceEntry = path.join(import.meta.dir, "../../src/index.ts")

function sourceCommand(input: AdaptiveProcessCommand.Input) {
  return ChildProcess.make(
    process.execPath,
    ["run", "--conditions=browser", sourceEntry, "__adaptive-agent", ...AdaptiveProcessCommand.agentArgs(input)],
    AdaptiveProcessCommand.options(input),
  )
}

function sourceAgent(argv: readonly string[]) {
  return ChildProcess.make(
    process.execPath,
    ["run", "--conditions=browser", sourceEntry, "__adaptive-agent", ...argv],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: false,
      forceKillAfter: 1_000,
    },
  )
}

function fixtureCommand(file: string) {
  return (input: AdaptiveProcessCommand.Input) =>
    Effect.succeed(
      ChildProcess.make(
        process.execPath,
        ["run", file, ...AdaptiveProcessCommand.agentArgs(input)],
        AdaptiveProcessCommand.options(input),
      ),
    )
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function processGroupExists(pid: number) {
  if (process.platform === "win32") return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const waitGone = (pid: number) =>
  Effect.callback<void>((resume) => {
    const check = () => {
      if (!processExists(pid)) {
        clearInterval(timer)
        resume(Effect.void)
      }
    }
    const timer = setInterval(check, 10)
    check()
    return Effect.sync(() => clearInterval(timer))
  }).pipe(Effect.timeout("5 seconds"))

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

const waitFor = <A>(stream: Stream.Stream<A>, predicate: (value: A) => boolean) =>
  Stream.runHead(Stream.filter(stream, predicate)).pipe(
    Effect.flatMap((value) => (Option.isSome(value) ? Effect.succeed(value.value) : Effect.die("event stream ended"))),
    Effect.timeout("5 seconds"),
  )

const fixture = (input: { generation?: number; heartbeatGate?: boolean; stubborn?: boolean }) => `
import { watch, writeFileSync } from "node:fs"

const argv = process.argv.slice(2)
const value = (name) => argv[argv.indexOf(name) + 1]
const identity = {
  taskID: value("--task-id"),
  agentID: value("--agent-id"),
  generation: ${input.generation === undefined ? 'Number(value("--generation"))' : input.generation},
  role: value("--role"),
}
let next = 0
const send = (frame) => process.stdout.write(JSON.stringify({ v: 1, id: String(++next), ...frame }) + "\\n")
const lines = async function* () {
  let buffer = ""
  for await (const chunk of process.stdin) {
    buffer += chunk.toString("utf8")
    const parts = buffer.split("\\n")
    buffer = parts.pop()
    for (const line of parts) if (line) yield JSON.parse(line)
  }
}

writeFileSync(".spawned", String(process.pid))
send({ type: "hello", ...identity })
for await (const frame of lines()) {
  if (frame.type !== "accepted") continue
  writeFileSync(".accepted", "received")
  send({ type: "ready" })
  ${
    input.heartbeatGate
      ? `const watcher = watch(process.cwd(), (_event, name) => {
    if (name !== ".heartbeat") return
    watcher.close()
    send({ type: "heartbeat" })
  })`
      : `${
          input.stubborn
            ? `const grandchild = Bun.spawn(["node", "-e", 'const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => writeFileSync(".term", "received")); process.stdout.write(String(process.pid) + "\\\\n"); setInterval(() => {}, 10000)'], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })`
            : `const grandchild = Bun.spawn(["node", "-e", 'process.stdout.write(String(process.pid) + "\\\\n"); setInterval(() => {}, 10000)'], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })`
        }
  const reader = grandchild.stdout.getReader()
  const ready = await reader.read()
  reader.releaseLock()
  const grandchildPID = Number(new TextDecoder().decode(ready.value).trim())
  send({ type: "rpc.request", method: "process.complete", payload: { grandchildPID } })`
  }
}
process.exitCode = 64
`

const handshakeFixture = (input: { phase: "hello" | "ready"; end: "timeout" | "eof" }) => `
import { writeFileSync } from "node:fs"

const argv = process.argv.slice(2)
const value = (name) => argv[argv.indexOf(name) + 1]
let next = 0
const send = (frame) => process.stdout.write(JSON.stringify({ v: 1, id: String(++next), ...frame }) + "\\n")
const lines = async function* () {
  let buffer = ""
  for await (const chunk of process.stdin) {
    buffer += chunk.toString("utf8")
    const parts = buffer.split("\\n")
    buffer = parts.pop()
    for (const line of parts) if (line) yield JSON.parse(line)
  }
}

writeFileSync(".spawned", String(process.pid))
${
  input.phase === "hello"
    ? input.end === "timeout"
      ? "setInterval(() => {}, 10_000)"
      : "process.exit(64)"
    : `send({
  type: "hello",
  taskID: value("--task-id"),
  agentID: value("--agent-id"),
  generation: Number(value("--generation")),
  role: value("--role"),
})
for await (const frame of lines()) {
  if (frame.type !== "accepted") continue
  writeFileSync(".accepted", "received")
  ${input.end === "timeout" ? "setInterval(() => {}, 10_000); break" : "process.exit(64)"}
}`
}
`

const delayedReadyFixture = `
import { watch, writeFileSync } from "node:fs"

const argv = process.argv.slice(2)
const value = (name) => argv[argv.indexOf(name) + 1]
let next = 0
const send = (frame) => process.stdout.write(JSON.stringify({ v: 1, id: String(++next), ...frame }) + "\\n")
const lines = async function* () {
  let buffer = ""
  for await (const chunk of process.stdin) {
    buffer += chunk.toString("utf8")
    const parts = buffer.split("\\n")
    buffer = parts.pop()
    for (const line of parts) if (line) yield JSON.parse(line)
  }
}

send({
  type: "hello",
  taskID: value("--task-id"),
  agentID: value("--agent-id"),
  generation: Number(value("--generation")),
  role: value("--role"),
})
for await (const frame of lines()) {
  if (frame.type !== "accepted") continue
  const ready = watch(process.cwd(), (_event, name) => {
    if (name !== ".ready") return
    ready.close()
    send({ type: "ready" })
  })
  writeFileSync(".accepted", "received")
}
`

const terminalFixture = (mode: "complete" | "exit" | "malformed" | "transport") => `
import { watch, writeFileSync } from "node:fs"

const argv = process.argv.slice(2)
const value = (name) => argv[argv.indexOf(name) + 1]
let next = 0
let completionID
const send = (frame) => {
  const id = String(++next)
  process.stdout.write(JSON.stringify({ v: 1, id, ...frame }) + "\\n")
  return id
}
const lines = async function* () {
  let buffer = ""
  for await (const chunk of process.stdin) {
    buffer += chunk.toString("utf8")
    const parts = buffer.split("\\n")
    buffer = parts.pop()
    for (const line of parts) if (line) yield JSON.parse(line)
  }
}

writeFileSync(".spawned", String(process.pid))
send({
  type: "hello",
  taskID: value("--task-id"),
  agentID: value("--agent-id"),
  generation: Number(value("--generation")),
  role: value("--role"),
})
for await (const frame of lines()) {
  if (frame.type === "accepted") {
    if (${JSON.stringify(mode)} === "exit") {
      process.stdout.write(
        JSON.stringify({ v: 1, id: String(++next), type: "ready" }) + "\\n",
        () => process.exit(23),
      )
      continue
    }
    send({ type: "ready" })
    if (${JSON.stringify(mode)} === "malformed") {
      const watcher = watch(process.cwd(), (_event, name) => {
        if (name !== ".malformed") return
        watcher.close()
        process.stdout.write("not-json\\n")
      })
      writeFileSync(".armed", "received")
      continue
    }
    if (${JSON.stringify(mode)} === "transport") {
      const watcher = watch(process.cwd(), (_event, name) => {
        if (name !== ".transport") return
        watcher.close()
        process.stdout.end(() => writeFileSync(".stdout-ended", "closed"))
      })
      writeFileSync(".armed", "received")
      continue
    }
    completionID = send({ type: "rpc.request", method: "process.complete", payload: null })
    continue
  }
  if (frame.type !== "rpc.response" || frame.requestID !== completionID) continue
  const watcher = watch(process.cwd(), (_event, name) => {
    if (name !== ".exit") return
    watcher.close()
    process.exit(0)
  })
  process.stdout.end(() => writeFileSync(".stdout-ended", "closed"))
}
`

const stderrFixture = (chunks: readonly Uint8Array[]) => `
const argv = process.argv.slice(2)
const value = (name) => argv[argv.indexOf(name) + 1]
let next = 0
const send = (frame) => process.stdout.write(JSON.stringify({ v: 1, id: String(++next), ...frame }) + "\\n")
const lines = async function* () {
  let buffer = ""
  for await (const chunk of process.stdin) {
    buffer += chunk.toString("utf8")
    const parts = buffer.split("\\n")
    buffer = parts.pop()
    for (const line of parts) if (line) yield JSON.parse(line)
  }
}

send({
  type: "hello",
  taskID: value("--task-id"),
  agentID: value("--agent-id"),
  generation: Number(value("--generation")),
  role: value("--role"),
})
for await (const frame of lines()) {
  if (frame.type !== "accepted") continue
  send({ type: "ready" })
  for (const chunk of ${JSON.stringify(chunks.map((chunk) => Buffer.from(chunk).toString("base64")))}) {
    await new Promise((resolve, reject) =>
      process.stderr.write(Buffer.from(chunk, "base64"), (error) => error ? reject(error) : resolve()),
    )
  }
  process.exit(0)
}
`

const controlFixture = (
  mode: "duplicate" | "limit" | "immediate" | "cancel" | "heartbeat" | "replay" | "total" | "outbound",
) => `
import { watch, writeFileSync } from "node:fs"

const argv = process.argv.slice(2)
const value = (name) => argv[argv.indexOf(name) + 1]
let next = 0
let replayed = false
let total = 0
const send = (frame) => process.stdout.write(JSON.stringify({ v: 1, id: String(++next), ...frame }) + "\\n")
const request = (id, name) =>
  process.stdout.write(JSON.stringify({ v: 1, id, type: "rpc.request", method: "process.complete", payload: { name } }) + "\\n")
const lines = async function* () {
  let buffer = ""
  for await (const chunk of process.stdin) {
    buffer += chunk.toString("utf8")
    const parts = buffer.split("\\n")
    buffer = parts.pop()
    for (const line of parts) if (line) yield JSON.parse(line)
  }
}

writeFileSync(".spawned", String(process.pid))
send({
  type: "hello",
  taskID: value("--task-id"),
  agentID: value("--agent-id"),
  generation: Number(value("--generation")),
  role: value("--role"),
})
for await (const frame of lines()) {
  if (${JSON.stringify(mode)} === "replay" && frame.type === "rpc.response" && !replayed) {
    replayed = true
    request("replay", "second")
    request("barrier", "barrier")
    writeFileSync(".replayed", "sent")
    continue
  }
  if (${JSON.stringify(mode)} === "total" && frame.type === "rpc.response") {
    total += 1
    if (total <= ${AgentProcessProtocol.MAX_RPC_REQUEST_IDS_PER_GENERATION}) {
      request("total-" + total, String(total))
      if (total === ${AgentProcessProtocol.MAX_RPC_REQUEST_IDS_PER_GENERATION})
        writeFileSync(".cap-sent", "sent")
    } else {
      writeFileSync(".done", "received")
    }
    continue
  }
  if (frame.type !== "accepted") continue
  send({ type: "ready" })
  const watcher = watch(process.cwd(), (_event, name) => {
    if (name === ".send") {
      if (${JSON.stringify(mode)} === "duplicate") {
        request("duplicate", "first")
        request("duplicate", "second")
      }
      if (${JSON.stringify(mode)} === "limit") {
        for (let index = 0; index < 33; index += 1) request("pending-" + index, String(index))
      }
      if (${JSON.stringify(mode)} === "immediate") {
        for (let index = 0; index < 32; index += 1) request("immediate-" + index, String(index))
      }
      if (${JSON.stringify(mode)} === "cancel") {
        request("cancel-a", "a")
        request("cancel-b", "b")
      }
      if (${JSON.stringify(mode)} === "heartbeat") {
        for (let index = 0; index < 100; index += 1) send({ type: "heartbeat" })
        request("heartbeat-barrier-1", "wave1")
      }
      if (${JSON.stringify(mode)} === "replay") request("replay", "first")
      if (${JSON.stringify(mode)} === "total") request("total-0", "0")
      if (${JSON.stringify(mode)} === "outbound") {
        for (let index = 0; index < 20; index += 1) request("outbound-" + index, String(index))
      }
      writeFileSync(".sent", "first")
    }
    if (name === ".cancel" && ${JSON.stringify(mode)} === "cancel")
      send({ type: "rpc.cancel", requestID: "cancel-a" })
    if (name === ".wave2" && ${JSON.stringify(mode)} === "immediate") request("immediate-32", "32")
    if (name === ".send2" && ${JSON.stringify(mode)} === "heartbeat") {
      send({ type: "heartbeat" })
      request("heartbeat-barrier-2", "wave2")
    }
  })
  writeFileSync(".armed", "received")
  if (${JSON.stringify(mode)} === "outbound") break
}
`

describe("AdaptiveProcessCommand", () => {
  it.live("returns protocol exit 64 for invalid hidden command arguments", () =>
    Effect.gen(function* () {
      const taskID = AdaptiveTask.ID.create()
      const agentID = AdaptiveTask.AgentID.create()
      const valid = ["--task-id", taskID, "--agent-id", agentID, "--generation", "0", "--role", "implementation"]
      for (const argv of [[], valid.with(5, "invalid"), valid.with(7, "invalid-role")]) {
        const handle = yield* sourceAgent(argv)
        expect(Number(yield* handle.exitCode)).toBe(64)
      }
    }),
  )

  it.effect("builds a default-deny child environment without secret names or values", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = {
        OPENAI_API_KEY: "seed-openai-key",
        OPENCODE_AUTH_CONTENT: "seed-auth-content",
        CONTROLLER_RPC_TOKEN: "seed-controller-token",
        HTTPS_PROXY: "https://user:seed-proxy-password@example.com",
        SAFE_BUT_UNKNOWN: "seed-unknown",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      }
      const env = AdaptiveProcessCommand.environment({ ...process.env, ...seeded })

      expect(Object.keys(env)).toEqual(Object.keys(env).toSorted())
      expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
      for (const [name, value] of Object.entries(seeded).filter(([name]) => name !== "OPENCODE_DISABLE_AUTOUPDATE")) {
        expect(Object.keys(env)).not.toContain(name)
        expect(Object.values(env)).not.toContain(value)
      }

      const command = yield* AdaptiveProcessCommand.make({
        directory,
        taskID: AdaptiveTask.ID.create(),
        agentID: AdaptiveTask.AgentID.create(),
        generation: 1,
        role: "implementation",
      })
      expect(command._tag).toBe("StandardCommand")
      if (command._tag !== "StandardCommand") return
      expect(command.options.extendEnv).toBe(false)
      expect(command.options.stdin).toBe("pipe")
      expect(command.options.stdout).toBe("pipe")
      expect(command.options.stderr).toBe("pipe")
      expect(Duration.toMillis(command.options.forceKillAfter!)).toBe(3_000)
    }),
  )

  it.live("keeps seeded secret names and values out of a real hidden child", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return
      const directory = yield* tmpdirScoped()
      const seeded = {
        OPENAI_API_KEY: "proc-seed-openai-key",
        OPENCODE_AUTH_CONTENT: "proc-seed-auth-content",
        CONTROLLER_RPC_SECRET: "proc-seed-controller-secret",
      }
      const previous = Object.fromEntries(Object.keys(seeded).map((name) => [name, process.env[name]]))
      Object.assign(process.env, seeded)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() =>
          Object.entries(previous).forEach(([name, value]) => {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
          }),
        ),
      )
      const seededState = yield* seed(directory)
      const supervisor = yield* AdaptiveProcessSupervisor.make({
        command: (input) => Effect.succeed(sourceCommand(input)),
      })
      const handle = yield* supervisor.start({ agentID: seededState.agent.id, router: () => Effect.succeed(null) })

      const bytes = yield* Effect.promise(() => Bun.file(`/proc/${handle.pid}/environ`).arrayBuffer())
      const pairs = new TextDecoder().decode(bytes).split("\0").filter(Boolean).toSorted()
      const names = pairs.map((pair) => pair.slice(0, pair.indexOf("=")))
      const values = pairs.map((pair) => pair.slice(pair.indexOf("=") + 1))
      for (const [name, value] of Object.entries(seeded)) {
        expect(names).not.toContain(name)
        expect(values).not.toContain(value)
      }

      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })
      yield* waitGone(handle.pid)
    }),
  )
})

describe("AdaptiveProcessSupervisor", () => {
  it.effect("keeps sanitized stderr within the encoded preview byte limit", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "stderr-expansion.ts")
      const input = new TextEncoder().encode(
        "token=x\n".repeat(Math.ceil(AdaptiveProcessSupervisor.STDERR_PREVIEW_BYTES / 8)),
      )
      yield* Effect.promise(() => Bun.write(file, stderrFixture([input])))
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })

      yield* handle.exited
      const preview = yield* handle.stderrPreview
      expect(new TextEncoder().encode(preview).byteLength).toBeLessThanOrEqual(
        AdaptiveProcessSupervisor.STDERR_PREVIEW_BYTES,
      )
      expect(preview).not.toContain("token=x")
    }),
  )

  it.effect("redacts stderr secrets across multibyte and retained-byte boundaries", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "stderr-boundaries.ts")
      const encoder = new TextEncoder()
      const split = encoder.encode("prefix🙂 token=split-secret suffix\n")
      const emoji = split.findIndex((byte) => byte === 0xf0)
      const prefix = "x".repeat(AdaptiveProcessSupervisor.STDERR_PREVIEW_BYTES - split.byteLength - 15)
      yield* Effect.promise(() =>
        Bun.write(
          file,
          stderrFixture([
            split.subarray(0, emoji + 2),
            split.subarray(emoji + 2),
            encoder.encode(prefix + "token=boundary-"),
            encoder.encode("secret"),
          ]),
        ),
      )
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })

      yield* handle.exited
      const preview = yield* handle.stderrPreview
      expect(new TextEncoder().encode(preview).byteLength).toBeLessThanOrEqual(
        AdaptiveProcessSupervisor.STDERR_PREVIEW_BYTES,
      )
      expect(preview).toContain("prefix🙂 token=[REDACTED] suffix")
      expect(preview).not.toContain("split-secret")
      expect(preview).not.toContain("boundary-")
      expect(preview).not.toContain("�")
    }),
  )

  it.effect("finalizes and freezes delayed stderr before terminal cleanup resolves", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(5_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "stderr-delayed.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const encoder = new TextEncoder()
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const delayed = ChildProcessSpawner.make((command) =>
        real.spawn(command).pipe(
          Effect.map((handle) =>
            ChildProcessSpawner.makeHandle({
              pid: handle.pid,
              stdin: handle.stdin,
              stdout: handle.stdout,
              stderr: Stream.concat(
                Stream.fromEffect(
                  Deferred.succeed(started, undefined).pipe(Effect.as(encoder.encode("prefix🙂 token=raw-secret"))),
                ),
                Stream.fromEffect(Deferred.await(release).pipe(Effect.as(encoder.encode(" token=late-secret")))),
              ),
              all: handle.all,
              getInputFd: handle.getInputFd,
              getOutputFd: handle.getOutputFd,
              isRunning: handle.isRunning,
              exitCode: handle.exitCode,
              kill: handle.kill,
              unref: handle.unref,
            }),
          ),
        ),
      )
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, delayed),
      )
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })
      yield* Deferred.await(started)
      const stopping = yield* supervisor
        .stop({ agentID: handle.agentID, generation: handle.generation })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* waitGone(handle.pid)
      yield* Effect.yieldNow
      yield* TestClock.adjust(1_000)
      yield* Fiber.join(stopping)

      const first = yield* handle.stderrPreview
      expect(first).toBe("prefix🙂 token=[REDACTED]")
      expect(first).not.toContain("raw-secret")
      expect(first).not.toContain("�")
      expect(new TextEncoder().encode(first).byteLength).toBeLessThanOrEqual(
        AdaptiveProcessSupervisor.STDERR_PREVIEW_BYTES,
      )
      yield* Deferred.succeed(release, undefined)
      yield* Effect.yieldNow
      expect(yield* handle.stderrPreview).toBe(first)
      expect(first).not.toContain("late-secret")
    }),
  )

  for (const scenario of [
    { name: "kills a child when hello times out", phase: "hello", end: "timeout", claimed: false },
    { name: "observes a gone child when hello ends at EOF", phase: "hello", end: "eof", claimed: false },
    {
      name: "settles and kills a claimed generation when ready times out",
      phase: "ready",
      end: "timeout",
      claimed: true,
    },
    { name: "settles a claimed generation when ready ends at EOF", phase: "ready", end: "eof", claimed: true },
  ] as const) {
    it.effect(scenario.name, () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(100)
        const directory = yield* tmpdirScoped()
        const seeded = yield* seed(directory)
        const file = path.join(directory, `${scenario.phase}-${scenario.end}.ts`)
        yield* Effect.promise(() => Bun.write(file, handshakeFixture(scenario)))
        const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
        const starting = yield* supervisor
          .start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })
          .pipe(Effect.forkChild({ startImmediately: true }))
        const marker = path.join(directory, scenario.claimed ? ".accepted" : ".spawned")
        yield* waitExists(marker)
        const pid = Number(yield* Effect.promise(() => Bun.file(path.join(directory, ".spawned")).text()))
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL")
            } catch {
              // The process may already have completed through the expected startup cleanup.
            }
          }),
        )
        if (scenario.end === "timeout") yield* TestClock.adjust(10_000)

        const error = yield* Fiber.join(starting).pipe(Effect.flip)
        expect(error._tag).toBe("AdaptiveProcessSupervisor.StartError")
        expect(error.exitCode).toBe(64)
        expect(processExists(pid)).toBe(false)
        const record = yield* seeded.store.getAgent(seeded.agent.id)
        expect(record.generation).toBe(scenario.claimed ? 1 : 0)
        expect(record.state).toBe(scenario.claimed ? "failed" : "idle")
        expect(record.owner).toBeUndefined()
        expect(record.pid).toBeUndefined()
        expect(record.leaseExpiresAt).toBeUndefined()
      }),
    )
  }

  it.effect("renews the full durable lease after delayed readiness before activation", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "delayed-ready.ts")
      yield* Effect.promise(() => Bun.write(file, delayedReadyFixture))
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const starting = yield* supervisor
        .start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* waitExists(path.join(directory, ".accepted"))
      yield* TestClock.adjust(9_000)
      yield* Effect.promise(() => Bun.write(path.join(directory, ".ready"), "go"))

      const handle = yield* Fiber.join(starting)
      const renewed = yield* seeded.store.getAgent(handle.agentID)
      expect(renewed.state).toBe("running")
      expect(renewed.leaseExpiresAt).toBe(30_000)
      yield* TestClock.adjust(11_001)
      expect((yield* seeded.store.getAgent(handle.agentID)).leaseExpiresAt).toBe(30_000)

      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })
    }),
  )

  it.effect("fails startup when the ready-time durable lease renewal is rejected", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "ready-renewal-rejected.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const rejected = AdaptiveStore.Service.of({
        ...seeded.store,
        heartbeat: (input) =>
          Effect.fail(
            new AdaptiveStore.AgentOwnershipConflictError({
              agentID: input.agentID,
              generation: input.generation,
              owner: input.owner,
            }),
          ),
      })
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) }).pipe(
        Effect.provideService(AdaptiveStore.Service, rejected),
      )

      const exit = yield* supervisor
        .start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "AdaptiveProcessSupervisor.StartError",
          reason: "Adaptive agent ready lease renewal failed",
        })
      const record = yield* seeded.store.getAgent(seeded.agent.id)
      expect(record.state).toBe("failed")
      expect(record.owner).toBeUndefined()
      expect(record.pid).toBeUndefined()
    }),
  )

  it.effect("keeps one terminal owner when the initiating stop is interrupted", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(20_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "interrupted-stop.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ stubborn: true })))
      const grandchild = yield* Deferred.make<number>()
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: (_method, payload) =>
          Deferred.succeed(grandchild, (payload as { grandchildPID: number }).grandchildPID).pipe(Effect.as(null)),
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (process.platform === "win32") return
          try {
            process.kill(-handle.pid, "SIGKILL")
          } catch {
            // The group may already have completed through terminal cleanup.
          }
        }),
      )
      yield* Deferred.await(grandchild)
      const term = yield* waitExists(path.join(directory, ".term")).pipe(Effect.forkChild({ startImmediately: true }))
      const owner = yield* supervisor
        .stop({ agentID: handle.agentID, generation: handle.generation })
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* Fiber.join(term)
      const waiterDone = yield* Deferred.make<void>()
      const waiter = yield* supervisor
        .stop({ agentID: handle.agentID, generation: handle.generation })
        .pipe(Effect.ensuring(Deferred.succeed(waiterDone, undefined)), Effect.forkChild({ startImmediately: true }))
      const interrupting = yield* Fiber.interrupt(owner).pipe(Effect.forkChild({ startImmediately: true }))

      yield* TestClock.adjust(4_000)
      yield* Fiber.join(interrupting)
      const done = yield* Deferred.isDone(waiterDone)
      if (!done) yield* Fiber.interrupt(waiter)
      expect(done).toBe(true)
      if (done) yield* Fiber.join(waiter)
      expect((yield* seeded.store.getAgent(handle.agentID)).state).toBe("stopped")
    }),
  )

  it.effect("quarantines uncertain kill cleanup and blocks same and fresh supervisor starts", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(30_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "broken-kill.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const broken = ChildProcessSpawner.make((command) =>
        real.spawn(command).pipe(
          Effect.map((handle) =>
            ChildProcessSpawner.makeHandle({
              pid: handle.pid,
              stdin: handle.stdin,
              stdout: handle.stdout,
              stderr: handle.stderr,
              all: handle.all,
              getInputFd: handle.getInputFd,
              getOutputFd: handle.getOutputFd,
              isRunning: Effect.succeed(true),
              exitCode: Effect.never,
              kill: () => Effect.die("injected kill defect"),
              unref: handle.unref,
            }),
          ),
        ),
      )
      const commands = { count: 0 }
      const supervisor = yield* AdaptiveProcessSupervisor.make({
        command: (input) => {
          commands.count += 1
          if (commands.count > 1)
            return Effect.fail(
              new AdaptiveProcessSupervisor.StartError({ reason: "same supervisor invoked command", exitCode: 70 }),
            )
          return fixtureCommand(file)(input)
        },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, broken))
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(process.platform === "win32" ? handle.pid : -handle.pid, "SIGKILL")
          } catch {
            // The injected handle cannot clean up the real fixture process.
          }
        }),
      )
      const stopped = yield* supervisor
        .stop({ agentID: handle.agentID, generation: handle.generation })
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      const observed = yield* handle.exited.pipe(
        Effect.exit,
        Effect.timeoutOption("5 seconds"),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust(5_000)

      const stopExit = yield* Fiber.join(stopped)
      expect(Exit.isFailure(stopExit)).toBe(true)
      if (Exit.isFailure(stopExit))
        expect(Cause.squash(stopExit.cause)).toMatchObject({
          _tag: "AdaptiveProcessSupervisor.TerminationError",
          stage: "kill",
        })
      const exit = yield* Fiber.join(observed)
      expect(Option.isSome(exit)).toBe(true)
      if (Option.isSome(exit) && Exit.isFailure(exit.value))
        expect(Cause.squash(exit.value.cause)).toMatchObject({ _tag: "AdaptiveProcessSupervisor.TerminationError" })

      const quarantined = yield* seeded.store.getAgent(handle.agentID)
      expect(quarantined).toMatchObject({
        generation: handle.generation,
        state: "failed",
        owner: expect.any(String),
        pid: handle.pid,
        exitReason: "Adaptive agent process-group kill failed",
      })
      expect(quarantined.leaseExpiresAt).toBeUndefined()

      const same = yield* supervisor
        .start({ agentID: handle.agentID, router: () => Effect.succeed(null) })
        .pipe(Effect.exit)
      expect(Exit.isFailure(same)).toBe(true)
      if (Exit.isFailure(same))
        expect(Cause.squash(same.cause)).toMatchObject({
          _tag: "AdaptiveProcessSupervisor.StartError",
          reason: "Adaptive agent is already active",
        })
      expect(commands.count).toBe(1)

      const freshCommands = { count: 0 }
      const fresh = yield* AdaptiveProcessSupervisor.make({
        command: () => {
          freshCommands.count += 1
          return Effect.fail(
            new AdaptiveProcessSupervisor.StartError({ reason: "fresh supervisor invoked command", exitCode: 70 }),
          )
        },
      })
      const reclaimed = yield* fresh
        .start({ agentID: handle.agentID, router: () => Effect.succeed(null) })
        .pipe(Effect.exit)
      expect(Exit.isFailure(reclaimed)).toBe(true)
      if (Exit.isFailure(reclaimed))
        expect(Cause.squash(reclaimed.cause)).toMatchObject({
          _tag: "AdaptiveProcessSupervisor.StartError",
          reason: "Adaptive agent cleanup is quarantined",
        })
      expect(freshCommands.count).toBe(0)
      expect((yield* seeded.store.getAgent(handle.agentID)).generation).toBe(handle.generation)
    }),
  )

  it.effect("quarantines an RPC interruption timeout without hanging scope cleanup", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(35_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "rpc-interrupt-timeout.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const started = yield* Deferred.make<void>()
      const commands = { count: 0 }
      const supervisor = yield* AdaptiveProcessSupervisor.make({
        command: (input) => {
          commands.count += 1
          if (commands.count > 1)
            return Effect.fail(
              new AdaptiveProcessSupervisor.StartError({ reason: "tombstone invoked command", exitCode: 70 }),
            )
          return fixtureCommand(file)(input)
        },
      })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.uninterruptible(Effect.never))),
      })
      yield* handle.request("process.complete", null).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      const stopping = yield* supervisor
        .stop({ agentID: handle.agentID, generation: handle.generation })
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* waitGone(handle.pid)
      yield* Effect.yieldNow
      yield* TestClock.adjust(1_000)

      const stopped = yield* Fiber.join(stopping)
      expect(Exit.isFailure(stopped)).toBe(true)
      if (Exit.isFailure(stopped))
        expect(Cause.squash(stopped.cause)).toMatchObject({
          _tag: "AdaptiveProcessSupervisor.TerminationError",
          stage: "rpc",
        })
      const quarantined = yield* seeded.store.getAgent(handle.agentID)
      expect(quarantined).toMatchObject({
        state: "failed",
        owner: expect.any(String),
        pid: handle.pid,
        exitReason: "Adaptive agent RPC interruption timed out",
      })
      expect(quarantined.leaseExpiresAt).toBeUndefined()
      const same = yield* supervisor
        .start({ agentID: handle.agentID, router: () => Effect.succeed(null) })
        .pipe(Effect.exit)
      expect(Exit.isFailure(same)).toBe(true)
      expect(commands.count).toBe(1)
    }),
  )

  it.effect("keeps the tombstone and exposes failure when durable quarantine cannot persist", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(40_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "quarantine-failure.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const broken = ChildProcessSpawner.make((command) =>
        real.spawn(command).pipe(
          Effect.map((handle) =>
            ChildProcessSpawner.makeHandle({
              pid: handle.pid,
              stdin: handle.stdin,
              stdout: handle.stdout,
              stderr: handle.stderr,
              all: handle.all,
              getInputFd: handle.getInputFd,
              getOutputFd: handle.getOutputFd,
              isRunning: Effect.succeed(true),
              exitCode: Effect.never,
              kill: () => Effect.die("injected kill defect"),
              unref: handle.unref,
            }),
          ),
        ),
      )
      const attempts = { count: 0 }
      const failing = AdaptiveStore.Service.of({
        ...seeded.store,
        quarantineAgent: (input) =>
          Effect.sync(() => {
            attempts.count += 1
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new AdaptiveStore.AgentOwnershipConflictError({
                  agentID: input.agentID,
                  generation: input.generation,
                  owner: input.owner,
                }),
              ),
            ),
          ),
      })
      const commands = { count: 0 }
      const supervisor = yield* AdaptiveProcessSupervisor.make({
        command: (input) => {
          commands.count += 1
          if (commands.count > 1)
            return Effect.fail(
              new AdaptiveProcessSupervisor.StartError({ reason: "tombstone invoked command", exitCode: 70 }),
            )
          return fixtureCommand(file)(input)
        },
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, broken),
        Effect.provideService(AdaptiveStore.Service, failing),
      )
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(process.platform === "win32" ? handle.pid : -handle.pid, "SIGKILL")
          } catch {
            // The injected handle cannot clean up the fixture process.
          }
        }),
      )
      const stopping = yield* supervisor
        .stop({ agentID: handle.agentID, generation: handle.generation })
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* TestClock.adjust(5_000)

      expect(Exit.isFailure(yield* Fiber.join(stopping))).toBe(true)
      expect(attempts.count).toBe(3)
      const durable = yield* seeded.store.getAgent(handle.agentID)
      expect(durable.state).toBe("running")
      expect(durable.owner).toBeDefined()
      const same = yield* supervisor
        .start({ agentID: handle.agentID, router: () => Effect.succeed(null) })
        .pipe(Effect.exit)
      expect(Exit.isFailure(same)).toBe(true)
      expect(commands.count).toBe(1)
    }),
  )

  it.effect("retries durable settlement and exposes repeated failure to stop and exited", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "settle-failure.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const attempts = { count: 0 }
      const failing = AdaptiveStore.Service.of({
        ...seeded.store,
        settleAgent: (input) =>
          Effect.sync(() => {
            attempts.count += 1
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new AdaptiveStore.AgentOwnershipConflictError({
                  agentID: input.agentID,
                  generation: input.generation,
                  owner: input.owner,
                }),
              ),
            ),
          ),
      })
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) }).pipe(
        Effect.provideService(AdaptiveStore.Service, failing),
      )
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })

      const stopExit = yield* supervisor
        .stop({ agentID: handle.agentID, generation: handle.generation })
        .pipe(Effect.exit)
      expect(Exit.isFailure(stopExit)).toBe(true)
      if (Exit.isFailure(stopExit))
        expect(Cause.squash(stopExit.cause)).toMatchObject({
          _tag: "AdaptiveProcessSupervisor.TerminationError",
          stage: "settle",
        })
      const exited = yield* handle.exited.pipe(Effect.exit)
      expect(Exit.isFailure(exited)).toBe(true)
      if (Exit.isFailure(exited))
        expect(Cause.squash(exited.cause)).toMatchObject({ _tag: "AdaptiveProcessSupervisor.TerminationError" })
      expect(attempts.count).toBe(3)
    }),
  )

  it.effect("settles a clean process.complete exit as stopped with its real code", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "complete.ts")
      yield* Effect.promise(() => Bun.write(file, terminalFixture("complete")))
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })
      yield* waitExists(path.join(directory, ".stdout-ended"))
      yield* Effect.yieldNow
      expect(processExists(handle.pid)).toBe(true)
      expect(["starting", "running"]).toContain((yield* seeded.store.getAgent(handle.agentID)).state)
      yield* Effect.promise(() => Bun.write(path.join(directory, ".exit"), "go"))

      expect(yield* handle.exited).toBe(0)
      const record = yield* seeded.store.getAgent(handle.agentID)
      expect(record.state).toBe("stopped")
      expect(record.exitCode).toBe(0)
      expect(record.exitReason).toBe("Adaptive agent exited normally (code 0)")
      expect(processExists(handle.pid)).toBe(false)
    }),
  )

  it.effect("persists a nonzero process exit code as a distinct failure reason", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "exit-code.ts")
      yield* Effect.promise(() => Bun.write(file, terminalFixture("exit")))
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })

      expect(yield* handle.exited).toBe(23)
      const record = yield* seeded.store.getAgent(handle.agentID)
      expect(record.state).toBe("failed")
      expect(record.exitCode).toBe(23)
      expect(record.exitReason).toBe("Adaptive agent exited with code 23")
    }),
  )

  it.effect("ends event subscribers when terminal cleanup completes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(40_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "events-end.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })
      const events = yield* Stream.runCollect(handle.events).pipe(Effect.forkChild({ startImmediately: true }))
      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })
      const ended = yield* Fiber.join(events).pipe(
        Effect.timeoutOption("1 second"),
        Effect.forkChild({ startImmediately: true }),
      )
      yield* TestClock.adjust(1_000)
      expect(Option.isSome(yield* Fiber.join(ended))).toBe(true)
    }),
  )

  it.effect("persists a specific failure reason for malformed stdout", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "malformed.ts")
      yield* Effect.promise(() => Bun.write(file, terminalFixture("malformed")))
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })
      yield* waitExists(path.join(directory, ".armed"))
      yield* Effect.promise(() => Bun.write(path.join(directory, ".malformed"), "go"))
      yield* handle.exited

      const record = yield* seeded.store.getAgent(handle.agentID)
      expect(record.state).toBe("failed")
      expect(record.exitReason).toBe("Adaptive agent stdout protocol decode failed")
    }),
  )

  it.effect("persists a specific failure reason for stdout transport defects", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "transport.ts")
      yield* Effect.promise(() => Bun.write(file, terminalFixture("transport")))
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const failing = ChildProcessSpawner.make((command) =>
        real.spawn(command).pipe(
          Effect.map((handle) => {
            const failed = Stream.fromEffect(waitExists(path.join(directory, ".stdout-ended")).pipe(Effect.orDie)).pipe(
              Stream.drain,
              Stream.concat(Stream.die("injected stdout transport defect")),
            )
            return ChildProcessSpawner.makeHandle({
              pid: handle.pid,
              stdin: handle.stdin,
              stdout: Stream.merge(handle.stdout, failed),
              stderr: handle.stderr,
              all: handle.all,
              getInputFd: handle.getInputFd,
              getOutputFd: handle.getOutputFd,
              isRunning: handle.isRunning,
              exitCode: handle.exitCode,
              kill: handle.kill,
              unref: handle.unref,
            })
          }),
        ),
      )
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, failing),
      )
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })
      yield* waitExists(path.join(directory, ".armed"))
      yield* Effect.promise(() => Bun.write(path.join(directory, ".transport"), "go"))
      yield* handle.exited

      const record = yield* seeded.store.getAgent(handle.agentID)
      expect(record.state).toBe("failed")
      expect(record.exitReason).toBe("Adaptive agent stdout transport failed")
    }),
  )

  it.effect("treats a duplicate active child RPC id as a protocol failure", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(50_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "rpc-duplicate.ts")
      yield* Effect.promise(() => Bun.write(file, controlFixture("duplicate")))
      const routed: Array<string> = []
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: (_method, payload) =>
          Effect.sync(() => routed.push((payload as { name: string }).name)).pipe(Effect.andThen(Effect.never)),
      })
      yield* waitExists(path.join(directory, ".armed"))
      yield* Effect.promise(() => Bun.write(path.join(directory, ".send"), "go"))
      yield* waitExists(path.join(directory, ".sent"))
      yield* handle.exited

      expect(routed.length).toBeLessThanOrEqual(1)
      const record = yield* seeded.store.getAgent(handle.agentID)
      expect(record.state).toBe("failed")
      expect(record.exitReason).toBe("Adaptive agent RPC protocol violation: duplicate request id duplicate")
    }),
  )

  it.effect("rejects the 33rd pending child RPC as a protocol failure", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(80_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "rpc-limit.ts")
      yield* Effect.promise(() => Bun.write(file, controlFixture("limit")))
      const routed: Array<string> = []
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: (_method, payload) =>
          Effect.sync(() => routed.push((payload as { name: string }).name)).pipe(Effect.andThen(Effect.never)),
      })
      yield* waitExists(path.join(directory, ".armed"))
      yield* Effect.promise(() => Bun.write(path.join(directory, ".send"), "go"))
      yield* waitExists(path.join(directory, ".sent"))
      yield* handle.exited

      expect(routed).not.toContain("32")
      expect(routed.length).toBeLessThanOrEqual(AgentProcessProtocol.MAX_OUTSTANDING_RPC_CALLS)
      const record = yield* seeded.store.getAgent(handle.agentID)
      expect(record.state).toBe("failed")
      expect(record.exitReason).toBe("Adaptive agent RPC protocol violation: more than 32 outstanding requests")
    }),
  )

  it.effect("rejects a completed child RPC id replay for the full connection lifetime", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "rpc-replay.ts")
      yield* Effect.promise(() => Bun.write(file, controlFixture("replay")))
      const barrier = yield* Deferred.make<void>()
      const routed: Array<string> = []
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: (_method, payload) => {
          const name = (payload as { name: string }).name
          routed.push(name)
          return (name === "barrier" ? Deferred.succeed(barrier, undefined) : Effect.void).pipe(Effect.as(null))
        },
      })
      yield* waitExists(path.join(directory, ".armed"))
      yield* Effect.promise(() => Bun.write(path.join(directory, ".send"), "go"))
      yield* waitExists(path.join(directory, ".replayed"))
      const outcome = yield* Effect.raceFirst(
        handle.exited.pipe(
          Effect.as("exited" as const),
          Effect.catch(() => Effect.succeed("exited" as const)),
        ),
        Deferred.await(barrier).pipe(Effect.as("routed" as const)),
      )
      if (outcome === "routed")
        yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation }).pipe(Effect.ignore)

      expect(outcome).toBe("exited")
      expect(routed).toEqual(["first"])
      expect((yield* seeded.store.getAgent(handle.agentID)).exitReason).toBe(
        "Adaptive agent RPC protocol violation: reused request id replay",
      )
    }),
  )

  it.effect("bounds total child RPC request ids retained for one generation", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "rpc-total-cap.ts")
      yield* Effect.promise(() => Bun.write(file, controlFixture("total")))
      const routed = { count: 0 }
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: () =>
          Effect.sync(() => {
            routed.count += 1
            return null
          }),
      })
      yield* waitExists(path.join(directory, ".armed"))
      yield* Effect.promise(() => Bun.write(path.join(directory, ".send"), "go"))
      yield* waitExists(path.join(directory, ".cap-sent"))
      const outcome = yield* Effect.raceFirst(
        handle.exited.pipe(
          Effect.as("exited" as const),
          Effect.catch(() => Effect.succeed("exited" as const)),
        ),
        waitExists(path.join(directory, ".done")).pipe(Effect.as("completed" as const)),
      )
      if (outcome === "completed")
        yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation }).pipe(Effect.ignore)

      expect(outcome).toBe("exited")
      expect(routed.count).toBe(AgentProcessProtocol.MAX_RPC_REQUEST_IDS_PER_GENERATION)
      expect((yield* seeded.store.getAgent(handle.agentID)).exitReason).toBe(
        `Adaptive agent RPC protocol violation: more than ${AgentProcessProtocol.MAX_RPC_REQUEST_IDS_PER_GENERATION} request ids in one generation`,
      )
    }),
  )

  it.effect("removes immediate child RPC completions before admitting the next request", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "rpc-immediate.ts")
      yield* Effect.promise(() => Bun.write(file, controlFixture("immediate")))
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const routed = { count: 0 }
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: () =>
          Effect.gen(function* () {
            routed.count += 1
            if (routed.count === 32) yield* Deferred.succeed(first, undefined)
            if (routed.count === 33) yield* Deferred.succeed(second, undefined)
            return null
          }),
      })
      yield* waitExists(path.join(directory, ".armed"))
      yield* Effect.promise(() => Bun.write(path.join(directory, ".send"), "go"))
      yield* Deferred.await(first).pipe(Effect.timeout("5 seconds"))
      yield* Effect.promise(() => Bun.write(path.join(directory, ".wave2"), "go"))
      yield* Deferred.await(second).pipe(Effect.timeout("5 seconds"))

      expect(routed.count).toBe(33)
      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })
    }),
  )

  it.effect("cancels only the exact registered child RPC", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "rpc-cancel.ts")
      yield* Effect.promise(() => Bun.write(file, controlFixture("cancel")))
      const interruptedA = yield* Deferred.make<void>()
      const interruptedB = yield* Deferred.make<void>()
      const startedA = yield* Deferred.make<void>()
      const startedB = yield* Deferred.make<void>()
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: (_method, payload) => {
          const first = (payload as { name: string }).name === "a"
          return Deferred.succeed(first ? startedA : startedB, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(first ? interruptedA : interruptedB, undefined)),
          )
        },
      })
      yield* waitExists(path.join(directory, ".armed"))
      yield* Effect.promise(() => Bun.write(path.join(directory, ".send"), "go"))
      yield* Effect.all([Deferred.await(startedA), Deferred.await(startedB)], { concurrency: 2 })
      yield* Effect.promise(() => Bun.write(path.join(directory, ".cancel"), "go"))
      yield* Deferred.await(interruptedA).pipe(Effect.timeout("5 seconds"))
      expect(yield* Deferred.isDone(interruptedB)).toBe(false)

      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })
      expect(yield* Deferred.isDone(interruptedB)).toBe(true)
    }),
  )

  it.effect("rejects Handle.request after exit without invoking the router", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "request-after-exit.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const routed = { count: 0 }
      const stream = { count: 0 }
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: () =>
          Effect.sync(() => {
            routed.count += 1
            return Stream.fromEffect(
              Effect.sync(() => {
                stream.count += 1
                return null
              }),
            )
          }),
      })
      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })

      const requested = yield* handle.request("process.complete", null).pipe(Effect.exit)
      expect(Exit.isFailure(requested)).toBe(true)
      if (Exit.isFailure(requested))
        expect(Cause.squash(requested.cause)).toMatchObject({
          _tag: "AdaptiveProcessSupervisor.RpcError",
          code: "PROCESS_EXITED",
        })
      expect(routed.count).toBe(0)
      expect(stream.count).toBe(0)
    }),
  )

  it.effect("collects a lazy Handle.request stream inside supervisor ownership", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "request-stream.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const consumed = { count: 0 }
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: () =>
          Effect.succeed(
            Stream.make({ index: 1 }, { index: 2 }).pipe(
              Stream.tap(() =>
                Effect.sync(() => {
                  consumed.count += 1
                }),
              ),
            ),
          ),
      })

      expect(yield* handle.request("process.complete", null)).toEqual([{ index: 1 }, { index: 2 }])
      expect(consumed.count).toBe(2)
      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })
    }),
  )

  it.effect("interrupts lazy Handle.request stream consumption during termination", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "request-stream-race.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const sideEffects = { count: 0 }
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: () =>
          Effect.succeed(
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.as({ phase: "started" }))),
              Stream.fromEffect(
                Deferred.await(release).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      sideEffects.count += 1
                      return { phase: "late" }
                    }),
                  ),
                ),
              ),
            ),
          ),
      })
      const requested = yield* handle
        .request("process.complete", null)
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })
      yield* Deferred.succeed(release, undefined)

      expect(Exit.isFailure(yield* Fiber.join(requested))).toBe(true)
      expect(sideEffects.count).toBe(0)
    }),
  )

  it.effect("interrupts an in-flight Handle.request before terminal completion", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "request-race.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const sideEffects = { count: 0 }
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              Effect.sync(() => {
                sideEffects.count += 1
                return null
              }),
            ),
          ),
      })
      const requested = yield* handle
        .request("process.complete", null)
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })
      yield* Deferred.succeed(release, undefined)

      expect(Exit.isFailure(yield* Fiber.join(requested))).toBe(true)
      expect(sideEffects.count).toBe(0)
    }),
  )

  it.effect("coalesces heartbeat floods while accepting the normal five-second cadence", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(100_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "heartbeat-flood.ts")
      yield* Effect.promise(() => Bun.write(file, controlFixture("heartbeat")))
      const heartbeats = { count: 0 }
      const counted = AdaptiveStore.Service.of({
        ...seeded.store,
        heartbeat: (input) =>
          Effect.sync(() => {
            heartbeats.count += 1
          }).pipe(Effect.andThen(seeded.store.heartbeat(input))),
      })
      const first = yield* Deferred.make<void>()
      const second = yield* Deferred.make<void>()
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) }).pipe(
        Effect.provideService(AdaptiveStore.Service, counted),
      )
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: (_method, payload) => {
          const name = (payload as { name: string }).name
          return Deferred.succeed(name === "wave1" ? first : second, undefined).pipe(Effect.as(null))
        },
      })
      yield* waitExists(path.join(directory, ".armed"))
      yield* Effect.promise(() => Bun.write(path.join(directory, ".send"), "go"))
      yield* Deferred.await(first).pipe(Effect.timeout("5 seconds"))
      yield* TestClock.adjust(5_000)
      yield* Effect.promise(() => Bun.write(path.join(directory, ".send2"), "go"))
      yield* Deferred.await(second).pipe(Effect.timeout("5 seconds"))

      expect(heartbeats.count).toBe(3)
      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })
    }),
  )

  it.effect("backpressures a decoded frame flood and still completes terminal cleanup", () =>
    Effect.gen(function* () {
      const capacity = 64
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "frame-backpressure.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const gate = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<void>()
      const pulled = yield* Deferred.make<void>()
      const pulls = { count: 0 }
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      const flooding = ChildProcessSpawner.make((command) =>
        real.spawn(command).pipe(
          Effect.map((handle) => {
            const flood = Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.flatMap(() =>
                Stream.fromIterable(
                  Array.from({ length: 1_000 }, (_, index) =>
                    AgentProcessProtocol.encode({
                      v: AgentProcessProtocol.VERSION,
                      id: `flood-${index}`,
                      type: "heartbeat",
                    }),
                  ),
                ),
              ),
              Stream.tap(() =>
                Effect.sync(() => {
                  pulls.count += 1
                }).pipe(
                  Effect.andThen(pulls.count === capacity + 2 ? Deferred.succeed(pulled, undefined) : Effect.void),
                ),
              ),
            )
            return ChildProcessSpawner.makeHandle({
              pid: handle.pid,
              stdin: handle.stdin,
              stdout: Stream.merge(handle.stdout, flood),
              stderr: handle.stderr,
              all: handle.all,
              getInputFd: handle.getInputFd,
              getOutputFd: handle.getOutputFd,
              isRunning: handle.isRunning,
              exitCode: handle.exitCode,
              kill: handle.kill,
              unref: handle.unref,
            })
          }),
        ),
      )
      const heartbeats = { count: 0 }
      const store = AdaptiveStore.Service.of({
        ...seeded.store,
        heartbeat: (input) => {
          heartbeats.count += 1
          if (heartbeats.count === 1) return seeded.store.heartbeat(input)
          return Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never))
        },
      })
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, flooding),
        Effect.provideService(AdaptiveStore.Service, store),
      )
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })
      yield* Deferred.succeed(gate, undefined)
      yield* Deferred.await(pulled)
      yield* Effect.forEach(Array.from({ length: 1_000 }), () => Effect.yieldNow, { discard: true })

      expect(pulls.count).toBeLessThanOrEqual(capacity + 4)
      expect(Reflect.get(AdaptiveProcessSupervisor, "FRAME_QUEUE_CAPACITY")).toBe(capacity)
      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })
      expect((yield* seeded.store.getAgent(handle.agentID)).state).toBe("stopped")
    }),
  )

  it.effect("stops when a non-reading child fills the bounded controller input queue", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "input-backpressure.ts")
      yield* Effect.promise(() => Bun.write(file, controlFixture("outbound")))
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: () => Effect.succeed("x".repeat(512 * 1024)),
      })
      yield* waitExists(path.join(directory, ".armed"))
      yield* Effect.promise(() => Bun.write(path.join(directory, ".send"), "go"))
      yield* waitExists(path.join(directory, ".sent"))
      yield* Effect.forEach(Array.from({ length: 100 }), () => Effect.yieldNow, { discard: true })

      expect(Reflect.get(AdaptiveProcessSupervisor, "INPUT_QUEUE_CAPACITY")).toBe(8)
      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })
      expect(processExists(handle.pid)).toBe(false)
      expect((yield* seeded.store.getAgent(handle.agentID)).state).toBe("stopped")
    }),
  )

  it.effect("rejects a stale hello before accepted, claim, or RPC routing", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const first = yield* seeded.store.claimAgent({
        agentID: seeded.agent.id,
        expectedGeneration: 0,
        owner: "prior-owner",
        pid: process.pid,
        leaseDurationMs: 20_000,
      })
      yield* seeded.store.settleAgent({
        agentID: seeded.agent.id,
        generation: first.generation,
        owner: "prior-owner",
        state: "stopped",
      })
      const file = path.join(directory, "stale.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ generation: 0, heartbeatGate: true })))
      const routed = yield* Deferred.make<void>()
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })

      const error = yield* supervisor
        .start({
          agentID: seeded.agent.id,
          router: () => Deferred.succeed(routed, undefined).pipe(Effect.as(null)),
        })
        .pipe(Effect.flip)

      expect(error._tag).toBe("AdaptiveProcessSupervisor.StartError")
      expect(error.exitCode).toBe(64)
      expect(existsSync(path.join(directory, ".accepted"))).toBe(false)
      expect(yield* Deferred.isDone(routed)).toBe(false)
      expect((yield* seeded.store.getAgent(seeded.agent.id)).generation).toBe(1)
    }),
  )

  it.effect("extends only the matching durable lease after a ready child heartbeat", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const other = yield* seeded.store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: seeded.task.id,
        role: "validator",
      })
      const file = path.join(directory, "heartbeat.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ heartbeatGate: true })))
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({ agentID: seeded.agent.id, router: () => Effect.succeed(null) })
      const initial = yield* seeded.store.getAgent(handle.agentID)
      const otherInitial = yield* seeded.store.getAgent(other.id)

      yield* TestClock.adjust(1_000)
      const heartbeatFiber = yield* waitFor(handle.events, (event) => event.type === "heartbeat").pipe(Effect.forkChild)
      yield* Effect.promise(() => Bun.write(path.join(directory, ".heartbeat"), "go"))
      const heartbeat = yield* Fiber.join(heartbeatFiber)
      expect(heartbeat.type).toBe("heartbeat")
      const renewed = yield* seeded.store.getAgent(handle.agentID)
      const otherAfter = yield* seeded.store.getAgent(other.id)
      expect(renewed.generation).toBe(handle.generation)
      expect(renewed.leaseExpiresAt).toBeGreaterThan(initial.leaseExpiresAt!)
      expect(otherAfter).toEqual(otherInitial)

      yield* supervisor.stop({ agentID: handle.agentID, generation: handle.generation })
    }),
  )

  it.effect("marks a silent generation lost and removes its whole process group", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(10_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "silent.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({})))
      const grandchild = yield* Deferred.make<number>()
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: (_method, payload) =>
          Deferred.succeed(grandchild, (payload as { grandchildPID: number }).grandchildPID).pipe(Effect.as(null)),
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (process.platform === "win32" || !processExists(handle.pid)) return
          try {
            process.kill(-handle.pid, "SIGKILL")
          } catch {
            // The group may have completed between the liveness check and signal.
          }
        }),
      )
      const grandchildPID = yield* Deferred.await(grandchild)
      expect(processExists(handle.pid)).toBe(true)
      expect(processExists(grandchildPID)).toBe(true)

      yield* TestClock.adjust(23_000)
      yield* handle.exited
      yield* Effect.all([waitGone(handle.pid), waitGone(grandchildPID)], { concurrency: 2 })
      const lost = yield* seeded.store.getAgent(handle.agentID)
      expect(lost.generation).toBe(handle.generation)
      expect(lost.state).toBe("lost")
      expect(lost.exitReason).toBe("Adaptive agent heartbeat lease expired")
      expect(processGroupExists(handle.pid)).toBe(false)
    }),
  )

  it.effect("force kills a stubborn grandchild three seconds after its parent exits on stop", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(50_000)
      const directory = yield* tmpdirScoped()
      const seeded = yield* seed(directory)
      const file = path.join(directory, "stubborn.ts")
      yield* Effect.promise(() => Bun.write(file, fixture({ stubborn: true })))
      const grandchild = yield* Deferred.make<number>()
      const routed = { count: 0 }
      const supervisor = yield* AdaptiveProcessSupervisor.make({ command: fixtureCommand(file) })
      const handle = yield* supervisor.start({
        agentID: seeded.agent.id,
        router: (_method, payload) =>
          Effect.sync(() => {
            routed.count += 1
          }).pipe(
            Effect.andThen(Deferred.succeed(grandchild, (payload as { grandchildPID: number }).grandchildPID)),
            Effect.as(null),
          ),
      })
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (process.platform === "win32") return
          try {
            process.kill(-handle.pid, "SIGKILL")
          } catch {
            // The group may have completed between the liveness check and signal.
          }
        }),
      )
      const grandchildPID = yield* Deferred.await(grandchild)
      expect(routed.count).toBe(1)

      const term = yield* waitExists(path.join(directory, ".term")).pipe(Effect.forkChild({ startImmediately: true }))
      const stopping = yield* supervisor
        .stop({ agentID: handle.agentID, generation: handle.generation })
        .pipe(Effect.forkChild)
      yield* Fiber.join(term)
      yield* waitGone(handle.pid)
      yield* TestClock.adjust(2_999)
      expect(processExists(grandchildPID)).toBe(true)
      yield* TestClock.adjust(1)
      yield* Fiber.join(stopping)
      expect(processExists(handle.pid)).toBe(false)
      expect(processExists(grandchildPID)).toBe(false)
      expect(processGroupExists(handle.pid)).toBe(false)
      expect(routed.count).toBe(1)
      const record = yield* seeded.store.getAgent(handle.agentID)
      expect(record.state).toBe("stopped")
      expect(record.exitReason).toBe("Adaptive agent stopped by Controller")
    }),
  )
})
