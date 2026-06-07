export * as SessionRunCoordinator from "./run-coordinator"

import {
  Cause,
  Context,
  Data,
  Deferred,
  Effect,
  Equal,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Scope,
  SynchronizedRef,
} from "effect"
import { SessionRunner } from "./runner"
import { SessionSchema } from "./schema"

export type Mode = "run" | "wake"

export interface Coordinator<Key, A, E> {
  readonly run: (key: Key) => Effect.Effect<A, E>
  readonly wake: (key: Key, seq?: number) => Effect.Effect<void>
  readonly awaitIdle: (key: Key) => Effect.Effect<void, E>
  readonly interrupt: (key: Key, seq?: number) => Effect.Effect<void>
}

/** @internal */
export class Demand extends Data.Class<{
  readonly explicit: boolean
  readonly wakeSeq?: number
  readonly unsequencedWake: boolean
}> {
  static readonly empty = new Demand({ explicit: false, wakeSeq: undefined, unsequencedWake: false })
  static readonly run = nonEmpty(new Demand({ explicit: true, wakeSeq: undefined, unsequencedWake: false }))

  static wake(seq?: number) {
    return nonEmpty(new Demand({ explicit: false, wakeSeq: seq, unsequencedWake: seq === undefined }))
  }

  combine(other: Demand) {
    return new Demand({
      explicit: this.explicit || other.explicit,
      wakeSeq:
        this.wakeSeq === undefined
          ? other.wakeSeq
          : other.wakeSeq === undefined
            ? this.wakeSeq
            : Math.max(this.wakeSeq, other.wakeSeq),
      unsequencedWake: this.unsequencedWake || other.unsequencedWake,
    })
  }

  afterBoundary(boundary?: number) {
    return new Demand({
      explicit: false,
      wakeSeq:
        boundary !== undefined && this.wakeSeq !== undefined && this.wakeSeq > boundary ? this.wakeSeq : undefined,
      unsequencedWake: false,
    })
  }

  isNonEmpty(): this is NonEmptyDemand {
    return this.explicit || this.wakeSeq !== undefined || this.unsequencedWake
  }

  get mode(): Mode {
    return this.explicit ? "run" : "wake"
  }
}

type NonEmptyDemand = Demand &
  ({ readonly explicit: true } | { readonly wakeSeq: number } | { readonly unsequencedWake: true })

function nonEmpty(demand: Demand): NonEmptyDemand {
  if (!demand.isNonEmpty()) throw new Error("Session run demand must not be empty")
  return demand
}

type Lifecycle =
  | { readonly _tag: "Running"; readonly token: object; readonly owner: Deferred.Deferred<Fiber.Fiber<void>> }
  | {
      readonly _tag: "Stopping"
      readonly token: object
      readonly owner: Deferred.Deferred<Fiber.Fiber<void>>
      readonly boundary?: number
    }

type Lane<A, E> = {
  readonly current: NonEmptyDemand
  readonly pending: Demand
  readonly lifecycle: Lifecycle
  readonly terminal: Deferred.Deferred<Exit.Exit<A, E>>
  readonly waiter?: Deferred.Deferred<Exit.Exit<A, E>>
}

type State<Key, A, E> = {
  readonly closed: boolean
  readonly lanes: ReadonlyMap<Key, Lane<A, E>>
  readonly interruptSeq: ReadonlyMap<Key, number>
}

type Start<Key, A, E> = {
  readonly key: Key
  readonly demand: NonEmptyDemand
  readonly successor: boolean
  readonly token: object
  readonly owner: Deferred.Deferred<Fiber.Fiber<void>>
  readonly ready: Deferred.Deferred<void>
  readonly terminal: Deferred.Deferred<Exit.Exit<A, E>>
}

type RunRequest<Key, A, E> =
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Await"; readonly terminal: Deferred.Deferred<Exit.Exit<A, E>> }
  | { readonly _tag: "Retry"; readonly terminal: Deferred.Deferred<Exit.Exit<A, E>> }
  | { readonly _tag: "Start"; readonly start: Start<Key, A, E>; readonly terminal: Deferred.Deferred<Exit.Exit<A, E>> }

type Completion<Key, A, E> = {
  readonly start?: Start<Key, A, E>
  readonly terminal?: Deferred.Deferred<Exit.Exit<A, E>>
  readonly waiter?: Deferred.Deferred<Exit.Exit<A, E>>
  readonly report?: Cause.Cause<E>
}

export const make = <Key, A, E>(options: {
  readonly drain: (key: Key, mode: Mode) => Effect.Effect<A, E>
  readonly onFailure?: (key: Key, cause: Cause.Cause<E>) => Effect.Effect<void>
}): Effect.Effect<Coordinator<Key, A, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<State<Key, A, E>>({
      closed: false,
      lanes: new Map(),
      interruptSeq: new Map(),
    })
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    const shutdown = Deferred.makeUnsafe<void>()

    const updateLane = (current: State<Key, A, E>, key: Key, lane?: Lane<A, E>): State<Key, A, E> => {
      const lanes = new Map(current.lanes)
      if (lane === undefined) lanes.delete(key)
      else lanes.set(key, lane)
      return { ...current, lanes }
    }

    const start = (input: {
      readonly state: State<Key, A, E>
      readonly key: Key
      readonly demand: NonEmptyDemand
      readonly terminal?: Deferred.Deferred<Exit.Exit<A, E>>
      readonly waiter?: Deferred.Deferred<Exit.Exit<A, E>>
      readonly successor?: boolean
    }) => {
      const instruction: Start<Key, A, E> = {
        key: input.key,
        demand: input.demand,
        successor: input.successor ?? false,
        token: {},
        owner: Deferred.makeUnsafe<Fiber.Fiber<void>>(),
        ready: Deferred.makeUnsafe<void>(),
        terminal: input.terminal ?? Deferred.makeUnsafe<Exit.Exit<A, E>>(),
      }
      return {
        state: updateLane(input.state, input.key, {
          current: input.demand,
          pending: Demand.empty,
          lifecycle: { _tag: "Running", token: instruction.token, owner: instruction.owner },
          terminal: instruction.terminal,
          waiter: input.waiter,
        }),
        start: instruction,
        result: instruction.terminal,
      }
    }

    const launch = (instruction: Start<Key, A, E>) =>
      Effect.gen(function* () {
        const fiber = fork(
          Deferred.await(instruction.ready).pipe(
            Effect.andThen(instruction.successor ? Effect.yieldNow : Effect.void),
            Effect.andThen(Effect.suspend(() => options.drain(instruction.key, instruction.demand.mode))),
            Effect.onExit((exit) => complete(instruction.key, instruction.token, exit)),
            Effect.exit,
            Effect.asVoid,
          ),
        )
        yield* Deferred.succeed(instruction.owner, fiber)
        yield* Deferred.succeed(instruction.ready, undefined)
      })

    const complete = (key: Key, token: object, exit: Exit.Exit<A, E>): Effect.Effect<void> => {
      return SynchronizedRef.modify(state, (current): readonly [Completion<Key, A, E>, State<Key, A, E>] => {
        const lane = current.lanes.get(key)
        if (lane === undefined || lane.lifecycle.token !== token) return [{}, current]

        const deliberateInterrupt =
          lane.lifecycle._tag === "Stopping" && exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)
        const report =
          exit._tag === "Failure" && !deliberateInterrupt && !lane.current.explicit ? exit.cause : undefined
        const completesWaiter = lane.current.explicit || (lane.lifecycle._tag === "Stopping" && !lane.current.explicit)
        const waiter = completesWaiter ? undefined : lane.waiter

        if (exit._tag === "Success" && lane.lifecycle._tag === "Running" && lane.pending.isNonEmpty()) {
          const next = start({
            state: current,
            key,
            demand: lane.pending,
            terminal: lane.terminal,
            waiter,
            successor: true,
          })
          return [{ start: next.start, waiter: completesWaiter ? lane.waiter : undefined, report }, next.state]
        }

        const next = lane.pending.isNonEmpty()
          ? start({ state: current, key, demand: lane.pending, waiter, successor: true })
          : { state: updateLane(current, key) }
        return [
          {
            start: "start" in next ? next.start : undefined,
            terminal: lane.terminal,
            waiter: completesWaiter ? lane.waiter : undefined,
            report,
          },
          next.state,
        ]
      }).pipe(Effect.flatMap((instruction) => executeCompletion(key, exit, instruction)))
    }

    const executeCompletion = (key: Key, exit: Exit.Exit<A, E>, instruction: Completion<Key, A, E>) =>
      Effect.gen(function* () {
        if (instruction.start !== undefined) yield* launch(instruction.start)
        if (instruction.waiter !== undefined) yield* Deferred.succeed(instruction.waiter, exit)
        if (instruction.terminal !== undefined) yield* Deferred.succeed(instruction.terminal, exit)
        if (instruction.report !== undefined && options.onFailure !== undefined) {
          const onFailure = options.onFailure
          const cause = instruction.report
          fork(Effect.suspend(() => onFailure(key, cause)).pipe(Effect.exit, Effect.asVoid))
        }
      })

    const awaitTerminal = (terminal: Deferred.Deferred<Exit.Exit<A, E>>) =>
      Effect.raceFirst(
        Deferred.await(terminal).pipe(
          Effect.flatMap(
            Exit.match({
              onSuccess: Effect.succeed,
              onFailure: Effect.failCause,
            }),
          ),
        ),
        Deferred.await(shutdown).pipe(Effect.andThen(Effect.interrupt)),
      )

    const run = (key: Key): Effect.Effect<A, E> =>
      Effect.suspend(() =>
        Effect.uninterruptibleMask((restore) => {
          return SynchronizedRef.modify(state, (current): readonly [RunRequest<Key, A, E>, State<Key, A, E>] => {
            if (current.closed) return [{ _tag: "Closed" }, current]
            const lane = current.lanes.get(key)
            if (lane?.lifecycle._tag === "Stopping") return [{ _tag: "Retry", terminal: lane.terminal }, current]
            if (lane?.current.explicit) return [{ _tag: "Await", terminal: lane.terminal }, current]
            if (lane !== undefined) {
              const terminal = lane.waiter ?? Deferred.makeUnsafe<Exit.Exit<A, E>>()
              const pending = lane.pending.combine(Demand.run)
              if (Equal.equals(pending, lane.pending) && lane.waiter !== undefined)
                return [{ _tag: "Await", terminal }, current]
              return [{ _tag: "Await", terminal }, updateLane(current, key, { ...lane, pending, waiter: terminal })]
            }
            const next = start({ state: current, key, demand: Demand.run })
            return [{ _tag: "Start", start: next.start, terminal: next.result }, next.state]
          }).pipe(
            Effect.flatMap((request) => {
              if (request._tag === "Closed") return Effect.interrupt
              if (request._tag === "Start")
                return launch(request.start).pipe(Effect.andThen(awaitTerminal(request.terminal)))
              if (request._tag === "Await") return awaitTerminal(request.terminal)
              return Effect.raceFirst(
                Deferred.await(request.terminal).pipe(Effect.as(true)),
                Deferred.await(shutdown).pipe(Effect.as(false)),
              ).pipe(Effect.flatMap((retry) => (retry ? run(key) : Effect.interrupt)))
            }),
            restore,
          )
        }),
      )

    const wake = (key: Key, seq?: number) =>
      Effect.uninterruptible(
        Effect.suspend(() => {
          return SynchronizedRef.modify(state, (current): readonly [Start<Key, A, E> | undefined, State<Key, A, E>] => {
            if (current.closed) return [undefined, current]
            const boundary = current.interruptSeq.get(key)
            if (boundary !== undefined && (seq === undefined || seq <= boundary)) return [undefined, current]
            const lane = current.lanes.get(key)
            if (lane === undefined) {
              const next = start({ state: current, key, demand: Demand.wake(seq) })
              return [next.start, next.state]
            }
            if (
              lane.lifecycle._tag === "Stopping" &&
              (lane.lifecycle.boundary === undefined || seq === undefined || seq <= lane.lifecycle.boundary)
            )
              return [undefined, current]
            const pending = lane.pending.combine(Demand.wake(seq))
            if (Equal.equals(pending, lane.pending)) return [undefined, current]
            return [undefined, updateLane(current, key, { ...lane, pending })]
          }).pipe(Effect.flatMap((instruction) => (instruction === undefined ? Effect.void : launch(instruction))))
        }),
      )

    const interrupt = (key: Key, seq?: number) =>
      Effect.uninterruptible(
        SynchronizedRef.modify(state, (current) => {
          if (current.closed) return [undefined, current] as const
          const latest = current.interruptSeq.get(key)
          const lane = current.lanes.get(key)
          if (seq !== undefined && latest !== undefined && seq <= latest)
            return [lane?.lifecycle._tag === "Stopping" ? lane.lifecycle.owner : undefined, current] as const

          const bounded = (() => {
            if (seq === undefined) return current
            const interruptSeq = new Map(current.interruptSeq)
            interruptSeq.set(key, seq)
            return { ...current, interruptSeq }
          })()
          if (lane === undefined) return [undefined, bounded] as const
          if (
            !lane.current.explicit &&
            seq !== undefined &&
            lane.current.wakeSeq !== undefined &&
            lane.current.wakeSeq > seq
          )
            return [undefined, bounded] as const

          const pending = lane.current.afterBoundary(seq).combine(lane.pending.afterBoundary(seq))
          const boundary =
            lane.lifecycle._tag === "Stopping" && lane.lifecycle.boundary !== undefined && seq !== undefined
              ? Math.max(lane.lifecycle.boundary, seq)
              : lane.lifecycle._tag === "Stopping" && seq === undefined
                ? lane.lifecycle.boundary
                : seq
          return [
            lane.lifecycle.owner,
            updateLane(bounded, key, {
              ...lane,
              pending,
              lifecycle: { _tag: "Stopping", token: lane.lifecycle.token, owner: lane.lifecycle.owner, boundary },
            }),
          ] as const
        }).pipe(
          Effect.flatMap((owner) =>
            owner === undefined ? Effect.void : Deferred.await(owner).pipe(Effect.flatMap(Fiber.interrupt)),
          ),
        ),
      )

    const awaitIdle = (key: Key): Effect.Effect<void, E> =>
      Effect.gen(function* () {
        let failure: Cause.Cause<E> | undefined
        while (true) {
          const terminal = (yield* SynchronizedRef.get(state)).lanes.get(key)?.terminal
          if (terminal === undefined) break
          const exit = yield* Effect.raceFirst(
            Deferred.await(terminal),
            Deferred.await(shutdown).pipe(Effect.as(Exit.void)),
          )
          if (exit._tag === "Failure" && failure === undefined) failure = exit.cause
        }
        if (failure !== undefined) return yield* Effect.failCause(failure)
      })

    yield* Effect.addFinalizer(() =>
      SynchronizedRef.modify(state, (_current) => [
        undefined,
        { closed: true, lanes: new Map(), interruptSeq: new Map() } satisfies State<Key, A, E>,
      ]).pipe(Effect.andThen(Deferred.succeed(shutdown, undefined))),
    )

    return { run, wake, interrupt, awaitIdle }
  })

export interface Interface extends Coordinator<SessionSchema.ID, void, SessionRunner.RunError> {}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionRunCoordinator") {}

export const layer = Layer.effect(
  Service,
  SessionRunner.Service.pipe(
    Effect.flatMap((runner) =>
      make<SessionSchema.ID, void, SessionRunner.RunError>({
        drain: (sessionID, mode) => runner.run({ sessionID, force: mode === "run" }),
        onFailure: (sessionID, cause) =>
          Effect.logError("Failed to drain Session").pipe(
            Effect.annotateLogs("sessionID", sessionID),
            Effect.annotateLogs("cause", cause),
          ),
      }),
    ),
    Effect.map(Service.of),
  ),
)
