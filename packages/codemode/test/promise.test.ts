import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool, toolError } from "../src/index.js"

// Wave 5 acceptance suite: first-class promise values. Un-awaited tool calls start eagerly on
// supervised fibers, `await` settles them, and Promise.all/allSettled/race/resolve/reject are
// ordinary functions over arbitrary arrays mixing promises and plain values.

type Trace = {
  starts: Array<number>
  active: number
  maxActive: number
  completed: number
  interrupted: number
}

const makeTrace = (): Trace => ({ starts: [], active: 0, maxActive: 0, completed: 0, interrupted: 0 })

/** Echoes `id` after `ms` milliseconds, recording start order, live concurrency, and interruption. */
const sleepyTool = (trace: Trace) =>
  Tool.make({
    description: "Echo an id after a delay",
    input: Schema.Struct({ id: Schema.Number, ms: Schema.optionalKey(Schema.Number) }),
    output: Schema.Number,
    run: ({ id, ms }) =>
      Effect.gen(function* () {
        trace.starts.push(id)
        trace.active += 1
        trace.maxActive = Math.max(trace.maxActive, trace.active)
        yield* Effect.sleep(ms ?? 20)
        trace.active -= 1
        trace.completed += 1
        return id
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            trace.active -= 1
            trace.interrupted += 1
          }),
        ),
      ),
  })

const failingTool = Tool.make({
  description: "Always refuse",
  input: Schema.Struct({}),
  output: Schema.String,
  run: () => Effect.fail(toolError("Lookup refused")),
})

const completedTool = (trace: Trace) =>
  Tool.make({
    description: "Return the number of completed sleepy calls",
    input: Schema.Struct({}),
    output: Schema.Number,
    run: () => Effect.succeed(trace.completed),
  })

const run = (
  code: string,
  options: { trace?: Trace; limits?: CodeMode.ExecutionLimits } = {},
): Promise<CodeMode.Result> => {
  const trace = options.trace ?? makeTrace()
  return Effect.runPromise(
    CodeMode.execute({
      tools: { host: { sleepy: sleepyTool(trace), fail: failingTool, completed: completedTool(trace) } },
      code,
      ...(options.limits ? { limits: options.limits } : {}),
    }),
  )
}

const value = async (code: string, options: { trace?: Trace; limits?: CodeMode.ExecutionLimits } = {}) => {
  const result = await run(code, options)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const error = async (code: string, options: { trace?: Trace; limits?: CodeMode.ExecutionLimits } = {}) => {
  const result = await run(code, options)
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}

describe("first-class promise values", () => {
  test("async functions return promises with isolated concurrent invocations", async () => {
    expect(
      await value(`
        const load = async (id) => {
          const result = await tools.host.sleepy({ id, ms: 20 })
          return [id, result]
        }
        const first = load(1)
        const second = load(2)
        return [first instanceof Promise, second instanceof Promise, await Promise.all([first, second])]
      `),
    ).toEqual([
      true,
      true,
      [
        [1, 1],
        [2, 2],
      ],
    ])
  })

  test("async function errors reject instead of throwing at the call site", async () => {
    expect(
      await value(`
        const fail = async () => { throw new Error("boom") }
        const promise = fail()
        try {
          await promise
          return "no"
        } catch (error) {
          return error.message
        }
      `),
    ).toBe("boom")
  })

  test("an un-awaited tool call starts eagerly, in call order, before any await", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const a = tools.host.sleepy({ id: 1, ms: 40 })
        const b = tools.host.sleepy({ id: 2, ms: 40 })
        const rb = await b
        const ra = await a
        return [ra, rb]
      `,
      { trace },
    )
    expect(result).toEqual([1, 2])
    expect(trace.starts).toEqual([1, 2])
    // Both calls overlapped even though they were awaited sequentially.
    expect(trace.maxActive).toBeGreaterThan(1)
  })

  test("awaiting the same promise twice settles once and never re-runs the call", async () => {
    const result = await run(`
      const p = tools.host.sleepy({ id: 7 })
      const x = await p
      const y = await p
      return [x, y]
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual([7, 7])
    expect(result.toolCalls).toStrictEqual([{ name: "host.sleepy" }])
  })

  test("await of a non-promise value is a passthrough no-op", async () => {
    expect(await value(`return await 42`)).toBe(42)
    expect(await value(`const x = await "s"; return x`)).toBe("s")
    expect(await value(`return await null`)).toBeNull()
    expect(await value(`return (await [1, 2]).length`)).toBe(2)
  })

  test("returning an un-awaited tool call resolves it (async-function return semantics)", async () => {
    expect(await value(`return tools.host.sleepy({ id: 9 })`)).toBe(9)
  })

  test("typeof a promise is 'object', and console.log renders it sensibly", async () => {
    const result = await run(`
      const p = Promise.resolve(1)
      console.log(p)
      return typeof p
    `)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("object")
    expect(result.logs).toStrictEqual(["[Promise (await it to get its value)]"])
  })

  test("an awaited failure is catchable exactly like a synchronous throw", async () => {
    expect(
      await value(`
      const p = tools.host.fail({})
      try {
        await p
        return "no"
      } catch (e) {
        return e.message
      }
    `),
    ).toBe("Lookup refused")
  })

  test("a fire-and-forget call completes before the execution ends", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        tools.host.sleepy({ id: 1, ms: 30 })
        return "done"
      `,
      { trace },
    )
    expect(result).toBe("done")
    expect(trace.completed).toBe(1)
    expect(trace.interrupted).toBe(0)
  })

  test("a never-awaited failing call surfaces as an unhandled-rejection diagnostic", async () => {
    const diagnostic = await error(`
      tools.host.fail({})
      return "done"
    `)
    expect(diagnostic.kind).toBe("ToolFailure")
    expect(diagnostic.message).toContain("Unhandled rejection from an un-awaited promise")
    expect(diagnostic.message).toContain("Lookup refused")
    expect(diagnostic.suggestions?.join(" ")).toContain("Await promises")
  })

  test("an unhandled rejection does not stop later work from draining", async () => {
    const trace = makeTrace()
    const diagnostic = await error(
      `
        tools.host.fail({})
        tools.host.sleepy({ id: 1, ms: 30 })
        return "done"
      `,
      { trace },
    )
    expect(diagnostic.kind).toBe("ToolFailure")
    expect(diagnostic.message).toContain("Unhandled rejection from an un-awaited promise")
    expect(trace.completed).toBe(1)
    expect(trace.interrupted).toBe(0)
  })

  test("a never-awaited failing async function surfaces as an unhandled promise rejection", async () => {
    const diagnostic = await error(`
      const fail = async () => { throw new Error("boom") }
      fail()
      return "done"
    `)
    expect(diagnostic.kind).toBe("ExecutionFailure")
    expect(diagnostic.message).toContain("Unhandled rejection from an un-awaited promise")
    expect(diagnostic.message).toContain("boom")
  })

  test("drains promises started by an async function after an await", async () => {
    const diagnostic = await error(`
      const run = async () => {
        await tools.host.sleepy({ id: 1 })
        tools.host.fail({})
      }
      run()
      return "done"
    `)
    expect(diagnostic.kind).toBe("ToolFailure")
    expect(diagnostic.message).toContain("Lookup refused")
  })

  test("keeps unreturned calls alive after their async function settles", async () => {
    const trace = makeTrace()
    expect(
      await value(
        `
          const start = async () => {
            tools.host.sleepy({ id: 1, ms: 30 })
            return "started"
          }
          await start()
          return "done"
        `,
        { trace },
      ),
    ).toBe("done")
    expect(trace.completed).toBe(1)
    expect(trace.interrupted).toBe(0)
  })

  test("keeps unreturned calls alive after their promise handler settles", async () => {
    const trace = makeTrace()
    expect(
      await value(
        `
          await Promise.resolve().then(() => {
            tools.host.sleepy({ id: 1, ms: 30 })
          })
          return "done"
        `,
        { trace },
      ),
    ).toBe("done")
    expect(trace.completed).toBe(1)
    expect(trace.interrupted).toBe(0)
  })

  test("drains pending work after program failure and preserves the original failure", async () => {
    const trace = makeTrace()
    const diagnostic = await error(
      `
        tools.host.fail({})
        tools.host.sleepy({ id: 1, ms: 30 })
        throw new Error("original")
      `,
      { trace },
    )
    expect(diagnostic.kind).toBe("ExecutionFailure")
    expect(diagnostic.message).toBe("Uncaught: original")
    expect(trace.completed).toBe(1)
    expect(trace.interrupted).toBe(0)
  })
})

describe("promises at data boundaries", () => {
  test("returning an un-awaited promise inside data is a clear await-hinting diagnostic", async () => {
    const diagnostic = await error(`return { result: tools.host.sleepy({ id: 1 }) }`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
    expect(diagnostic.message).toContain("await tools.ns.tool(...)")
  })

  test("collection helpers do not let un-awaited promises cross the result boundary", async () => {
    const diagnostic = await error(`return Array.from([Promise.resolve(1)])`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
  })

  test("passing an un-awaited promise as a tool argument is a clear diagnostic", async () => {
    const diagnostic = await error(`return await tools.host.sleepy({ id: tools.host.sleepy({ id: 1 }) })`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
  })

  test("JSON.stringify of a promise is a diagnostic, not '{}'", async () => {
    const diagnostic = await error(`return JSON.stringify(Promise.resolve(1))`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
  })

  test("operators reject promise operands", async () => {
    const diagnostic = await error(`return Promise.resolve(1) + 1`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
  })
})

describe("Promise.all over arbitrary arrays", () => {
  test("mixes promises and plain values, preserving order", async () => {
    expect(
      await value(`
      return await Promise.all([tools.host.sleepy({ id: 1 }), "plain", tools.host.sleepy({ id: 2 }), 42])
    `),
    ).toEqual([1, "plain", 2, 42])
  })

  test("accepts arrays built beforehand, passed as identifiers, and spread elements", async () => {
    expect(
      await value(`
      const calls = []
      calls.push(tools.host.sleepy({ id: 1 }))
      calls.push(7)
      const more = [tools.host.sleepy({ id: 2 })]
      const batch = [...calls, ...more, "x"]
      return await Promise.all(batch)
    `),
    ).toEqual([1, 7, 2, "x"])
  })

  test("runs items.map tool calls in parallel", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const ids = [1, 2, 3, 4]
        return await Promise.all(ids.map((id) => tools.host.sleepy({ id, ms: 40 })))
      `,
      { trace },
    )
    expect(result).toEqual([1, 2, 3, 4])
    // maxActive counts truly-overlapping live executions, so > 1 proves real
    // parallelism deterministically - no wall-clock assertion needed.
    expect(trace.maxActive).toBeGreaterThan(1)
  })

  test("runs async map callbacks concurrently", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const ids = [1, 2, 3, 4]
        return await Promise.all(ids.map(async (id) => await tools.host.sleepy({ id, ms: 40 })))
      `,
      { trace },
    )
    expect(result).toEqual([1, 2, 3, 4])
    expect(trace.maxActive).toBeGreaterThan(1)
  })

  test("caps live tool-call concurrency at the fixed internal constant (8)", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const ids = []
        for (let i = 0; i < 20; i += 1) ids.push(i)
        const results = await Promise.all(ids.map((id) => tools.host.sleepy({ id, ms: 10 })))
        return results.length
      `,
      { trace },
    )
    expect(result).toBe(20)
    expect(trace.maxActive).toBeGreaterThan(1)
    expect(trace.maxActive).toBeLessThanOrEqual(8)
  })

  test("resolves the empty array", async () => {
    expect(await value(`return await Promise.all([])`)).toEqual([])
  })

  test("rejects with the first failure, catchable in-program", async () => {
    expect(
      await value(`
      try {
        await Promise.all([tools.host.sleepy({ id: 1 }), tools.host.fail({})])
        return "no"
      } catch (e) {
        return e.message
      }
    `),
    ).toBe("Lookup refused")
  })

  test("rejects before an earlier slow promise fulfills", async () => {
    const trace = makeTrace()
    expect(
      await value(
        `
          try {
            await Promise.all([
              tools.host.sleepy({ id: 1, ms: 100 }),
              tools.host.fail({}),
            ])
            return -1
          } catch {
            return await tools.host.completed({})
          }
        `,
        { trace },
      ),
    ).toBe(0)
    expect(trace.completed).toBe(1)
    expect(trace.interrupted).toBe(0)
  })

  test("a non-collection argument is a clear error", async () => {
    const diagnostic = await error(`return await Promise.all(42)`)
    expect(diagnostic.message).toContain("Promise.all expects an array")
  })

  test("exceeding maxToolCalls inside Promise.all is a ToolCallLimitExceeded diagnostic", async () => {
    const diagnostic = await error(
      `return await Promise.all([tools.host.sleepy({ id: 1 }), tools.host.sleepy({ id: 2 }), tools.host.sleepy({ id: 3 })])`,
      { limits: { maxToolCalls: 2 } },
    )
    expect(diagnostic.kind).toBe("ToolCallLimitExceeded")
  })
})

describe("Promise.allSettled", () => {
  test("reports fulfilled and rejected outcomes with catch-normalized reasons", async () => {
    expect(
      await value(`
      return await Promise.allSettled([
        tools.host.sleepy({ id: 5 }),
        tools.host.fail({}),
        "plain",
        Promise.reject(new Error("boom")),
      ])
    `),
    ).toEqual([
      { status: "fulfilled", value: 5 },
      { status: "rejected", reason: { name: "Error", message: "Lookup refused" } },
      { status: "fulfilled", value: "plain" },
      { status: "rejected", reason: { name: "Error", message: "boom" } },
    ])
  })

  test("never rejects for program-level failures", async () => {
    const result = await run(`
      const settled = await Promise.allSettled([tools.host.fail({}), tools.host.fail({})])
      return settled.filter((s) => s.status === "rejected").length
    `)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBe(2)
  })
})

describe("Promise.race", () => {
  test("first settlement wins and losers continue", async () => {
    const trace = makeTrace()
    const result = await value(
      `
        const fast = tools.host.sleepy({ id: 1, ms: 10 })
        const slow = tools.host.sleepy({ id: 2, ms: 30 })
        return await Promise.race([fast, slow])
      `,
      { trace },
    )
    expect(result).toBe(1)
    expect(trace.interrupted).toBe(0)
    expect(trace.completed).toBe(2)
  })

  test("a losing chain continues and remains awaitable", async () => {
    expect(
      await value(`
      const slow = tools.host.sleepy({ id: 2, ms: 30 }).then((id) => id * 2)
      const winner = await Promise.race([slow, "fast"])
      return [winner, await slow]
    `),
    ).toEqual(["fast", 4])
  })

  test("a rejection can win the race", async () => {
    expect(
      await value(`
      try {
        await Promise.race([tools.host.fail({}), tools.host.sleepy({ id: 1, ms: 30 })])
        return "no"
      } catch (e) {
        return e.message
      }
    `),
    ).toBe("Lookup refused")
  })

  test("a rejecting winner still drains its slow loser", async () => {
    const trace = makeTrace()
    const diagnostic = await error(
      `return await Promise.race([tools.host.fail({}), tools.host.sleepy({ id: 1, ms: 30 })])`,
      { trace },
    )
    expect(diagnostic.kind).toBe("ToolFailure")
    expect(diagnostic.message).toBe("Lookup refused")
    expect(trace.completed).toBe(1)
    expect(trace.interrupted).toBe(0)
  })

  test("a plain value wins over pending promises", async () => {
    const trace = makeTrace()
    expect(
      await value(`return await Promise.race([tools.host.sleepy({ id: 1, ms: 30 }), "immediate"])`, { trace }),
    ).toBe("immediate")
    expect(trace.interrupted).toBe(0)
    expect(trace.completed).toBe(1)
  })

  test("a losing rejection remains handled", async () => {
    expect(
      await value(`
        const rejectLater = async () => {
          await tools.host.sleepy({ id: 1, ms: 20 })
          throw new Error("late")
        }
        return await Promise.race([rejectLater(), "winner"])
      `),
    ).toBe("winner")
  })

  test("an empty race is a clear error instead of hanging", async () => {
    const diagnostic = await error(`return await Promise.race([])`)
    expect(diagnostic.message).toContain("never settle")
  })
})

describe("Promise.resolve / Promise.reject", () => {
  test("resolve wraps plain values and passes promises through", async () => {
    expect(await value(`return await Promise.resolve(42)`)).toBe(42)
    expect(await value(`return await Promise.resolve(Promise.resolve("nested"))`)).toBe("nested")
    expect(await value(`return await Promise.resolve(tools.host.sleepy({ id: 3 }))`)).toBe(3)
  })

  test("reject produces a promise whose await throws the reason", async () => {
    expect(
      await value(`
      try {
        await Promise.reject("nope")
        return "no"
      } catch (e) {
        return e
      }
    `),
    ).toBe("nope")
  })

  test("an abandoned rejected promise surfaces as an unhandled rejection", async () => {
    const diagnostic = await error(`
      Promise.reject(new Error("boom"))
      return "done"
    `)
    expect(diagnostic.kind).toBe("ExecutionFailure")
    expect(diagnostic.message).toContain("Unhandled rejection from an un-awaited promise")
    expect(diagnostic.message).toContain("boom")
  })
})

describe("Promise combinator values", () => {
  test("all, allSettled, and race return chainable promises", async () => {
    expect(
      await value(`
        const all = Promise.all([Promise.resolve(1), 2])
        const settled = Promise.allSettled([Promise.resolve(3)])
        const race = Promise.race([Promise.resolve(4)])
        return [
          all instanceof Promise,
          settled instanceof Promise,
          race instanceof Promise,
          await all.then((values) => values.join(",")),
          await settled.then((values) => values[0].value),
          await race.then((value) => value + 1),
        ]
      `),
    ).toEqual([true, true, true, "1,2", 3, 5])
  })
})

describe("timeout interruption of forked calls", () => {
  test("the execution timeout interrupts in-flight forked fibers", async () => {
    const trace = makeTrace()
    const result = await run(
      `
        const a = tools.host.sleepy({ id: 1, ms: 60000 })
        const b = tools.host.sleepy({ id: 2, ms: 60000 })
        return await a
      `,
      { trace, limits: { timeoutMs: 100 } },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("TimeoutExceeded")
    // Both calls started; neither escaped the timeout - the awaited one AND the abandoned one.
    expect(trace.starts).toEqual([1, 2])
    expect(trace.interrupted).toBe(2)
    expect(trace.completed).toBe(0)
  })

  test("the timeout also interrupts calls inside Promise.all", async () => {
    const trace = makeTrace()
    const result = await run(
      `return await Promise.all([tools.host.sleepy({ id: 1, ms: 60000 }), tools.host.sleepy({ id: 2, ms: 60000 })])`,
      { trace, limits: { timeoutMs: 100 } },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("TimeoutExceeded")
    expect(trace.interrupted).toBe(2)
  })

  test("interrupts promise fibers concurrently during scope teardown", async () => {
    const cleanup = { active: 0, overlapped: false }
    const tool = Tool.make({
      description: "Wait until interrupted",
      input: Schema.Struct({}),
      output: Schema.Never,
      run: () =>
        Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              cleanup.active += 1
              yield* Effect.sleep(20)
              cleanup.overlapped ||= cleanup.active > 1
              cleanup.active -= 1
            }),
          ),
        ),
    })
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: { host: { first: tool, second: tool } },
        code: `
          tools.host.first({})
          tools.host.second({})
          return await Promise.resolve("waiting")
        `,
        limits: { timeoutMs: 50 },
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("TimeoutExceeded")
    expect(cleanup.overlapped).toBe(true)
  })
})

describe("promise chaining", () => {
  test("then transforms values and flattens returned promises", async () => {
    expect(
      await value(`
        return tools.host.sleepy({ id: 2 })
          .then((id) => tools.host.sleepy({ id: id + 1 }))
          .then((id) => id * 2)
      `),
    ).toBe(6)
  })

  test("handlers run after synchronous statements", async () => {
    expect(
      await value(`
        const order = []
        const chained = Promise.resolve().then(() => order.push("then"))
        order.push("sync")
        await chained
        return order
      `),
    ).toEqual(["sync", "then"])
  })

  test("nested reactions run before downstream reactions queued later", async () => {
    expect(
      await value(`
        const order = []
        await Promise.resolve()
          .then(() => {
            order.push(1)
            Promise.resolve().then(() => order.push(2))
          })
          .then(() => order.push(3))
        return order
      `),
    ).toEqual([1, 2, 3])
  })

  test("plain and settled await resume after reactions that are already queued", async () => {
    expect(
      await value(`
        const order = []
        Promise.resolve().then(() => order.push(1))
        await 0
        order.push(2)
        Promise.resolve().then(() => order.push(3))
        await Promise.resolve()
        order.push(4)
        return order
      `),
    ).toEqual([1, 2, 3, 4])
  })

  test("reactions registered on the same pending promise preserve order", async () => {
    expect(
      await value(`
        const order = []
        const pending = tools.host.sleepy({ id: 1 })
        pending.then(() => order.push(1))
        pending.then(() => order.push(2))
        await pending
        return order
      `),
    ).toEqual([1, 2])
  })

  test("an async reaction does not block the next queued reaction", async () => {
    expect(
      await value(`
        const order = []
        const first = Promise.resolve().then(async () => {
          order.push(1)
          await tools.host.sleepy({ id: 1 })
          order.push(3)
        })
        Promise.resolve().then(() => order.push(2))
        await first
        return order
      `),
    ).toEqual([1, 2, 3])
  })

  test("catch receives normalized errors and recovers the chain", async () => {
    expect(await value(`return tools.host.fail({}).catch((error) => error.message)`)).toBe("Lookup refused")
    expect(
      await value(`
        return Promise.resolve(1)
          .then(() => { throw new Error("boom") })
          .catch((error) => error.message)
      `),
    ).toBe("boom")
  })

  test("then rejection handlers and omitted handlers pass through settlement", async () => {
    expect(await value(`return Promise.resolve(4).then(undefined).catch(undefined)`)).toBe(4)
    expect(await value(`return Promise.reject("nope").then(undefined, (reason) => reason + "!")`)).toBe("nope!")
  })

  test("supported builtin callables can be handlers", async () => {
    expect(await value(`return Promise.resolve({ a: 1 }).then(JSON.stringify)`)).toBe('{"a":1}')
    expect(await value(`return Promise.resolve(4).then(Promise.resolve)`)).toBe(4)
  })

  test("finally awaits its callback and preserves the original settlement", async () => {
    expect(
      await value(`
        let cleanup = 0
        const result = await Promise.resolve(7).finally(async () => {
          await tools.host.sleepy({ id: 1 })
          cleanup = 1
          return 99
        })
        return [result, cleanup]
      `),
    ).toEqual([7, 1])
    expect(
      await value(`return Promise.reject(new Error("original")).finally(() => 99).catch((error) => error.message)`),
    ).toBe("original")
  })

  test("a rejected finally callback replaces the original settlement", async () => {
    expect(
      await value(`
        return Promise.resolve(1)
          .finally(() => Promise.reject(new Error("cleanup")))
          .catch((error) => error.message)
      `),
    ).toBe("cleanup")
  })

  test("a self-resolving chain rejects instead of deadlocking", async () => {
    expect(
      await value(`
        let chained
        chained = Promise.resolve().then(() => chained)
        return chained.catch((error) => [error.name, error.message])
      `),
    ).toEqual(["TypeError", "Chaining cycle detected for promise."])
  })
})

describe("unsupported promise surface", () => {
  test("other property reads on a promise hint at the missing await", async () => {
    const diagnostic = await error(`return tools.host.sleepy({ id: 1 }).value`)
    expect(diagnostic.kind).toBe("InvalidDataValue")
    expect(diagnostic.message).toContain("un-awaited Promise")
    expect(diagnostic.message).toContain("await it first")
  })

  test("unknown Promise statics list what is available", async () => {
    const diagnostic = await error(`return await Promise.any([tools.host.sleepy({ id: 1 })])`)
    expect(diagnostic.message).toContain("Promise.any is not available")
    expect(diagnostic.message).toContain("Promise.allSettled")
  })

  test("new Promise(...) points at tool calls instead", async () => {
    const diagnostic = await error(`return new Promise((resolve) => resolve(1))`)
    expect(diagnostic.kind).toBe("UnsupportedSyntax")
    expect(diagnostic.message).toContain("new Promise(...) is not supported")
    expect(diagnostic.message).toContain("already return promises")
  })
})
