import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Schema } from "effect"

export const VERSION = 1 as const
export const MAX_ENCODED_FRAME_BYTES = 1_048_576
export const MAX_OUTSTANDING_RPC_CALLS = 32

export const ErrorCode = Schema.Literals([
  "INVALID_FRAME",
  "UNSUPPORTED_VERSION",
  "INVALID_NEWLINE",
  "INCOMPLETE_FRAME",
  "FRAME_TOO_LARGE",
  "RPC_LIMIT",
])
export type ErrorCode = typeof ErrorCode.Type

export class ProtocolError extends Schema.TaggedErrorClass<ProtocolError>()("AdaptiveProcessProtocolError", {
  code: ErrorCode,
  message: Schema.String,
}) {}

const FrameID = Schema.String
const Version = Schema.Literal(VERSION)
const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const HeartbeatMs = Schema.Int.check(Schema.isGreaterThan(0))
const jsonRuntimeValue = Schema.makeFilter<Schema.Json>((value) =>
  isJsonRuntimeValue(value) ? undefined : "Expected a dense JSON runtime value without custom serialization",
)

export const JsonValue = Schema.Json.check(jsonRuntimeValue).annotate({
  identifier: "AdaptiveProcessProtocol.JsonValue",
})
export type JsonValue = typeof JsonValue.Type

const Hello = Schema.Struct({
  v: Version,
  id: FrameID,
  type: Schema.Literal("hello"),
  taskID: AdaptiveTask.ID,
  agentID: AdaptiveTask.AgentID,
  generation: Generation,
  role: AdaptiveTask.Role,
})

const Ready = Schema.Struct({
  v: Version,
  id: FrameID,
  type: Schema.Literal("ready"),
})

const Heartbeat = Schema.Struct({
  v: Version,
  id: FrameID,
  type: Schema.Literal("heartbeat"),
})

const RpcRequest = Schema.Struct({
  v: Version,
  id: FrameID,
  type: Schema.Literal("rpc.request"),
  method: Schema.Literals(["model.stream", "process.complete"]),
  payload: JsonValue,
})

const RpcCancel = Schema.Struct({
  v: Version,
  id: FrameID,
  type: Schema.Literal("rpc.cancel"),
  requestID: Schema.String,
})

const Accepted = Schema.Struct({
  v: Version,
  id: FrameID,
  type: Schema.Literal("accepted"),
  heartbeatMs: HeartbeatMs,
})

const RpcResponse = Schema.Struct({
  v: Version,
  id: FrameID,
  type: Schema.Literal("rpc.response"),
  requestID: Schema.String,
  payload: JsonValue,
})

const RpcEvent = Schema.Struct({
  v: Version,
  id: FrameID,
  type: Schema.Literal("rpc.event"),
  requestID: Schema.String,
  payload: JsonValue,
})

const RpcEnd = Schema.Struct({
  v: Version,
  id: FrameID,
  type: Schema.Literal("rpc.end"),
  requestID: Schema.String,
})

const RpcError = Schema.Struct({
  v: Version,
  id: FrameID,
  type: Schema.Literal("rpc.error"),
  requestID: Schema.String,
  code: Schema.String,
  message: Schema.String,
})

const Shutdown = Schema.Struct({
  v: Version,
  id: FrameID,
  type: Schema.Literal("shutdown"),
  reason: Schema.String,
})

export const ChildToController = Schema.Union([Hello, Ready, Heartbeat, RpcRequest, RpcCancel]).annotate({
  identifier: "AdaptiveProcessProtocol.ChildToController",
})
export type ChildToController = typeof ChildToController.Type

export const ControllerToChild = Schema.Union([Accepted, RpcResponse, RpcEvent, RpcEnd, RpcError, Shutdown]).annotate({
  identifier: "AdaptiveProcessProtocol.ControllerToChild",
})
export type ControllerToChild = typeof ControllerToChild.Type

export const Frame = Schema.Union([ChildToController, ControllerToChild]).annotate({
  identifier: "AdaptiveProcessProtocol.Frame",
})
export type Frame = typeof Frame.Type

export type Direction = "child-to-controller" | "controller-to-child" | "any"
type DirectionFrame<D extends Direction> = D extends "child-to-controller"
  ? ChildToController
  : D extends "controller-to-child"
    ? ControllerToChild
    : Frame

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { fatal: true })
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)
const decodeChild = Schema.decodeUnknownSync(ChildToController)
const decodeController = Schema.decodeUnknownSync(ControllerToChild)
const decodeFrame = Schema.decodeUnknownSync(Frame)
const strict = { onExcessProperty: "error" } as const

export function encode(frame: Frame): Uint8Array {
  const validated = validate(frame, "any")
  const encoded = encodeJson(validated)
  if (encoded.byteLength > MAX_ENCODED_FRAME_BYTES) throw frameTooLarge()
  return encoded
}

export class Decoder<D extends Direction> {
  readonly #direction: D
  readonly #buffer = new Uint8Array(MAX_ENCODED_FRAME_BYTES - 1)
  #length = 0

  constructor(direction: D) {
    this.#direction = direction
  }

  get bufferedBytes() {
    return this.#length
  }

  push(input: string | Uint8Array): Array<DirectionFrame<D>> {
    const chunk = typeof input === "string" ? textEncoder.encode(input) : input
    if (chunk.includes(0x0d)) {
      this.#length = 0
      throw new ProtocolError({
        code: "INVALID_NEWLINE",
        message: "Invalid adaptive process frame newline",
      })
    }
    const frames: Array<DirectionFrame<D>> = []
    let start = 0

    for (let index = 0; index < chunk.byteLength; index++) {
      if (chunk[index] !== 0x0a) continue
      this.#append(chunk.subarray(start, index))
      frames.push(this.#read())
      start = index + 1
    }

    this.#append(chunk.subarray(start))
    return frames
  }

  finish(): Array<DirectionFrame<D>> {
    if (this.#length === 0) return []
    this.#length = 0
    throw new ProtocolError({ code: "INCOMPLETE_FRAME", message: "Incomplete adaptive process frame" })
  }

  #append(chunk: Uint8Array) {
    const encodedBytes = this.#length + chunk.byteLength + 1
    if (encodedBytes > MAX_ENCODED_FRAME_BYTES) {
      this.#length = 0
      throw frameTooLarge()
    }
    this.#buffer.set(chunk, this.#length)
    this.#length += chunk.byteLength
  }

  #read(): DirectionFrame<D> {
    const bytes = this.#buffer.slice(0, this.#length)
    this.#length = 0
    return parse(bytes, this.#direction) as DirectionFrame<D>
  }
}

export function makeDecoder<D extends Direction>(direction: D) {
  return new Decoder(direction)
}

export function decode<D extends Direction>(input: string | Uint8Array, direction: D): DirectionFrame<D>
export function decode(input: string | Uint8Array): Frame
export function decode(input: string | Uint8Array, direction: Direction = "any") {
  const decoder = makeDecoder(direction)
  const frames = decoder.push(input)
  decoder.finish()
  if (frames.length !== 1) throw invalidFrame()
  return frames[0]
}

function encodeJson(frame: Frame) {
  try {
    return textEncoder.encode(JSON.stringify(frame) + "\n")
  } catch {
    throw invalidFrame()
  }
}

function parse(bytes: Uint8Array, direction: Direction) {
  try {
    const value = decodeJson(textDecoder.decode(bytes))
    if (isUnsupportedVersion(value)) {
      throw new ProtocolError({
        code: "UNSUPPORTED_VERSION",
        message: "Unsupported adaptive process protocol",
      })
    }
    return validate(value, direction)
  } catch (error) {
    if (error instanceof ProtocolError) throw error
    throw invalidFrame()
  }
}

function validate(value: unknown, direction: Direction): Frame {
  try {
    if (direction === "child-to-controller") return decodeChild(value, strict)
    if (direction === "controller-to-child") return decodeController(value, strict)
    return decodeFrame(value, strict)
  } catch {
    throw invalidFrame()
  }
}

function isUnsupportedVersion(value: unknown) {
  return typeof value === "object" && value !== null && "v" in value && value.v !== VERSION
}

function isJsonRuntimeValue(value: Schema.Json): boolean {
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || keys.at(-1) !== "length" || "toJSON" in value) return false
    return keys.slice(0, -1).every((key, index) => {
      if (key !== String(index)) return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !!descriptor?.enumerable && "value" in descriptor && isJsonRuntimeValue(descriptor.value)
    })
  }
  if (value === null || typeof value !== "object") return typeof value !== "number" || Number.isFinite(value)
  if (
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    "toJSON" in value
  ) {
    return false
  }
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return !!descriptor?.enumerable && "value" in descriptor && isJsonRuntimeValue(descriptor.value)
  })
}

function invalidFrame() {
  return new ProtocolError({ code: "INVALID_FRAME", message: "Invalid adaptive process frame" })
}

function frameTooLarge() {
  return new ProtocolError({
    code: "FRAME_TOO_LARGE",
    message: `Adaptive process frame exceeds ${MAX_ENCODED_FRAME_BYTES} bytes`,
  })
}

export * as AgentProcessProtocol from "./protocol"
