import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Schema } from "effect"
import { AgentProcessProtocol } from "./protocol"

export const EXIT_OK = 0 as const
export const EXIT_PROTOCOL = 64 as const
export const EXIT_INTERNAL = 70 as const
export const ACCEPTED_TIMEOUT_MS = 10_000
export type ExitCode = typeof EXIT_OK | typeof EXIT_PROTOCOL | typeof EXIT_INTERNAL

const IdentitySchema = Schema.Struct({
  taskID: AdaptiveTask.ID,
  agentID: AdaptiveTask.AgentID,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  role: AdaptiveTask.Role,
})
const decodeIdentity = Schema.decodeUnknownSync(IdentitySchema)

export type Identity = typeof IdentitySchema.Type

export interface Transport {
  readonly input: AsyncIterable<Uint8Array>
  readonly write: (chunk: Uint8Array) => unknown
  readonly cancelInput: () => unknown
}

export interface Clock {
  readonly setTimeout: (run: () => void, milliseconds: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
  readonly setInterval: (run: () => void, milliseconds: number) => unknown
  readonly clearInterval: (handle: unknown) => void
}

export interface RoleContext {
  readonly identity: Identity
  readonly shutdown: Promise<string>
  readonly modelStream: (payload: unknown, onEvent?: (payload: unknown) => void) => Promise<unknown>
  readonly complete: (payload: unknown) => Promise<unknown>
}

export interface RunOptions {
  readonly argv: readonly string[]
  readonly transport: Transport
  readonly clock: Clock
  readonly nextID: () => string
  readonly runRole: (context: RoleContext) => Promise<void>
}

export class RemoteRpcError extends Schema.TaggedErrorClass<RemoteRpcError>()("AdaptiveProcessRemoteRpcError", {
  code: Schema.String,
  message: Schema.String,
}) {}

export interface RpcClientOptions {
  readonly send: (frame: AgentProcessProtocol.ChildToController) => unknown
  readonly nextID: () => string
}

export interface RequestOptions {
  readonly onEvent?: (payload: unknown) => void
}

interface PendingCall {
  readonly method: "model.stream" | "process.complete"
  readonly resolve: (payload: unknown) => void
  readonly reject: (error: unknown) => void
  readonly onEvent?: (payload: unknown) => void
}

export class RpcClient {
  readonly #options: RpcClientOptions
  readonly #pending = new Map<string, PendingCall>()
  #completeAcknowledged = false

  constructor(options: RpcClientOptions) {
    this.#options = options
  }

  get outstanding() {
    return this.#pending.size
  }

  get completeAcknowledged() {
    return this.#completeAcknowledged
  }

  request(method: "model.stream" | "process.complete", payload: unknown, options: RequestOptions = {}) {
    if (this.#pending.size >= AgentProcessProtocol.MAX_OUTSTANDING_RPC_CALLS) {
      throw new AgentProcessProtocol.ProtocolError({
        code: "RPC_LIMIT",
        message: `Adaptive process RPC limit exceeded (${AgentProcessProtocol.MAX_OUTSTANDING_RPC_CALLS})`,
      })
    }

    const id = this.#options.nextID()
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject, onEvent: options.onEvent })
    })
    try {
      const sent = this.#options.send({ v: AgentProcessProtocol.VERSION, id, type: "rpc.request", method, payload })
      Promise.resolve(sent).catch((error) => this.#reject(id, error))
    } catch (error) {
      this.#reject(id, error)
    }
    return result
  }

  receive(frame: Exclude<AgentProcessProtocol.ControllerToChild, { type: "accepted" | "shutdown" }>) {
    const pending = this.#pending.get(frame.requestID)
    if (!pending) {
      throw new AgentProcessProtocol.ProtocolError({
        code: "INVALID_FRAME",
        message: "Invalid adaptive process RPC correlation",
      })
    }

    if (frame.type === "rpc.event") {
      pending.onEvent?.(frame.payload)
      return
    }

    this.#pending.delete(frame.requestID)
    if (frame.type === "rpc.error") {
      pending.reject(new RemoteRpcError({ code: frame.code, message: frame.message }))
      return
    }

    if (pending.method === "process.complete") this.#completeAcknowledged = true
    pending.resolve(frame.type === "rpc.response" ? frame.payload : undefined)
  }

  close(error: unknown) {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }

  #reject(id: string, error: unknown) {
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    pending.reject(error)
  }
}

export function makeRpcClient(options: RpcClientOptions) {
  return new RpcClient(options)
}

export function parseArgv(argv: readonly string[]): Identity {
  const names = ["--task-id", "--agent-id", "--generation", "--role"]
  if (argv.length !== names.length * 2 || names.some((name, index) => argv[index * 2] !== name)) {
    throw invalidConfiguration()
  }
  if (!/^(0|[1-9][0-9]*)$/.test(argv[5])) throw invalidConfiguration()

  try {
    return decodeIdentity({
      taskID: argv[1],
      agentID: argv[3],
      generation: Number(argv[5]),
      role: argv[7],
    })
  } catch {
    throw invalidConfiguration()
  }
}

export async function run(options: RunOptions): Promise<ExitCode> {
  let iterator: AsyncIterator<Uint8Array> | undefined
  let heartbeat: unknown
  let rpc: RpcClient | undefined
  try {
    const identity = parseArgv(options.argv)
    iterator = options.transport.input[Symbol.asyncIterator]()
    const reader = new ControllerReader(iterator)
    await write(options.transport, {
      v: AgentProcessProtocol.VERSION,
      id: options.nextID(),
      type: "hello",
      ...identity,
    })
    const accepted = await waitForAccepted(reader, options.clock)
    await write(options.transport, { v: AgentProcessProtocol.VERSION, id: options.nextID(), type: "ready" })

    const shutdown = deferred<string>()
    const internalFault = deferred<never>()
    rpc = makeRpcClient({
      nextID: options.nextID,
      send: (frame) => write(options.transport, frame),
    })
    heartbeat = options.clock.setInterval(() => {
      void Promise.resolve()
        .then(() =>
          write(options.transport, {
            v: AgentProcessProtocol.VERSION,
            id: options.nextID(),
            type: "heartbeat",
          }),
        )
        .catch((error) => internalFault.reject(error))
    }, accepted.heartbeatMs)

    const reading = readController(reader, rpc, shutdown)
    const role = Promise.resolve().then(() =>
      options.runRole({
        identity,
        shutdown: shutdown.promise,
        modelStream: (payload, onEvent) => rpc!.request("model.stream", payload, { onEvent }),
        complete: (payload) => rpc!.request("process.complete", payload),
      }),
    )
    const result = await Promise.race([
      role.then(
        () => (rpc!.completeAcknowledged ? EXIT_OK : shutdown.settled ? EXIT_PROTOCOL : EXIT_INTERNAL),
        () => EXIT_INTERNAL,
      ),
      reading.then(
        () => EXIT_PROTOCOL,
        (error) => (error instanceof AgentProcessProtocol.ProtocolError ? EXIT_PROTOCOL : EXIT_INTERNAL),
      ),
      internalFault.promise.then(
        () => EXIT_INTERNAL,
        () => EXIT_INTERNAL,
      ),
    ])
    return result
  } catch (error) {
    return error instanceof AgentProcessProtocol.ProtocolError ? EXIT_PROTOCOL : EXIT_INTERNAL
  } finally {
    if (heartbeat !== undefined) options.clock.clearInterval(heartbeat)
    rpc?.close(new AgentProcessProtocol.ProtocolError({ code: "INVALID_FRAME", message: "Adaptive process stopped" }))
    await options.transport.cancelInput()
    await iterator?.return?.()
  }
}

async function waitForAccepted(reader: ControllerReader, clock: Clock) {
  const timeout = deferred<never>()
  const handle = clock.setTimeout(
    () =>
      timeout.reject(
        new AgentProcessProtocol.ProtocolError({
          code: "INVALID_FRAME",
          message: "Adaptive process accepted timeout",
        }),
      ),
    ACCEPTED_TIMEOUT_MS,
  )
  try {
    const frame = await Promise.race([reader.next(), timeout.promise])
    if (!frame || frame.type !== "accepted") {
      throw new AgentProcessProtocol.ProtocolError({
        code: "INVALID_FRAME",
        message: "Invalid adaptive process handshake",
      })
    }
    return frame
  } finally {
    clock.clearTimeout(handle)
  }
}

async function readController(reader: ControllerReader, rpc: RpcClient, shutdown: ReturnType<typeof deferred<string>>) {
  while (true) {
    const frame = await reader.next()
    if (!frame) return
    if (frame.type === "accepted") {
      throw new AgentProcessProtocol.ProtocolError({
        code: "INVALID_FRAME",
        message: "Invalid adaptive process handshake repetition",
      })
    }
    if (frame.type === "shutdown") {
      shutdown.resolve(frame.reason)
      rpc.close(
        new AgentProcessProtocol.ProtocolError({
          code: "INVALID_FRAME",
          message: "Adaptive process shutdown before completion",
        }),
      )
      return
    }
    rpc.receive(frame)
  }
}

class ControllerReader {
  readonly #iterator: AsyncIterator<Uint8Array>
  readonly #decoder = AgentProcessProtocol.makeDecoder("controller-to-child")
  readonly #frames: AgentProcessProtocol.ControllerToChild[] = []

  constructor(iterator: AsyncIterator<Uint8Array>) {
    this.#iterator = iterator
  }

  async next(): Promise<AgentProcessProtocol.ControllerToChild | undefined> {
    const queued = this.#frames.shift()
    if (queued) return queued
    while (true) {
      const chunk = await this.#iterator.next()
      if (chunk.done) {
        this.#decoder.finish()
        return undefined
      }
      this.#frames.push(...this.#decoder.push(chunk.value))
      const frame = this.#frames.shift()
      if (frame) return frame
    }
  }
}

function deferred<A>() {
  let resolvePromise!: (value: A) => void
  let rejectPromise!: (error: unknown) => void
  let settled = false
  const promise = new Promise<A>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return {
    promise,
    get settled() {
      return settled
    },
    resolve(value: A) {
      if (settled) return
      settled = true
      resolvePromise(value)
    },
    reject(error: unknown) {
      if (settled) return
      settled = true
      rejectPromise(error)
    },
  }
}

async function write(transport: Transport, frame: AgentProcessProtocol.ChildToController) {
  await transport.write(AgentProcessProtocol.encode(frame))
}

function invalidConfiguration() {
  return new AgentProcessProtocol.ProtocolError({
    code: "INVALID_FRAME",
    message: "Invalid adaptive process configuration",
  })
}

export const systemClock: Clock = {
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
}

export function stdioTransport(): Transport {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  return {
    input: {
      async *[Symbol.asyncIterator]() {
        const active = Bun.stdin.stream().getReader()
        reader = active
        try {
          while (true) {
            const chunk = await active.read()
            if (chunk.done) return
            yield chunk.value
          }
        } finally {
          if (reader === active) reader = undefined
          active.releaseLock()
        }
      },
    },
    write: (chunk) => Bun.stdout.write(chunk),
    cancelInput: () => reader?.cancel(),
  }
}

export async function runStdio(
  runRole: (context: RoleContext) => Promise<void>,
  argv: readonly string[] = process.argv.slice(2),
) {
  const code = await run({
    argv,
    transport: stdioTransport(),
    clock: systemClock,
    nextID: () => crypto.randomUUID(),
    runRole,
  })
  process.exitCode = code
  return code
}

export * as AgentEntry from "./agent-entry"
