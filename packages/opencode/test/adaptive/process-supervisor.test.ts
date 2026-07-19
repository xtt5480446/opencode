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
import { Deferred, Duration, Effect, Fiber, Option, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ChildProcess } from "effect/unstable/process"
import { existsSync } from "node:fs"
import path from "path"
import { AdaptiveProcessSupervisor } from "@/adaptive/process/supervisor"
import { AdaptiveProcessCommand } from "@/adaptive/process/command"
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

describe("AdaptiveProcessCommand", () => {
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
  for (const scenario of [
    { name: "kills a child when hello times out", phase: "hello", end: "timeout", claimed: false },
    { name: "observes a gone child when hello ends at EOF", phase: "hello", end: "eof", claimed: false },
    { name: "settles and kills a claimed generation when ready times out", phase: "ready", end: "timeout", claimed: true },
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
      expect(routed.count).toBe(1)
      expect((yield* seeded.store.getAgent(handle.agentID)).state).toBe("stopped")
    }),
  )
})
