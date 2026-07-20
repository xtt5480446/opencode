import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { AgentProcessProtocol } from "./protocol"
import { AdaptiveProcessCommand } from "./command"

export const HEARTBEAT_MS = 5_000
export const LEASE_DURATION_MS = 20_000
export const HEARTBEAT_MIN_INTERVAL_MS = 2_500
export const STDERR_PREVIEW_BYTES = 64 * 1024
export const INPUT_QUEUE_CAPACITY = 8
export const FRAME_QUEUE_CAPACITY = 64
const KILL_TIMEOUT_MS = 5_000
const EXIT_TIMEOUT_MS = 1_000
const RPC_INTERRUPT_TIMEOUT_MS = 1_000
const STDERR_SETTLE_TIMEOUT_MS = 1_000
const SETTLE_TIMEOUT_MS = 500
const SETTLE_RETRIES = 2

export class StartError extends Schema.TaggedErrorClass<StartError>()("AdaptiveProcessSupervisor.StartError", {
  reason: Schema.String,
  exitCode: Schema.Number,
}) {}

export class RpcError extends Schema.TaggedErrorClass<RpcError>()("AdaptiveProcessSupervisor.RpcError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export class TerminationError extends Schema.TaggedErrorClass<TerminationError>()(
  "AdaptiveProcessSupervisor.TerminationError",
  {
    stage: Schema.Literals(["kill", "exit", "rpc", "settle", "cleanup"]),
    reason: Schema.String,
    exitCode: Schema.Number,
  },
) {}

export type Method = "model.stream" | "process.complete"
export type RouteResult = AgentProcessProtocol.JsonValue | Stream.Stream<AgentProcessProtocol.JsonValue, RpcError>
export type BoundIdentity = Readonly<{
  taskID: AdaptiveTask.ID
  agentID: AdaptiveTask.AgentID
  generation: number
  role: AdaptiveTask.Role
}>
export type ClaimedIdentity = BoundIdentity &
  Readonly<{
    owner: string
    pid: number
  }>
export type Router = (
  method: Method,
  payload: AgentProcessProtocol.JsonValue,
  identity: BoundIdentity,
) => Effect.Effect<RouteResult, RpcError>

export interface StartInput {
  readonly agentID: AdaptiveTask.AgentID
  readonly prepare?: (identity: ClaimedIdentity) => Effect.Effect<void, RpcError>
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
  /** Durable lease owner used when writing manifests for this generation. */
  readonly owner: string
  readonly pid: number
  readonly request: (
    method: Method,
    payload: AgentProcessProtocol.JsonValue,
  ) => Effect.Effect<AgentProcessProtocol.JsonValue, RpcError>
  readonly events: Stream.Stream<AgentProcessProtocol.ChildToController>
  readonly exited: Effect.Effect<number, TerminationError>
  readonly stderrPreview: Effect.Effect<string>
}

export interface Interface {
  readonly start: (input: StartInput) => Effect.Effect<Handle, StartError, Scope.Scope>
  readonly stop: (input: StopInput) => Effect.Effect<void, TerminationError>
  readonly restart: (input: RestartInput) => Effect.Effect<Handle, StartError | TerminationError, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AdaptiveProcessSupervisor") {}

type CommandFactory = (input: AdaptiveProcessCommand.Input) => Effect.Effect<ChildProcess.Command, StartError>

export interface MakeOptions {
  readonly command?: CommandFactory
}

type Envelope =
  | { readonly type: "frame"; readonly frame: AgentProcessProtocol.ChildToController }
  | { readonly type: "error"; readonly reason: string }
  | { readonly type: "end" }

interface Termination {
  readonly state: "stopped" | "lost" | "failed"
  readonly reason: string
  readonly kill: boolean
  readonly knownCode?: number
}

interface RpcRegistration {
  readonly origin: "child" | "handle"
  fiber?: Fiber.Fiber<unknown, unknown>
  cancelled: boolean
}

interface Active {
  readonly identity: BoundIdentity
  readonly owner: string
  readonly process: ChildProcessSpawner.ChildProcessHandle
  readonly input: Queue.Queue<Uint8Array | null>
  readonly frames: Queue.Queue<Envelope>
  readonly heartbeats: Queue.Queue<void>
  readonly events: PubSub.PubSub<AgentProcessProtocol.ChildToController>
  readonly exited: Deferred.Deferred<number, TerminationError>
  readonly finished: Deferred.Deferred<void, TerminationError>
  readonly stderrDone: Deferred.Deferred<void>
  readonly rpc: Map<string, RpcRegistration>
  readonly usedChildRPC: Set<string>
  readonly preview: { text: string; bytes: number; decoder: TextDecoder; finalized: boolean }
  stderrFiber?: Fiber.Fiber<void>
  claimed: boolean
  finishStarted: boolean
  lastHeartbeatAt?: number
}

export const make = Effect.fn("AdaptiveProcessSupervisor.make")(function* (options: MakeOptions = {}) {
  const store = yield* AdaptiveStore.Service
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const active = new Map<AdaptiveTask.AgentID, Active>()
  const command = options.command ?? ((input) => AdaptiveProcessCommand.make(input))

  const send = Effect.fnUntraced(function* (state: Active, frame: AgentProcessProtocol.ControllerToChild) {
    yield* Queue.offer(state.input, AgentProcessProtocol.encode(frame))
  })

  const sendBestEffort = Effect.fnUntraced(function* (state: Active, frame: AgentProcessProtocol.ControllerToChild) {
    yield* Effect.raceFirst(Queue.offer(state.input, AgentProcessProtocol.encode(frame)), Effect.void)
  })

  const bounded = <A, E, R>(effect: Effect.Effect<A, E, R>, duration: number) =>
    Effect.gen(function* () {
      const result = yield* Deferred.make<Exit.Exit<A, E> | "timeout">()
      const worker = yield* effect.pipe(
        Effect.interruptible,
        Effect.exit,
        Effect.flatMap((exit) => Deferred.succeed(result, exit)),
        Effect.forkChild({ startImmediately: true }),
      )
      const deadline = yield* Effect.sleep(duration).pipe(
        Effect.andThen(Deferred.succeed(result, "timeout")),
        Effect.forkChild({ startImmediately: true }),
      )
      const outcome = yield* Deferred.await(result)
      yield* Fiber.interrupt(worker).pipe(Effect.forkDetach({ startImmediately: true }))
      yield* Fiber.interrupt(deadline).pipe(Effect.forkDetach({ startImmediately: true }))
      return outcome
    })

  const shutdown = Effect.fnUntraced(function* (state: Active, release: boolean) {
    yield* Queue.shutdown(state.input).pipe(Effect.exit)
    yield* Queue.shutdown(state.frames).pipe(Effect.exit)
    yield* Queue.shutdown(state.heartbeats).pipe(Effect.exit)
    yield* PubSub.shutdown(state.events).pipe(Effect.exit)
    yield* Effect.sync(() => {
      if (release && active.get(state.identity.agentID) === state) active.delete(state.identity.agentID)
    })
  })

  const finish = Effect.fnUntraced(function* (state: Active, terminal: Termination) {
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const owner = yield* Effect.sync(() => {
          if (state.finishStarted) return false
          state.finishStarted = true
          return true
        })
        if (!owner) return yield* Deferred.await(state.finished)

        let code = terminal.knownCode ?? 128
        let problem: TerminationError | undefined
        let uncertain = false
        let terminationConfirmed = terminal.knownCode !== undefined
        const record = (stage: TerminationError["stage"], reason: string, ownershipUncertain = false) => {
          problem ??= new TerminationError({ stage, reason, exitCode: code })
          uncertain ||= ownershipUncertain
        }
        const cleanup = Effect.gen(function* () {
          if (terminal.kill) {
            const killed = yield* bounded(state.process.kill({ forceKillAfter: 3_000 }), KILL_TIMEOUT_MS)
            if (killed === "timeout") record("kill", "Adaptive agent process-group kill timed out", true)
            else if (Exit.isFailure(killed)) record("kill", "Adaptive agent process-group kill failed", true)
            else {
              const running = yield* bounded(state.process.isRunning, EXIT_TIMEOUT_MS)
              if (running !== "timeout" && Exit.isSuccess(running) && !running.value) terminationConfirmed = true
            }
          }
          yield* Queue.shutdown(state.input).pipe(Effect.exit)

          if (terminal.knownCode === undefined) {
            const observed = yield* bounded(state.process.exitCode.pipe(Effect.map(Number)), EXIT_TIMEOUT_MS)
            if (observed === "timeout") {
              if (!terminationConfirmed) record("exit", "Adaptive agent exit code did not settle", true)
            } else if (Exit.isFailure(observed)) {
              if (!terminationConfirmed) record("exit", "Adaptive agent exit observation failed", true)
            } else {
              code = observed.value
              terminationConfirmed = true
            }
          }

          const registrations = Array.from(state.rpc.values())
          registrations.forEach((registration) => {
            registration.cancelled = true
          })
          const interrupted = yield* bounded(
            Effect.forEach(
              registrations,
              (registration) => (registration.fiber ? Fiber.interrupt(registration.fiber) : Effect.void),
              { discard: true },
            ),
            RPC_INTERRUPT_TIMEOUT_MS,
          )
          if (interrupted === "timeout") record("rpc", "Adaptive agent RPC interruption timed out", true)
          else if (Exit.isFailure(interrupted)) record("rpc", "Adaptive agent RPC interruption failed", true)
          else state.rpc.clear()

          const stderr = yield* bounded(Deferred.await(state.stderrDone), STDERR_SETTLE_TIMEOUT_MS)
          if (stderr === "timeout" || Exit.isFailure(stderr)) {
            if (state.stderrFiber)
              yield* Fiber.interrupt(state.stderrFiber).pipe(Effect.forkDetach({ startImmediately: true }))
            yield* Effect.sync(() => finalizeStderr(state))
          }

          if (state.claimed) {
            let persisted = false
            for (let attempt = 0; attempt <= SETTLE_RETRIES; attempt += 1) {
              const result = yield* bounded(
                uncertain
                  ? store.quarantineAgent({
                      agentID: state.identity.agentID,
                      generation: state.identity.generation,
                      owner: state.owner,
                      exitCode: code,
                      exitReason: problem?.reason ?? "Adaptive agent cleanup is uncertain",
                    })
                  : store.settleAgent({
                      agentID: state.identity.agentID,
                      generation: state.identity.generation,
                      owner: state.owner,
                      state: terminal.state,
                      exitCode: code,
                      exitReason: terminal.reason,
                    }),
                SETTLE_TIMEOUT_MS,
              )
              if (result === "timeout" || Exit.isFailure(result)) continue
              persisted = true
              break
            }
            if (!persisted)
              record(
                "settle",
                uncertain ? "Adaptive agent durable quarantine failed" : "Adaptive agent durable settlement failed",
              )
          }

          return { code, problem, uncertain }
        }).pipe(
          Effect.catchCause(() =>
            Effect.succeed({
              code,
              uncertain: true,
              problem:
                problem ??
                new TerminationError({
                  stage: "cleanup",
                  reason: "Adaptive agent terminal cleanup failed",
                  exitCode: code,
                }),
            }),
          ),
        )
        const result = yield* cleanup
        if (result.uncertain) active.set(state.identity.agentID, state)
        yield* shutdown(state, !result.uncertain)
        yield* Effect.sync(() => {
          Deferred.doneUnsafe(state.exited, result.problem ? Effect.fail(result.problem) : Effect.succeed(result.code))
          Deferred.doneUnsafe(state.finished, result.problem ? Effect.fail(result.problem) : Effect.void)
        })
        if (result.problem) return yield* result.problem
      }),
    )
  })

  const route = (
    state: Active,
    input: StartInput,
    frame: Extract<AgentProcessProtocol.ChildToController, { type: "rpc.request" }>,
    key: string,
    registration: RpcRegistration,
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
      Effect.ensuring(
        Effect.sync(() => {
          if (state.rpc.get(key) === registration) state.rpc.delete(key)
        }),
      ),
    )

  const runFrames = (state: Active, input: StartInput) =>
    Effect.gen(function* () {
      while (!state.finishStarted) {
        const envelope = yield* Queue.take(state.frames)
        if (state.finishStarted) return
        if (envelope.type === "end") return
        if (envelope.type === "error")
          return yield* finish(state, { state: "failed", reason: envelope.reason, kill: true })
        const frame = envelope.frame
        if (frame.type === "hello" || frame.type === "ready")
          return yield* finish(state, {
            state: "failed",
            reason: `Adaptive agent sent unexpected ${frame.type} after readiness`,
            kill: true,
          })
        if (frame.type === "heartbeat") {
          const now = yield* Clock.currentTimeMillis
          if (state.lastHeartbeatAt !== undefined && now - state.lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) continue
          const heartbeat = yield* store
            .heartbeat({
              agentID: state.identity.agentID,
              generation: state.identity.generation,
              owner: state.owner,
              leaseDurationMs: LEASE_DURATION_MS,
            })
            .pipe(Effect.option)
          if (Option.isNone(heartbeat))
            return yield* finish(state, {
              state: "lost",
              reason: "Adaptive agent heartbeat ownership was rejected",
              kill: true,
            })
          state.lastHeartbeatAt = now
          yield* Queue.offer(state.heartbeats, undefined)
          yield* PubSub.publish(state.events, frame)
          continue
        }
        if (frame.type === "rpc.cancel") {
          yield* PubSub.publish(state.events, frame)
          const registration = state.rpc.get(`child:${frame.requestID}`)
          if (!registration) continue
          registration.cancelled = true
          if (registration.fiber) yield* Fiber.interrupt(registration.fiber)
          continue
        }
        const key = `child:${frame.id}`
        if (state.rpc.has(key))
          return yield* finish(state, {
            state: "failed",
            reason: `Adaptive agent RPC protocol violation: duplicate request id ${frame.id}`,
            kill: true,
          })
        if (state.usedChildRPC.has(frame.id))
          return yield* finish(state, {
            state: "failed",
            reason: `Adaptive agent RPC protocol violation: reused request id ${frame.id}`,
            kill: true,
          })
        if (state.usedChildRPC.size >= AgentProcessProtocol.MAX_RPC_REQUEST_IDS_PER_GENERATION)
          return yield* finish(state, {
            state: "failed",
            reason: `Adaptive agent RPC protocol violation: more than ${AgentProcessProtocol.MAX_RPC_REQUEST_IDS_PER_GENERATION} request ids in one generation`,
            kill: true,
          })
        const outstanding = Array.from(state.rpc.values()).filter(
          (registration) => registration.origin === "child",
        ).length
        if (outstanding >= AgentProcessProtocol.MAX_OUTSTANDING_RPC_CALLS)
          return yield* finish(state, {
            state: "failed",
            reason: `Adaptive agent RPC protocol violation: more than ${AgentProcessProtocol.MAX_OUTSTANDING_RPC_CALLS} outstanding requests`,
            kill: true,
          })
        state.usedChildRPC.add(frame.id)
        const registration: RpcRegistration = { origin: "child", cancelled: false }
        state.rpc.set(key, registration)
        yield* PubSub.publish(state.events, frame)
        const fiber = yield* route(state, input, frame, key, registration).pipe(
          Effect.forkDetach({ startImmediately: false }),
        )
        registration.fiber = fiber
        if (registration.cancelled)
          yield* Fiber.interrupt(fiber).pipe(Effect.forkDetach({ startImmediately: true }), Effect.asVoid)
      }
    }).pipe(
      Effect.catchCause(() =>
        state.finishStarted
          ? Effect.void
          : finish(state, { state: "failed", reason: "Adaptive agent frame loop failed", kill: true }).pipe(
              Effect.ignore,
            ),
      ),
      Effect.asVoid,
    )

  const watchLease = (state: Active, ready: Deferred.Deferred<void>) =>
    Effect.gen(function* () {
      let armed = false
      while (!state.finishStarted) {
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
        if (next === "expired")
          return yield* finish(state, {
            state: "lost",
            reason: "Adaptive agent heartbeat lease expired",
            kill: true,
          })
      }
    }).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.asVoid,
    )

  const request = (state: Active, input: StartInput, method: Method, payload: AgentProcessProtocol.JsonValue) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const key = `handle:${crypto.randomUUID()}`
        const result = yield* Deferred.make<AgentProcessProtocol.JsonValue, RpcError>()
        const registration = yield* Effect.sync(() => {
          if (state.finishStarted || active.get(state.identity.agentID) !== state) return undefined
          const value: RpcRegistration = { origin: "handle", cancelled: false }
          state.rpc.set(key, value)
          return value
        })
        if (!registration)
          return yield* new RpcError({
            code: "PROCESS_EXITED",
            message: "Adaptive agent process is no longer active",
          })
        const fiber = yield* input.router(method, payload, state.identity).pipe(
          Effect.flatMap((routed) =>
            Stream.isStream(routed)
              ? Stream.runCollect(routed).pipe(Effect.map((values) => Array.from(values)))
              : Effect.succeed(routed),
          ),
          Effect.interruptible,
          Effect.onExit((exit) => {
            if (Exit.isSuccess(exit)) return Deferred.succeed(result, exit.value).pipe(Effect.asVoid)
            const error = Cause.squash(exit.cause)
            return Deferred.fail(
              result,
              error instanceof RpcError
                ? error
                : new RpcError({
                    code: state.finishStarted ? "PROCESS_EXITED" : "ROUTER_FAILED",
                    message: state.finishStarted
                      ? "Adaptive agent process terminated during the request"
                      : "Adaptive agent request router failed",
                  }),
            ).pipe(Effect.asVoid)
          }),
          Effect.asVoid,
          Effect.ensuring(
            Effect.sync(() => {
              if (state.rpc.get(key) === registration) state.rpc.delete(key)
            }),
          ),
          Effect.forkDetach({ startImmediately: false }),
        )
        registration.fiber = fiber
        if (registration.cancelled) yield* Fiber.interrupt(fiber)
        return yield* restore(Deferred.await(result)).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              registration.cancelled = true
            }).pipe(
              Effect.andThen(
                registration.fiber
                  ? Fiber.interrupt(registration.fiber).pipe(
                      Effect.forkDetach({ startImmediately: true }),
                      Effect.asVoid,
                    )
                  : Effect.void,
              ),
            ),
          ),
        )
      }),
    )

  const start = Effect.fn("AdaptiveProcessSupervisor.start")(function* (input: StartInput) {
    const scope = yield* Scope.Scope
    const existing = active.get(input.agentID)
    if (existing) return yield* new StartError({ reason: "Adaptive agent is already active", exitCode: 64 })

    const record = yield* store
      .getAgent(input.agentID)
      .pipe(Effect.mapError(() => new StartError({ reason: "Adaptive agent was not found", exitCode: 64 })))
    if (
      record.state === "failed" &&
      record.owner !== undefined &&
      record.pid !== undefined &&
      record.leaseExpiresAt === undefined
    )
      return yield* new StartError({ reason: "Adaptive agent cleanup is quarantined", exitCode: 70 })
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
    const inputQueue = yield* Queue.bounded<Uint8Array | null>(INPUT_QUEUE_CAPACITY)
    const frames = yield* Queue.bounded<Envelope>(FRAME_QUEUE_CAPACITY)
    const heartbeats = yield* Queue.dropping<void>(1)
    const events = yield* PubSub.unbounded<AgentProcessProtocol.ChildToController>()
    const exited = yield* Deferred.make<number, TerminationError>()
    const finished = yield* Deferred.make<void, TerminationError>()
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
      finished,
      stderrDone,
      rpc: new Map(),
      usedChildRPC: new Set(),
      preview: { text: "", bytes: 0, decoder: new TextDecoder(), finalized: false },
      claimed: false,
      finishStarted: false,
    }
    active.set(identity.agentID, state)

    return yield* Effect.gen(function* () {
      yield* Stream.run(
        Stream.fromQueue(inputQueue).pipe(Stream.takeWhile((chunk): chunk is Uint8Array => chunk !== null)),
        process.stdin,
      ).pipe(Effect.ignore, Effect.forkIn(scope))
      yield* readFrames(state).pipe(Effect.forkIn(scope, { startImmediately: true }))
      state.stderrFiber = yield* readStderr(state).pipe(Effect.forkIn(scope, { startImmediately: true }))

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
      state.claimed = true

      if (input.prepare) {
        yield* input
          .prepare({ ...identity, owner: state.owner, pid: Number(process.pid) })
          .pipe(
            Effect.mapError(
              () => new StartError({ reason: "Adaptive agent generation preparation failed", exitCode: 70 }),
            ),
          )
      }

      yield* send(state, {
        v: AgentProcessProtocol.VERSION,
        id: crypto.randomUUID(),
        type: "accepted",
        heartbeatMs: HEARTBEAT_MS,
      })
      const ready = yield* takeHandshake(state, "ready")
      if (ready.type !== "ready")
        return yield* new StartError({ reason: "Adaptive agent did not become ready", exitCode: 64 })

      yield* store
        .heartbeat({
          agentID: identity.agentID,
          generation: identity.generation,
          owner: state.owner,
          leaseDurationMs: LEASE_DURATION_MS,
        })
        .pipe(
          Effect.mapError(() => new StartError({ reason: "Adaptive agent ready lease renewal failed", exitCode: 64 })),
        )

      yield* PubSub.publish(state.events, ready)
      yield* runFrames(state, input).pipe(Effect.forkIn(scope, { startImmediately: true }))
      const leaseReady = yield* Deferred.make<void>()
      yield* watchLease(state, leaseReady).pipe(Effect.forkIn(scope, { startImmediately: true }))
      yield* Deferred.await(leaseReady)
      yield* process.exitCode.pipe(
        Effect.map((code) => ({ code: Number(code), signaled: false })),
        Effect.catch(() => Effect.succeed({ code: 128, signaled: true })),
        Effect.flatMap(({ code, signaled }) =>
          finish(state, {
            state: code === 0 ? "stopped" : "failed",
            reason: signaled
              ? "Adaptive agent exited after receiving a signal"
              : code === 0
                ? "Adaptive agent exited normally (code 0)"
                : `Adaptive agent exited with code ${code}`,
            kill: false,
            knownCode: code,
          }),
        ),
        Effect.ignore,
        Effect.forkIn(scope, { startImmediately: true }),
      )
      yield* Effect.addFinalizer(() =>
        (state.finishStarted
          ? Deferred.await(state.finished)
          : finish(state, {
              state: "lost",
              reason: "Adaptive agent supervisor scope closed",
              kill: true,
            })
        ).pipe(Effect.tapError(Effect.logError), Effect.ignore),
      )

      return {
        agentID: identity.agentID,
        generation: identity.generation,
        owner: state.owner,
        pid: Number(process.pid),
        request: (method: Method, payload: AgentProcessProtocol.JsonValue) => request(state, input, method, payload),
        events: Stream.fromPubSub(state.events),
        exited: Deferred.await(state.exited),
        stderrPreview: Deferred.await(state.stderrDone).pipe(Effect.map(() => state.preview.text)),
      }
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? finish(state, { state: "failed", reason: "Adaptive agent startup failed", kill: true }).pipe(Effect.ignore)
          : Effect.void,
      ),
    )
  })

  const stop = Effect.fn("AdaptiveProcessSupervisor.stop")(function* (input: StopInput) {
    const state = active.get(input.agentID)
    if (!state || (input.generation !== undefined && input.generation !== state.identity.generation)) return
    yield* sendBestEffort(state, {
      v: AgentProcessProtocol.VERSION,
      id: crypto.randomUUID(),
      type: "shutdown",
      reason: "Adaptive agent stopped by Controller",
    }).pipe(Effect.ignore)
    yield* finish(state, {
      state: "stopped",
      reason: "Adaptive agent stopped by Controller",
      kill: true,
    })
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
        if (decoded === undefined)
          return Queue.offer(state.frames, {
            type: "error",
            reason: "Adaptive agent stdout protocol decode failed",
          }).pipe(Effect.asVoid)
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
        Effect.flatMap((type) =>
          type === "end"
            ? Queue.offer(state.frames, { type })
            : Queue.offer(state.frames, {
                type,
                reason: "Adaptive agent stdout ended with an incomplete protocol frame",
              }),
        ),
        Effect.asVoid,
      ),
    ),
    Effect.catchCause(() =>
      Queue.offer(state.frames, {
        type: "error",
        reason: "Adaptive agent stdout transport failed",
      }).pipe(Effect.asVoid),
    ),
    Effect.asVoid,
  )
}

function readStderr(state: Active) {
  return Stream.runForEach(state.process.stderr, (chunk) =>
    Effect.sync(() => {
      if (state.preview.finalized || state.preview.bytes >= STDERR_PREVIEW_BYTES) return
      const slice = chunk.subarray(0, STDERR_PREVIEW_BYTES - state.preview.bytes)
      state.preview.bytes += slice.byteLength
      state.preview.text += state.preview.decoder.decode(slice, { stream: true })
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => finalizeStderr(state))), Effect.ignore)
}

function finalizeStderr(state: Active) {
  if (state.preview.finalized) return
  state.preview.finalized = true
  const tail = state.preview.bytes < STDERR_PREVIEW_BYTES ? state.preview.decoder.decode() : ""
  state.preview.text = limitPreviewBytes(sanitizePreview(state.preview.text + tail))
  Deferred.doneUnsafe(state.stderrDone, Effect.void)
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

function limitPreviewBytes(input: string) {
  const encoded = new TextEncoder().encode(input)
  if (encoded.byteLength <= STDERR_PREVIEW_BYTES) return input
  return new TextDecoder().decode(encoded.subarray(0, STDERR_PREVIEW_BYTES), { stream: true })
}

const layer = Layer.effect(Service, make())
export const node = makeGlobalNode({ service: Service, layer, deps: [AdaptiveStore.node, CrossSpawnSpawner.node] })

export * as AdaptiveProcessSupervisor from "./supervisor"
