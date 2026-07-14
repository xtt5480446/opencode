export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key, seq?: number) => Effect.Effect<void>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key, seq?: number) => Effect.Effect<void>
}

type Wake = { readonly seq?: number }

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  currentWakeSeq?: number
  owner?: Fiber.Fiber<void, never>
  pendingWake?: Wake
  interruptSeq?: number
  stopping: boolean
}

const coalesceWake = (left: Wake | undefined, seq: number | undefined): Wake => {
  if (left === undefined) return { seq }
  if (left.seq === undefined || seq === undefined) return {}
  return { seq: Math.max(left.seq, seq) }
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const interruptSeq = new Map<Key, number>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (currentWakeSeq?: number): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      currentWakeSeq,
      stopping: false,
    })

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(Effect.suspend(() => options.drain(key, force))),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) => {
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake !== undefined) {
        const pending = entry.pendingWake
        entry.pendingWake = undefined
        entry.currentWakeSeq = pending.seq
        start(key, entry, false, true)
        return
      }

      const successor = entry.pendingWake === undefined ? undefined : makeEntry(entry.pendingWake.seq)
      if (successor === undefined) active.delete(key)
      else {
        active.set(key, successor)
        start(key, successor, false, true)
      }
      Deferred.doneUnsafe(entry.done, exit)
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        active.set(key, next)
        start(key, next, true)
        return restore(Deferred.await(next.done))
      })

    const wake = (key: Key, seq?: number) =>
      Effect.sync(() => {
        const latest = interruptSeq.get(key)
        if (latest !== undefined && (seq === undefined || seq <= latest)) return
        const entry = active.get(key)
        if (entry !== undefined) {
          if (entry.stopping && entry.interruptSeq !== undefined && (seq === undefined || seq <= entry.interruptSeq))
            return
          entry.pendingWake = coalesceWake(entry.pendingWake, seq)
          return
        }

        const next = makeEntry(seq)
        active.set(key, next)
        start(key, next, false)
      })

    const interrupt = (key: Key, seq?: number): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (seq !== undefined) interruptSeq.set(key, Math.max(interruptSeq.get(key) ?? seq, seq))
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        if (seq !== undefined && entry.currentWakeSeq !== undefined && entry.currentWakeSeq > seq) return Effect.void
        entry.stopping = true
        entry.interruptSeq = seq
        if (seq === undefined || entry.pendingWake?.seq === undefined || entry.pendingWake.seq <= seq)
          entry.pendingWake = undefined
        return Fiber.interrupt(entry.owner)
      })

    return { active: Effect.sync(() => new Set(active.keys())), run, wake, interrupt }
  })
