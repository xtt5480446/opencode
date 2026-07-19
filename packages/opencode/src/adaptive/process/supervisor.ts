import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, PubSub, Queue, Schema, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AgentProcessProtocol } from "./protocol"
import { AdaptiveProcessCommand } from "./command"

export const HEARTBEAT_MS = 5_000
export const LEASE_DURATION_MS = 20_000
export const STDERR_PREVIEW_BYTES = 64 * 1024

export class StartError extends Schema.TaggedErrorClass<StartError>()("AdaptiveProcessSupervisor.StartError", {
  reason: Schema.String,
  exitCode: Schema.Number,
}) {}

export class RpcError extends Schema.TaggedErrorClass<RpcError>()("AdaptiveProcessSupervisor.RpcError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export type Method = "model.stream" | "process.complete"
export type RouteResult = AgentProcessProtocol.JsonValue | Stream.Stream<AgentProcessProtocol.JsonValue, RpcError>
export type BoundIdentity = Readonly<{
  taskID: AdaptiveTask.ID
  agentID: AdaptiveTask.AgentID
  generation: number
  role: AdaptiveTask.Role
}>
export type Router = (
  method: Method,
  payload: AgentProcessProtocol.JsonValue,
  identity: BoundIdentity,
) => Effect.Effect<RouteResult, RpcError>

export interface StartInput {
  readonly agentID: AdaptiveTask.AgentID
  readonly router: Router
}

export interface StopInput {
  readonly agentID: AdaptiveTask.AgentID
  readonly generation?: number
}

export interface RestartInput extends StartInput {}

export interface Handle {
  readonly agentID: AdaptiveTask.AgentID
  readonly generation: number
  readonly pid: number
  readonly request: (method: Method, payload: AgentProcessProtocol.JsonValue) => Effect.Effect<RouteResult, RpcError>
  readonly events: Stream.Stream<AgentProcessProtocol.ChildToController>
  readonly exited: Effect.Effect<number>
  readonly stderrPreview: Effect.Effect<string>
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<Handle, StartError, Scope.Scope>
  readonly stop: (input: StopInput) => Effect.Effect<void>
  readonly restart: (input: RestartInput) => Effect.Effect<Handle, StartError, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AdaptiveProcessSupervisor") {}

type CommandFactory = (input: AdaptiveProcessCommand.Input) => Effect.Effect<ChildProcess.Command, StartError>

export interface MakeOptions {
  readonly command?: CommandFactory
}

type Envelope =
  | { readonly type: "frame"; readonly frame: AgentProcessProtocol.ChildToController }
  | { readonly type: "error" }
  | { readonly type: "end" }

interface Active {
  readonly identity: BoundIdentity
  readonly owner: string
  readonly process: ChildProcessSpawner.ChildProcessHandle
  readonly input: Queue.Queue<Uint8Array | null>
  readonly frames: Queue.Queue<Envelope>
  readonly heartbeats: Queue.Queue<void>
  readonly events: PubSub.PubSub<AgentProcessProtocol.ChildToController>
  readonly exited: Deferred.Deferred<number>
  readonly stderrDone: Deferred.Deferred<void>
  readonly rpc: Map<string, Fiber.Fiber<void, never>>
  readonly preview: { text: string; bytes: number }
  finishing?: Deferred.Deferred<void>
}

export const make = Effect.fn("AdaptiveProcessSupervisor.make")(function* (options: MakeOptions = {}) {
  const store = yield* AdaptiveStore.Service
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const active = new Map<AdaptiveTask.AgentID, Active>()
  const command = options.command ?? ((input) => AdaptiveProcessCommand.make(input))

  const send = Effect.fnUntraced(function* (state: Active, frame: AgentProcessProtocol.ControllerToChild) {
    yield* Queue.offer(state.input, AgentProcessProtocol.encode(frame))
  })

  const settle = Effect.fnUntraced(function* (state: Active, desired: "stopped" | "lost" | "failed", exitCode: number) {
    yield* store
      .settleAgent({
        agentID: state.identity.agentID,
        generation: state.identity.generation,
        owner: state.owner,
        state: desired,
        exitCode,
        exitReason: desired === "lost" ? "Adaptive agent heartbeat lease expired" : undefined,
      })
      .pipe(Effect.ignore)
  })

  const finish = Effect.fnUntraced(function* (
    state: Active,
    desired: "stopped" | "lost" | "failed",
    kill: boolean,
    knownCode?: number,
  ) {
    if (state.finishing) return yield* Deferred.await(state.finishing)
    const finishing = yield* Deferred.make<void>()
    state.finishing = finishing

    if (kill) yield* state.process.kill({ forceKillAfter: 3_000 }).pipe(Effect.ignore)
    yield* Queue.offer(state.input, null).pipe(Effect.ignore)
    const code =
      knownCode ??
      (yield* state.process.exitCode.pipe(
        Effect.map(Number),
        Effect.catch(() => Effect.succeed(128)),
      ))
    yield* Effect.forEach(state.rpc.values(), Fiber.interrupt, { discard: true })
    state.rpc.clear()
    yield* settle(state, desired, code)
    active.delete(state.identity.agentID)
    yield* Deferred.succeed(state.exited, code).pipe(Effect.ignore)
    yield* Deferred.succeed(finishing, undefined).pipe(Effect.ignore)
  })

  const route = (
    state: Active,
    input: StartInput,
    frame: Extract<AgentProcessProtocol.ChildToController, { type: "rpc.request" }>,
  ) =>
    Effect.gen(function* () {
      const result = yield* input.router(frame.method, frame.payload, state.identity)
      if (Stream.isStream(result)) {
        yield* Stream.runForEach(result, (payload) =>
          send(state, {
            v: AgentProcessProtocol.VERSION,
            id: crypto.randomUUID(),
            type: "rpc.event",
            requestID: frame.id,
            payload,
          }),
        )
        yield* send(state, {
          v: AgentProcessProtocol.VERSION,
          id: crypto.randomUUID(),
          type: "rpc.end",
          requestID: frame.id,
        })
        return
      }
      yield* send(state, {
        v: AgentProcessProtocol.VERSION,
        id: crypto.randomUUID(),
        type: "rpc.response",
        requestID: frame.id,
        payload: result,
      })
    }).pipe(
      Effect.catch((error) =>
        send(state, {
          v: AgentProcessProtocol.VERSION,
          id: crypto.randomUUID(),
          type: "rpc.error",
          requestID: frame.id,
          code: error.code,
          message: error.message,
        }).pipe(Effect.ignore),
      ),
      Effect.ensuring(Effect.sync(() => state.rpc.delete(frame.id))),
    )

  const runFrames = (state: Active, input: StartInput, scope: Scope.Scope) =>
    Effect.gen(function* () {
      while (!state.finishing) {
        const envelope = yield* Queue.take(state.frames)
        if (state.finishing) return
        if (envelope.type !== "frame") return yield* finish(state, "lost", true)
        const frame = envelope.frame
        if (frame.type === "hello" || frame.type === "ready") return yield* finish(state, "lost", true)
        if (frame.type === "heartbeat") {
          const heartbeat = yield* store
            .heartbeat({
              agentID: state.identity.agentID,
              generation: state.identity.generation,
              owner: state.owner,
              leaseDurationMs: LEASE_DURATION_MS,
            })
            .pipe(Effect.option)
          if (Option.isNone(heartbeat)) return yield* finish(state, "lost", true)
          yield* Queue.offer(state.heartbeats, undefined)
          yield* PubSub.publish(state.events, frame)
          continue
        }
        yield* PubSub.publish(state.events, frame)
        if (frame.type === "rpc.cancel") {
          const fiber = state.rpc.get(frame.requestID)
          if (fiber) yield* Fiber.interrupt(fiber)
          continue
        }
        const fiber = yield* route(state, input, frame).pipe(Effect.forkIn(scope, { startImmediately: true }))
        state.rpc.set(frame.id, fiber)
      }
    }).pipe(
      Effect.catchCause(() => (state.finishing ? Effect.void : finish(state, "lost", true))),
      Effect.asVoid,
    )

  const watchLease = (state: Active, ready: Deferred.Deferred<void>) =>
    Effect.gen(function* () {
      let armed = false
      while (!state.finishing) {
        const deadline = yield* Effect.sleep(LEASE_DURATION_MS).pipe(
          Effect.as("expired" as const),
          Effect.forkChild({ startImmediately: true }),
        )
        if (!armed) {
          armed = true
          yield* Deferred.succeed(ready, undefined)
        }
        const next = yield* Effect.race(
          Queue.take(state.heartbeats).pipe(Effect.as("heartbeat" as const)),
          Fiber.join(deadline),
        )
        yield* Fiber.interrupt(deadline)
        if (next === "expired") return yield* finish(state, "lost", true)
      }
    }).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.asVoid,
    )

  const start = Effect.fn("AdaptiveProcessSupervisor.start")(function* (input: StartInput) {
    const scope = yield* Scope.Scope
    const existing = active.get(input.agentID)
    if (existing) return yield* new StartError({ reason: "Adaptive agent is already active", exitCode: 64 })

    const record = yield* store
      .getAgent(input.agentID)
      .pipe(Effect.mapError(() => new StartError({ reason: "Adaptive agent was not found", exitCode: 64 })))
    const task = yield* store
      .getTask(record.taskID)
      .pipe(Effect.mapError(() => new StartError({ reason: "Adaptive task was not found", exitCode: 64 })))
    const identity = {
      taskID: task.id,
      agentID: record.id,
      generation: record.generation + 1,
      role: record.role,
    } satisfies BoundIdentity
    const child = yield* command({ directory: task.directory, ...identity })
    const inputQueue = yield* Queue.unbounded<Uint8Array | null>()
    const frames = yield* Queue.unbounded<Envelope>()
    const heartbeats = yield* Queue.unbounded<void>()
    const events = yield* PubSub.unbounded<AgentProcessProtocol.ChildToController>()
    const exited = yield* Deferred.make<number>()
    const stderrDone = yield* Deferred.make<void>()
    const process = yield* spawner
      .spawn(child)
      .pipe(Effect.mapError(() => new StartError({ reason: "Adaptive agent process failed to spawn", exitCode: 70 })))
    const state: Active = {
      identity,
      owner: `${globalThis.process.pid}:${crypto.randomUUID()}`,
      process,
      input: inputQueue,
      frames,
      heartbeats,
      events,
      exited,
      stderrDone,
      rpc: new Map(),
      preview: { text: "", bytes: 0 },
    }

    return yield* Effect.gen(function* () {
      yield* Stream.run(
        Stream.fromQueue(inputQueue).pipe(Stream.takeWhile((chunk): chunk is Uint8Array => chunk !== null)),
        process.stdin,
      ).pipe(Effect.ignore, Effect.forkIn(scope))
      yield* readFrames(state).pipe(Effect.forkIn(scope, { startImmediately: true }))
      yield* readStderr(state).pipe(Effect.forkIn(scope, { startImmediately: true }))

      const hello = yield* takeHandshake(state, "hello")
      if (
        hello.type !== "hello" ||
        hello.taskID !== identity.taskID ||
        hello.agentID !== identity.agentID ||
        hello.generation !== identity.generation ||
        hello.role !== identity.role
      )
        return yield* new StartError({ reason: "Adaptive agent hello identity mismatch", exitCode: 64 })

      const claim = yield* store
        .claimAgent({
          agentID: identity.agentID,
          expectedGeneration: record.generation,
          owner: state.owner,
          pid: Number(process.pid),
          leaseDurationMs: LEASE_DURATION_MS,
        })
        .pipe(Effect.option)
      if (Option.isNone(claim) || claim.value.generation !== identity.generation)
        return yield* new StartError({ reason: "Adaptive agent durable generation claim failed", exitCode: 64 })

      yield* send(state, {
        v: AgentProcessProtocol.VERSION,
        id: crypto.randomUUID(),
        type: "accepted",
        heartbeatMs: HEARTBEAT_MS,
      })
      const ready = yield* takeHandshake(state, "ready")
      if (ready.type !== "ready")
        return yield* new StartError({ reason: "Adaptive agent did not become ready", exitCode: 64 })

      active.set(identity.agentID, state)
      yield* PubSub.publish(state.events, ready)
      yield* runFrames(state, input, scope).pipe(Effect.forkIn(scope, { startImmediately: true }))
      const leaseReady = yield* Deferred.make<void>()
      yield* watchLease(state, leaseReady).pipe(Effect.forkIn(scope, { startImmediately: true }))
      yield* Deferred.await(leaseReady)
      yield* process.exitCode.pipe(
        Effect.map(Number),
        Effect.catch(() => Effect.succeed(128)),
        Effect.flatMap((code) => finish(state, code === 0 ? "stopped" : "failed", false, code)),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      yield* Effect.addFinalizer(() =>
        state.finishing ? Deferred.await(state.finishing) : finish(state, "lost", true),
      )

      return {
        agentID: identity.agentID,
        generation: identity.generation,
        pid: Number(process.pid),
        request: (method: Method, payload: AgentProcessProtocol.JsonValue) => input.router(method, payload, identity),
        events: Stream.fromPubSub(state.events),
        exited: Deferred.await(state.exited),
        stderrPreview: Deferred.await(state.stderrDone).pipe(Effect.map(() => state.preview.text)),
      }
    }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? finish(state, "failed", true) : Effect.void)))
  })

  const stop = Effect.fn("AdaptiveProcessSupervisor.stop")(function* (input: StopInput) {
    const state = active.get(input.agentID)
    if (!state || (input.generation !== undefined && input.generation !== state.identity.generation)) return
    yield* send(state, {
      v: AgentProcessProtocol.VERSION,
      id: crypto.randomUUID(),
      type: "shutdown",
      reason: "Adaptive agent stopped by Controller",
    }).pipe(Effect.ignore)
    yield* finish(state, "stopped", true)
  })

  const restart = Effect.fn("AdaptiveProcessSupervisor.restart")(function* (input: RestartInput) {
    const state = active.get(input.agentID)
    if (state) yield* stop({ agentID: input.agentID, generation: state.identity.generation })
    return yield* start(input)
  })

  return { start, stop, restart } satisfies Interface
})

function readFrames(state: Active) {
  const decoder = AgentProcessProtocol.makeDecoder("child-to-controller")
  return Stream.runForEach(state.process.stdout, (chunk) =>
    Effect.sync(() => {
      try {
        return decoder.push(chunk)
      } catch {
        return undefined
      }
    }).pipe(
      Effect.flatMap((decoded) => {
        if (decoded === undefined) return Queue.offer(state.frames, { type: "error" }).pipe(Effect.asVoid)
        return Queue.offerAll(
          state.frames,
          decoded.map((frame) => ({ type: "frame" as const, frame })),
        ).pipe(Effect.asVoid)
      }),
    ),
  ).pipe(
    Effect.andThen(
      Effect.sync(() => {
        try {
          decoder.finish()
          return "end" as const
        } catch {
          return "error" as const
        }
      }).pipe(
        Effect.flatMap((type) => Queue.offer(state.frames, { type })),
        Effect.asVoid,
      ),
    ),
    Effect.catchCause(() => Queue.offer(state.frames, { type: "error" }).pipe(Effect.asVoid)),
    Effect.asVoid,
  )
}

function readStderr(state: Active) {
  const decoder = new TextDecoder()
  return Stream.runForEach(state.process.stderr, (chunk) =>
    Effect.sync(() => {
      if (state.preview.bytes >= STDERR_PREVIEW_BYTES) return
      const slice = chunk.subarray(0, STDERR_PREVIEW_BYTES - state.preview.bytes)
      state.preview.bytes += slice.byteLength
      state.preview.text += decoder.decode(slice, { stream: true })
    }),
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        state.preview.text = sanitizePreview(state.preview.text + decoder.decode())
      }).pipe(Effect.andThen(Deferred.succeed(state.stderrDone, undefined)), Effect.ignore),
    ),
    Effect.ignore,
  )
}

function takeHandshake(state: Active, expected: "hello" | "ready") {
  return Queue.take(state.frames).pipe(
    Effect.timeoutOption("10 seconds"),
    Effect.flatMap((envelope) => {
      if (Option.isNone(envelope) || envelope.value.type !== "frame") {
        return Effect.fail(new StartError({ reason: `Adaptive agent ${expected} handshake failed`, exitCode: 64 }))
      }
      return Effect.succeed(envelope.value.frame)
    }),
  )
}

function sanitizePreview(input: string) {
  return input
    .replace(/((?:key|token|secret|password|auth|credential|cookie)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/:\/\/[^/@\s]+@/g, "://[REDACTED]@")
}

const layer = Layer.effect(Service, make())
export const node = makeGlobalNode({ service: Service, layer, deps: [AdaptiveStore.node, CrossSpawnSpawner.node] })

export * as AdaptiveProcessSupervisor from "./supervisor"
