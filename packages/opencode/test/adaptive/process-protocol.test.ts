import { describe, expect, test } from "bun:test"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { AgentEntry } from "@/adaptive/process/agent-entry"
import { AgentProcessProtocol } from "@/adaptive/process/protocol"

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const hello = {
  v: 1,
  id: "hello-1",
  type: "hello",
  taskID: AdaptiveTask.ID.create(),
  agentID: AdaptiveTask.AgentID.create(),
  generation: 0,
  role: "implementation",
} as const

describe("adaptive agent process protocol codec", () => {
  test("encodes and decodes one valid UTF-8 JSON line", () => {
    const encoded = AgentProcessProtocol.encode(hello)

    expect(decoder.decode(encoded)).toBe(JSON.stringify(hello) + "\n")
    expect(AgentProcessProtocol.decode(encoded, "child-to-controller")).toEqual(hello)
  })

  test("rejects malformed JSON without exposing raw payload", () => {
    const secret = "secret-value-must-not-leak"

    expectProtocolError(() => AgentProcessProtocol.decode(encoder.encode(`{"v":1,"leak":"${secret}"\n`)), {
      code: "INVALID_FRAME",
      message: "Invalid adaptive process frame",
      absent: secret,
    })
  })

  test("distinguishes unsupported versions without exposing the frame", () => {
    const secret = "unsupported-version-secret"

    expectProtocolError(
      () =>
        AgentProcessProtocol.decode(
          encoder.encode(JSON.stringify({ v: 2, id: secret, type: "ready" }) + "\n"),
          "child-to-controller",
        ),
      {
        code: "UNSUPPORTED_VERSION",
        message: "Unsupported adaptive process protocol",
        absent: secret,
      },
    )
  })

  test("buffers incomplete chunks and returns multiple frames in order", () => {
    const frames = [hello, { v: 1, id: "ready-1", type: "ready" } as const]
    const encoded = concat(frames.map(AgentProcessProtocol.encode))
    const incremental = AgentProcessProtocol.makeDecoder("child-to-controller")

    expect(incremental.push(encoded.subarray(0, 17))).toEqual([])
    expect(incremental.push(encoded.subarray(17))).toEqual(frames)
    expect(incremental.finish()).toEqual([])

    const incomplete = AgentProcessProtocol.makeDecoder("child-to-controller")
    expect(incomplete.push(AgentProcessProtocol.encode(hello).subarray(0, -1))).toEqual([])
    expectProtocolError(() => incomplete.finish(), {
      code: "INCOMPLETE_FRAME",
      message: "Incomplete adaptive process frame",
    })
  })

  test("enforces the maximum encoded byte boundary and bounds incomplete input", () => {
    const frame = {
      v: 1,
      id: "request-1",
      type: "rpc.request",
      method: "model.stream",
      payload: "",
    } as const
    const overhead = encoder.encode(JSON.stringify(frame) + "\n").byteLength
    const exact = { ...frame, payload: "x".repeat(AgentProcessProtocol.MAX_ENCODED_FRAME_BYTES - overhead) }

    expect(AgentProcessProtocol.encode(exact).byteLength).toBe(AgentProcessProtocol.MAX_ENCODED_FRAME_BYTES)
    expectProtocolError(() => AgentProcessProtocol.encode({ ...exact, payload: exact.payload + "x" }), {
      code: "FRAME_TOO_LARGE",
      message: `Adaptive process frame exceeds ${AgentProcessProtocol.MAX_ENCODED_FRAME_BYTES} bytes`,
    })

    const incremental = AgentProcessProtocol.makeDecoder("child-to-controller")
    expectProtocolError(
      () => incremental.push(encoder.encode("x".repeat(AgentProcessProtocol.MAX_ENCODED_FRAME_BYTES))),
      {
        code: "FRAME_TOO_LARGE",
        message: `Adaptive process frame exceeds ${AgentProcessProtocol.MAX_ENCODED_FRAME_BYTES} bytes`,
      },
    )
    expect(incremental.bufferedBytes).toBe(0)
  })

  test("rejects unknown fields, message shapes, roles, IDs, and generations", () => {
    const invalid = [
      { ...hello, credential: "not permitted" },
      { v: 1, id: "unknown-1", type: "log", message: "not permitted" },
      { v: 1, id: "request-1", type: "rpc.request", method: "other", payload: null },
      { ...hello, role: "compactor" },
      { ...hello, taskID: "adt_short" },
      { ...hello, agentID: "ada_short" },
      { ...hello, generation: -1 },
      { ...hello, generation: 1.5 },
      { ...hello, generation: Number.MAX_SAFE_INTEGER + 1 },
      { v: 1, id: "accepted-1", type: "accepted", heartbeatMs: 0 },
    ]

    for (const frame of invalid) {
      expectProtocolError(() => AgentProcessProtocol.decode(encoder.encode(JSON.stringify(frame) + "\n"), "any"), {
        code: "INVALID_FRAME",
        message: "Invalid adaptive process frame",
        absent: "not permitted",
      })
    }
  })

  test("uses LF only and rejects bare CR and CRLF", () => {
    for (const ending of ["\r", "\r\n"]) {
      expectProtocolError(
        () => AgentProcessProtocol.decode(encoder.encode(JSON.stringify(hello) + ending), "child-to-controller"),
        { code: "INVALID_NEWLINE", message: "Invalid adaptive process frame newline" },
      )
    }
  })

  test("preserves multibyte UTF-8 split across arbitrary chunks", () => {
    const frame = { v: 1, id: "response-1", type: "rpc.response", requestID: "request-1", payload: "你好" } as const
    const encoded = AgentProcessProtocol.encode(frame)
    const marker = encoder.encode("你")
    const start = findBytes(encoded, marker)
    const incremental = AgentProcessProtocol.makeDecoder("controller-to-child")

    expect(incremental.push(encoded.subarray(0, start + 1))).toEqual([])
    expect(incremental.push(encoded.subarray(start + 1, start + 2))).toEqual([])
    expect(incremental.push(encoded.subarray(start + 2))).toEqual([frame])
  })

  test("counts encoded bytes and rejects oversized terminated frames", () => {
    const frame = {
      v: 1,
      id: "request-1",
      type: "rpc.request",
      method: "model.stream",
      payload: "界".repeat(400_000),
    } as const

    expect(JSON.stringify(frame).length).toBeLessThan(AgentProcessProtocol.MAX_ENCODED_FRAME_BYTES)
    expectProtocolError(() => AgentProcessProtocol.encode(frame), {
      code: "FRAME_TOO_LARGE",
      message: `Adaptive process frame exceeds ${AgentProcessProtocol.MAX_ENCODED_FRAME_BYTES} bytes`,
    })

    const incremental = AgentProcessProtocol.makeDecoder("child-to-controller")
    expectProtocolError(
      () =>
        incremental.push(
          concat([encoder.encode("x".repeat(AgentProcessProtocol.MAX_ENCODED_FRAME_BYTES)), encoder.encode("\n")]),
        ),
      {
        code: "FRAME_TOO_LARGE",
        message: `Adaptive process frame exceeds ${AgentProcessProtocol.MAX_ENCODED_FRAME_BYTES} bytes`,
      },
    )
  })

  test("rejects frames from the wrong protocol direction", () => {
    expectProtocolError(() => AgentProcessProtocol.decode(AgentProcessProtocol.encode(hello), "controller-to-child"), {
      code: "INVALID_FRAME",
      message: "Invalid adaptive process frame",
    })
  })

  test("rejects payload values that JSON would silently transform", () => {
    const sparse = new Array(2)
    sparse[1] = "present"
    const invalid = [
      {
        v: 1,
        id: "request-1",
        type: "rpc.request",
        method: "model.stream",
        payload: { nested: undefined, secret: "nested-undefined-secret" },
      },
      {
        v: 1,
        id: "response-1",
        type: "rpc.response",
        requestID: "request-1",
        payload: Number.NaN,
      },
      {
        v: 1,
        id: "event-1",
        type: "rpc.event",
        requestID: "request-1",
        payload: sparse,
      },
      {
        v: 1,
        id: "request-2",
        type: "rpc.request",
        method: "model.stream",
        payload: {
          secret: "custom-serialization-secret",
          toJSON: () => ({ changed: true }),
        },
      },
    ]

    for (const frame of invalid) {
      expectProtocolError(() => AgentProcessProtocol.encode(frame as AgentProcessProtocol.Frame), {
        code: "INVALID_FRAME",
        message: "Invalid adaptive process frame",
        absent: "secret",
      })
    }
  })
})

describe("adaptive child RPC state", () => {
  test("bounds outstanding calls and frees capacity after a response", async () => {
    const sent: AgentProcessProtocol.ChildToController[] = []
    let sequence = 0
    const rpc = AgentEntry.makeRpcClient({
      send: (frame) => sent.push(frame),
      nextID: () => `request-${sequence++}`,
    })
    const pending = Array.from({ length: AgentProcessProtocol.MAX_OUTSTANDING_RPC_CALLS }, (_, index) =>
      rpc.request("model.stream", { index }),
    )

    expect(rpc.outstanding).toBe(AgentProcessProtocol.MAX_OUTSTANDING_RPC_CALLS)
    expect(sent).toHaveLength(AgentProcessProtocol.MAX_OUTSTANDING_RPC_CALLS)
    expectProtocolError(() => rpc.request("model.stream", { secret: "must-not-leak" }), {
      code: "RPC_LIMIT",
      message: `Adaptive process RPC limit exceeded (${AgentProcessProtocol.MAX_OUTSTANDING_RPC_CALLS})`,
      absent: "must-not-leak",
    })

    rpc.receive({
      v: 1,
      id: "response-1",
      type: "rpc.response",
      requestID: "request-0",
      payload: "accepted",
    })
    expect(await pending[0]).toBe("accepted")
    expect(rpc.outstanding).toBe(AgentProcessProtocol.MAX_OUTSTANDING_RPC_CALLS - 1)
    rpc.request("model.stream", { replacement: true })
    expect(rpc.outstanding).toBe(AgentProcessProtocol.MAX_OUTSTANDING_RPC_CALLS)
  })

  test("routes stream events, ends, and typed remote errors", async () => {
    const events: unknown[] = []
    let sequence = 0
    const rpc = AgentEntry.makeRpcClient({ send: () => undefined, nextID: () => `request-${sequence++}` })
    const stream = rpc.request("model.stream", {}, { onEvent: (payload) => events.push(payload) })

    rpc.receive({ v: 1, id: "event-1", type: "rpc.event", requestID: "request-0", payload: "delta" })
    expect(events).toEqual(["delta"])
    expect(rpc.outstanding).toBe(1)
    rpc.receive({ v: 1, id: "end-1", type: "rpc.end", requestID: "request-0" })
    expect(await stream).toBeUndefined()
    expect(rpc.outstanding).toBe(0)

    const failed = rpc.request("model.stream", {})
    rpc.receive({
      v: 1,
      id: "error-1",
      type: "rpc.error",
      requestID: "request-1",
      code: "MODEL_FAILED",
      message: "model failed",
    })
    await expect(failed).rejects.toEqual(
      expect.objectContaining({ _tag: "AdaptiveProcessRemoteRpcError", code: "MODEL_FAILED" }),
    )
    expect(rpc.outstanding).toBe(0)
  })

  test("makes close terminal before request allocation or send", () => {
    const sent: AgentProcessProtocol.ChildToController[] = []
    let allocations = 0
    const rpc = AgentEntry.makeRpcClient({
      send: (frame) => sent.push(frame),
      nextID: () => `request-${allocations++}`,
    })

    rpc.close(new Error("stopped"))

    expectProtocolError(() => rpc.request("model.stream", { late: true }), {
      code: "INVALID_FRAME",
      message: "Adaptive process RPC client is closed",
    })
    expect(allocations).toBe(0)
    expect(sent).toEqual([])
    expect(rpc.outstanding).toBe(0)
  })
})

describe("adaptive child entry loop", () => {
  test("sends hello from validated argv and exits 64 after the 10 second accepted deadline", async () => {
    const harness = makeHarness()
    const running = AgentEntry.run({
      argv: validArgv(),
      transport: harness.transport,
      clock: harness.clock,
      nextID: harness.nextID,
      runRole: async () => undefined,
    })

    expect(await harness.output.take()).toEqual({
      v: 1,
      id: "frame-0",
      type: "hello",
      taskID: hello.taskID,
      agentID: hello.agentID,
      generation: 0,
      role: "implementation",
    })
    harness.clock.advance(9_999)
    await flushMicrotasks()
    expect(await isSettled(running)).toBe(false)
    harness.clock.advance(1)
    expect(await running).toBe(64)
    expect(harness.clock.activeCount).toBe(0)
    expect(harness.input.returned).toBe(true)
  })

  test("actively cancels a pending transport read before iterator cleanup", async () => {
    const input = new CancellationOnlyInput()
    const output = new AsyncQueue<AgentProcessProtocol.ChildToController>()
    const clock = new FakeClock()
    let sequence = 0
    let cancelCalls = 0
    const running = AgentEntry.run({
      argv: validArgv(),
      transport: {
        input,
        write: (chunk) => output.push(AgentProcessProtocol.decode(chunk, "child-to-controller")),
        cancelInput: () => {
          cancelCalls++
          input.release()
        },
      },
      clock,
      nextID: () => `frame-${sequence++}`,
      runRole: async () => undefined,
    })

    await output.take()
    clock.advance(AgentEntry.ACCEPTED_TIMEOUT_MS)
    await flushMicrotasks()
    const settledWithoutTestCleanup = await isSettled(running)
    if (!settledWithoutTestCleanup) input.release()

    expect(await running).toBe(64)
    expect(settledWithoutTestCleanup).toBe(true)
    expect(cancelCalls).toBe(1)
    expect(input.returnCalled).toBe(true)
  })

  test("preserves protocol exit and returns the iterator when input cancellation rejects", async () => {
    const harness = makeHarness()
    const running = AgentEntry.run({
      argv: validArgv(),
      transport: {
        ...harness.transport,
        cancelInput: () => {
          harness.input.close()
          return Promise.reject(new Error("cancel failed"))
        },
      },
      clock: harness.clock,
      nextID: harness.nextID,
      runRole: async () => undefined,
    })
    await harness.output.take()
    harness.clock.advance(AgentEntry.ACCEPTED_TIMEOUT_MS)

    expect(await resolvedOutcome(running)).toBe(64)
    expect(harness.input.returnCalls).toBe(1)
  })

  test("preserves internal exit when input cancellation rejects", async () => {
    const harness = makeHarness()
    const running = AgentEntry.run({
      argv: validArgv(),
      transport: {
        ...harness.transport,
        cancelInput: () => {
          harness.input.close()
          return Promise.reject(new Error("cancel failed"))
        },
      },
      clock: harness.clock,
      nextID: harness.nextID,
      runRole: async () => {
        throw new Error("role failed")
      },
    })
    await harness.output.take()
    harness.send({ v: 1, id: "accepted-1", type: "accepted", heartbeatMs: 25 })
    await harness.output.take()

    expect(await resolvedOutcome(running)).toBe(70)
    expect(harness.input.returnCalls).toBe(1)
  })

  test("maps iterator cleanup rejection after acknowledged completion to exit 70", async () => {
    const harness = makeHarness({ returnError: new Error("iterator return failed") })
    const running = AgentEntry.run({
      argv: validArgv(),
      transport: harness.transport,
      clock: harness.clock,
      nextID: harness.nextID,
      runRole: async (context) => {
        await context.complete({ status: "done" })
      },
    })
    await harness.output.take()
    harness.send({ v: 1, id: "accepted-1", type: "accepted", heartbeatMs: 25 })
    await harness.output.take()
    const completion = await harness.output.take()
    harness.send({
      v: 1,
      id: "response-1",
      type: "rpc.response",
      requestID: completion.id,
      payload: { acknowledged: true },
    })

    expect(await resolvedOutcome(running)).toBe(70)
    expect(harness.input.returnCalls).toBe(1)
  })

  test("rejects invalid or expanded argv without sending hello", async () => {
    for (const argv of [
      validArgv().with(5, "-1"),
      [...validArgv(), "--provider-id", "provider", "--credential", "secret"],
    ]) {
      const harness = makeHarness()

      expect(
        await AgentEntry.run({
          argv,
          transport: harness.transport,
          clock: harness.clock,
          nextID: harness.nextID,
          runRole: async () => undefined,
        }),
      ).toBe(64)
      expect(harness.output.size).toBe(0)
      expect(harness.clock.activeCount).toBe(0)
    }
  })

  test("rejects an empty generation instead of coercing it to zero", () => {
    expectProtocolError(() => AgentEntry.parseArgv(validArgv().with(5, "")), {
      code: "INVALID_FRAME",
      message: "Invalid adaptive process configuration",
    })
  })

  test("rejects a wrong response or version during handshake with exit 64", async () => {
    for (const response of [
      AgentProcessProtocol.encode({
        v: 1,
        id: "response-1",
        type: "rpc.response",
        requestID: "missing",
        payload: null,
      }),
      encoder.encode('{"v":2,"id":"accepted-1","type":"accepted","heartbeatMs":25}\n'),
    ]) {
      const harness = makeHarness()
      const running = AgentEntry.run({
        argv: validArgv(),
        transport: harness.transport,
        clock: harness.clock,
        nextID: harness.nextID,
        runRole: async () => undefined,
      })
      await harness.output.take()
      harness.input.push(response)

      expect(await running).toBe(64)
      expect(harness.clock.activeCount).toBe(0)
      expect(harness.input.returned).toBe(true)
    }
  })

  test("sends ready and interval heartbeats, then exits 0 only after process.complete acknowledgment", async () => {
    const harness = makeHarness()
    const running = AgentEntry.run({
      argv: validArgv(),
      transport: harness.transport,
      clock: harness.clock,
      nextID: harness.nextID,
      runRole: async (context) => {
        await context.complete({ status: "done" })
      },
    })
    await harness.output.take()
    harness.send({ v: 1, id: "accepted-1", type: "accepted", heartbeatMs: 25 })

    expect(await harness.output.take()).toEqual({ v: 1, id: "frame-1", type: "ready" })
    const completion = await harness.output.take()
    expect(completion).toEqual({
      v: 1,
      id: "frame-2",
      type: "rpc.request",
      method: "process.complete",
      payload: { status: "done" },
    })
    harness.clock.advance(24)
    await flushMicrotasks()
    expect(harness.output.size).toBe(0)
    harness.clock.advance(1)
    expect(await harness.output.take()).toEqual({ v: 1, id: "frame-3", type: "heartbeat" })
    expect(await isSettled(running)).toBe(false)

    harness.send({
      v: 1,
      id: "response-1",
      type: "rpc.response",
      requestID: completion.id,
      payload: { acknowledged: true },
    })
    expect(await running).toBe(0)
    expect(harness.clock.activeCount).toBe(0)
    expect(harness.input.returned).toBe(true)
  })

  test("maps role faults to exit 70", async () => {
    const harness = makeHarness()
    const running = AgentEntry.run({
      argv: validArgv(),
      transport: harness.transport,
      clock: harness.clock,
      nextID: harness.nextID,
      runRole: async () => {
        throw new Error("internal role failure")
      },
    })
    await harness.output.take()
    harness.send({ v: 1, id: "accepted-1", type: "accepted", heartbeatMs: 25 })
    await harness.output.take()

    expect(await running).toBe(70)
    expect(harness.clock.activeCount).toBe(0)
    expect(harness.input.returned).toBe(true)
  })

  test("maps a heartbeat transport fault to exit 70 and cleans the loop", async () => {
    const harness = makeHarness()
    let releaseRole!: () => void
    const heartbeatAttempted = new Promise<void>((resolve) => {
      releaseRole = resolve
    })
    const running = AgentEntry.run({
      argv: validArgv(),
      transport: {
        input: harness.input,
        cancelInput: () => harness.input.return(),
        write: (chunk) => {
          const frame = AgentProcessProtocol.decode(chunk, "child-to-controller")
          if (frame.type === "heartbeat") {
            releaseRole()
            throw new Error("heartbeat transport failure")
          }
          harness.output.push(frame)
        },
      },
      clock: harness.clock,
      nextID: harness.nextID,
      runRole: async () => heartbeatAttempted,
    })
    await harness.output.take()
    harness.send({ v: 1, id: "accepted-1", type: "accepted", heartbeatMs: 25 })
    await harness.output.take()
    await flushMicrotasks()
    harness.clock.advance(25)

    expect(await running).toBe(70)
    expect(harness.clock.activeCount).toBe(0)
    expect(harness.input.returned).toBe(true)
  })

  test("keeps one heartbeat write in flight and settles it before teardown completes", async () => {
    const harness = makeHarness()
    let settleHeartbeat!: () => void
    const heartbeatWrite = new Promise<void>((resolve) => {
      settleHeartbeat = resolve
    })
    let heartbeatWrites = 0
    const running = AgentEntry.run({
      argv: validArgv(),
      transport: {
        input: harness.input,
        cancelInput: () => harness.input.close(),
        write: (chunk) => {
          const frame = AgentProcessProtocol.decode(chunk, "child-to-controller")
          if (frame.type === "heartbeat") {
            heartbeatWrites++
            return heartbeatWrite
          }
          harness.output.push(frame)
        },
      },
      clock: harness.clock,
      nextID: harness.nextID,
      runRole: async (context) => {
        await context.shutdown
      },
    })
    await harness.output.take()
    harness.send({ v: 1, id: "accepted-1", type: "accepted", heartbeatMs: 25 })
    await harness.output.take()
    await flushMicrotasks()
    harness.clock.advance(125)
    await flushMicrotasks()
    const writesWhilePending = heartbeatWrites
    harness.send({
      v: 1,
      id: "response-1",
      type: "rpc.response",
      requestID: "missing",
      payload: null,
    })
    await flushMicrotasks()
    const settledBeforeHeartbeat = await isSettled(running)
    settleHeartbeat()

    expect(await running).toBe(64)
    harness.clock.advance(100)
    await flushMicrotasks()
    expect(writesWhilePending).toBe(1)
    expect(settledBeforeHeartbeat).toBe(false)
    expect(heartbeatWrites).toBe(1)
  })

  test("delivers shutdown to the role loop and exits nonzero before completion", async () => {
    const harness = makeHarness()
    let reason: string | undefined
    const running = AgentEntry.run({
      argv: validArgv(),
      transport: harness.transport,
      clock: harness.clock,
      nextID: harness.nextID,
      runRole: async (context) => {
        reason = await context.shutdown
      },
    })
    await harness.output.take()
    harness.send({ v: 1, id: "accepted-1", type: "accepted", heartbeatMs: 25 })
    await harness.output.take()
    harness.send({ v: 1, id: "shutdown-1", type: "shutdown", reason: "controller stopped" })

    expect(await running).toBe(64)
    expect(reason).toBe("controller stopped")
    expect(harness.clock.activeCount).toBe(0)
    expect(harness.input.returned).toBe(true)
  })

  test("signals and closes a losing role before it can send a delayed request", async () => {
    const harness = makeHarness()
    let shutdownReason: string | undefined
    let delayedError: unknown
    const running = AgentEntry.run({
      argv: validArgv(),
      transport: harness.transport,
      clock: harness.clock,
      nextID: harness.nextID,
      runRole: async (context) => {
        shutdownReason = await context.shutdown
        try {
          await context.modelStream({ late: true })
        } catch (error) {
          delayedError = error
        }
      },
    })
    await harness.output.take()
    harness.send({ v: 1, id: "accepted-1", type: "accepted", heartbeatMs: 25 })
    await harness.output.take()
    harness.send({
      v: 1,
      id: "response-1",
      type: "rpc.response",
      requestID: "missing",
      payload: null,
    })

    expect(await running).toBe(64)
    await flushMicrotasks()
    expect(shutdownReason).toBe("Adaptive process stopped")
    expect(delayedError).toBeInstanceOf(AgentProcessProtocol.ProtocolError)
    expect(harness.output.size).toBe(0)
  })
})

function expectProtocolError(
  run: () => unknown,
  expected: { code: AgentProcessProtocol.ErrorCode; message: string; absent?: string },
) {
  try {
    run()
    throw new Error("expected adaptive process protocol error")
  } catch (error) {
    expect(error).toBeInstanceOf(AgentProcessProtocol.ProtocolError)
    expect((error as AgentProcessProtocol.ProtocolError).code).toBe(expected.code)
    expect(String(error)).toContain(expected.message)
    if (expected.absent) expect(String(error)).not.toContain(expected.absent)
  }
}

function concat(chunks: readonly Uint8Array[]) {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  chunks.reduce((offset, chunk) => {
    output.set(chunk, offset)
    return offset + chunk.byteLength
  }, 0)
  return output
}

function findBytes(haystack: Uint8Array, needle: Uint8Array) {
  const found = haystack.findIndex((_, index) => needle.every((byte, offset) => haystack[index + offset] === byte))
  if (found < 0) throw new Error("UTF-8 marker missing from encoded frame")
  return found
}

function validArgv() {
  return ["--task-id", hello.taskID, "--agent-id", hello.agentID, "--generation", "0", "--role", "implementation"]
}

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  readonly #values: T[] = []
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = []
  #closed = false
  readonly #returnError: Error | undefined
  returned = false
  returnCalls = 0

  constructor(returnError?: Error) {
    this.#returnError = returnError
  }

  get size() {
    return this.#values.length
  }

  push(value: T) {
    const waiter = this.#waiters.shift()
    if (waiter) {
      waiter({ done: false, value })
      return
    }
    this.#values.push(value)
  }

  take() {
    return this.next().then((result) => {
      if (result.done) throw new Error("queue closed before next value")
      return result.value
    })
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.#closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  return(): Promise<IteratorResult<T>> {
    this.returnCalls++
    this.returned = true
    this.close()
    if (this.#returnError) return Promise.reject(this.#returnError)
    return Promise.resolve({ done: true, value: undefined })
  }

  close() {
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  [Symbol.asyncIterator]() {
    return this
  }
}

class CancellationOnlyInput implements AsyncIterableIterator<Uint8Array> {
  readonly #pending: Promise<IteratorResult<Uint8Array>>
  #release!: (result: IteratorResult<Uint8Array>) => void
  returnCalled = false

  constructor() {
    this.#pending = new Promise((resolve) => {
      this.#release = resolve
    })
  }

  next() {
    return this.#pending
  }

  return() {
    this.returnCalled = true
    return this.#pending
  }

  release() {
    this.#release({ done: true, value: undefined })
  }

  [Symbol.asyncIterator]() {
    return this
  }
}

class FakeClock {
  #now = 0
  #sequence = 0
  readonly #timers = new Map<number, { at: number; interval?: number; run: () => void }>()

  get activeCount() {
    return this.#timers.size
  }

  setTimeout(run: () => void, milliseconds: number) {
    return this.#add(run, milliseconds)
  }

  clearTimeout(id: unknown) {
    this.#timers.delete(id as number)
  }

  setInterval(run: () => void, milliseconds: number) {
    return this.#add(run, milliseconds, milliseconds)
  }

  clearInterval(id: unknown) {
    this.#timers.delete(id as number)
  }

  advance(milliseconds: number) {
    const target = this.#now + milliseconds
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!next) break
      const [id, timer] = next
      this.#now = timer.at
      if (timer.interval) timer.at += timer.interval
      if (!timer.interval) this.#timers.delete(id)
      timer.run()
    }
    this.#now = target
  }

  #add(run: () => void, milliseconds: number, interval?: number) {
    const id = this.#sequence++
    this.#timers.set(id, { at: this.#now + milliseconds, interval, run })
    return id
  }
}

function makeHarness(options: { returnError?: Error } = {}) {
  const input = new AsyncQueue<Uint8Array>(options.returnError)
  const output = new AsyncQueue<AgentProcessProtocol.ChildToController>()
  const clock = new FakeClock()
  let sequence = 0
  return {
    input,
    output,
    clock,
    nextID: () => `frame-${sequence++}`,
    transport: {
      input,
      cancelInput: () => input.close(),
      write: (chunk: Uint8Array) => output.push(AgentProcessProtocol.decode(chunk, "child-to-controller")),
    },
    send: (frame: AgentProcessProtocol.ControllerToChild) => input.push(AgentProcessProtocol.encode(frame)),
  }
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

async function isSettled(promise: Promise<unknown>) {
  const sentinel = Symbol("pending")
  return (await Promise.race([promise, Promise.resolve(sentinel)])) !== sentinel
}

async function resolvedOutcome(promise: Promise<unknown>) {
  try {
    return await promise
  } catch (error) {
    return error
  }
}
