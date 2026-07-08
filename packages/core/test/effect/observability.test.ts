import { afterEach, describe, expect, test } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_OPENCODE_ERROR_SOURCE,
  ATTR_OPENCODE_ERROR_STAGE,
  ATTR_OPENCODE_LINK_TYPE,
  ATTR_OPENCODE_CLIENT,
  ATTR_OPENCODE_RUN,
  ATTR_OPENCODE_TOOL_OUTCOME,
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAMESPACE,
  ATTR_URL_FULL,
} from "@opencode-ai/core/observability/semconv"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Tracer } from "effect"
import { ParentSpan, type Span } from "effect/Tracer"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileLogger } from "../../src/observability/logging"
import { resource } from "../../src/observability/otlp"
import { SessionTelemetry } from "../../src/observability/session"
import { HttpTelemetry } from "../../src/observability/http"
import { AgentTelemetry } from "../../src/observability/agent"
import { ToolTelemetry } from "../../src/observability/tool"
import { it } from "../lib/effect"

const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES
const opencodeClient = process.env.OPENCODE_CLIENT

afterEach(() => {
  if (otelResourceAttributes === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
  else process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes

  if (opencodeClient === undefined) delete process.env.OPENCODE_CLIENT
  else process.env.OPENCODE_CLIENT = opencodeClient
})

describe("resource", () => {
  test("parses and decodes OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = `${ATTR_SERVICE_NAMESPACE}=anomalyco,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here`

    expect(resource().attributes).toMatchObject({
      "service.namespace": "anomalyco",
      team: "platform,observability",
      label: "hello=world",
      "key/name": "value here",
    })
  })

  test("drops OTEL resource attributes when any entry is invalid", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = `${ATTR_SERVICE_NAMESPACE}=anomalyco,broken`

    expect(resource().attributes[ATTR_SERVICE_NAMESPACE]).toBeUndefined()
    expect(resource().attributes[ATTR_OPENCODE_CLIENT]).toBeDefined()
  })

  test("keeps built-in attributes when env values conflict", () => {
    process.env.OPENCODE_CLIENT = "cli"
    process.env.OTEL_RESOURCE_ATTRIBUTES = `${ATTR_OPENCODE_CLIENT}=web,${ATTR_SERVICE_INSTANCE_ID}=override,${ATTR_SERVICE_NAMESPACE}=anomalyco`

    expect(resource().attributes).toMatchObject({
      [ATTR_OPENCODE_CLIENT]: "cli",
      [ATTR_SERVICE_NAMESPACE]: "anomalyco",
    })
    expect(resource().attributes[ATTR_SERVICE_INSTANCE_ID]).not.toBe("override")
    expect(resource().attributes[ATTR_OPENCODE_RUN]).toMatch(/^[0-9a-f]{8}$/)
  })

  test("uses deployment environment from OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = `${ATTR_DEPLOYMENT_ENVIRONMENT_NAME}=development`

    expect(resource().attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]).toBe("development")
  })
})

it.effect("retains an execution trace parent until the execution settles", () =>
  Effect.gen(function* () {
    const telemetry = SessionTelemetry.makeExecution<string>()
    const started = yield* Deferred.make<void>()
    let parent: Span | undefined

    yield* Effect.useSpan("parent", (span) =>
      Effect.gen(function* () {
        parent = span
        const joiner = yield* telemetry
          .resume("session", Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.provideService(SessionTelemetry.TraceParent, span), Effect.forkChild)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(joiner)
      }),
    )

    const retained = Option.getOrUndefined(yield* telemetry.drain("session", Effect.serviceOption(ParentSpan)))
    expect(retained).toBe(parent)

    yield* telemetry.settled("session")
    const released = Option.getOrUndefined(yield* telemetry.drain("session", Effect.serviceOption(ParentSpan)))
    expect(released).toBeUndefined()
  }),
)

it.effect("retains an external ambient trace parent", () =>
  Effect.gen(function* () {
    const telemetry = SessionTelemetry.makeExecution<string>()
    const parent = Tracer.externalSpan({ traceId: "1".repeat(32), spanId: "2".repeat(16) })

    yield* telemetry.resume("session", Effect.void).pipe(Effect.withParentSpan(parent))
    const retained = Option.getOrUndefined(yield* telemetry.drain("session", Effect.serviceOption(ParentSpan)))

    expect(retained).toBe(parent)
  }),
)

it.effect("detaches a top-level execution from its acquisition parent", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const telemetry = SessionTelemetry.makeExecution<string>()

    yield* Effect.useSpan("startup", () =>
      telemetry.drain(
        "session",
        AgentTelemetry.invoke({ sessionID: "session", agent: "build", errorType: () => "unknown" }, Effect.void),
      ),
    ).pipe(Effect.provideService(Tracer.Tracer, tracer))

    expect(spans.find((span) => span.name === "invoke_agent build")?.parent._tag).toBe("None")
  }),
)

it.effect("links a detached execution to its spawning span", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const telemetry = SessionTelemetry.makeExecution<string>()

    yield* Effect.useSpan("execute_tool subagent", (parent) =>
      telemetry
        .resume("session", Effect.void)
        .pipe(
          Effect.provideService(SessionTelemetry.TraceParent, null),
          Effect.provideService(SessionTelemetry.TraceLinks, [{ span: parent, attributes: {} }]),
        ),
    ).pipe(Effect.provideService(Tracer.Tracer, tracer))
    yield* telemetry
      .drain(
        "session",
        AgentTelemetry.invoke({ sessionID: "session", agent: "explore", errorType: () => "unknown" }, Effect.void),
      )
      .pipe(Effect.provideService(Tracer.Tracer, tracer))

    const parent = spans.find((span) => span.name === "execute_tool subagent")
    const child = spans.find((span) => span.name === "invoke_agent explore")
    expect(child?.parent._tag).toBe("None")
    expect(child?.links).toHaveLength(1)
    expect(child?.links[0]?.span).toBe(parent)
  }),
)

it.effect("links each agent turn to the previous Session turn", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const telemetry = SessionTelemetry.makeExecution<string>()
    const run = telemetry
      .drain(
        "session",
        AgentTelemetry.invoke({ sessionID: "session", agent: "build", errorType: () => "unknown" }, Effect.void),
      )
      .pipe(Effect.provideService(Tracer.Tracer, tracer))

    yield* run
    yield* telemetry.settled("session")
    yield* run

    const turns = spans.filter((span) => span.name === "invoke_agent build")
    expect(turns).toHaveLength(2)
    expect(turns[1]?.links).toHaveLength(1)
    expect(turns[1]?.links[0]?.span).toBe(turns[0])
    expect(turns[1]?.links[0]?.attributes[ATTR_OPENCODE_LINK_TYPE]).toBe("previous_turn")
  }),
)

it.effect("keeps previous-turn links isolated by Session", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const telemetry = SessionTelemetry.makeExecution<string>()
    const run = (sessionID: string) =>
      telemetry
        .drain(
          sessionID,
          AgentTelemetry.invoke({ sessionID, agent: "build", errorType: () => "unknown" }, Effect.void),
        )
        .pipe(Effect.provideService(Tracer.Tracer, tracer))

    yield* run("a")
    yield* run("b")
    yield* run("a")

    const a = spans.filter((span) => span.attributes.get(ATTR_GEN_AI_CONVERSATION_ID) === "a")
    const b = spans.filter((span) => span.attributes.get(ATTR_GEN_AI_CONVERSATION_ID) === "b")
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(1)
    expect(a[1]?.links[0]?.span).toBe(a[0])
    expect(b[0]?.links).toEqual([])
  }),
)

it.effect("closes an active agent span when its execution scope is interrupted", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const started = yield* Deferred.make<void>()

    yield* Effect.gen(function* () {
      const fiber = yield* AgentTelemetry.invoke(
        { sessionID: "session", agent: "build", errorType: () => "unknown" },
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.provideService(SessionTelemetry.TraceParent, null), Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provideService(Tracer.Tracer, tracer))

    const span = spans.find((span) => span.name === "invoke_agent build")
    expect(span?.attributes.get(ATTR_ERROR_TYPE)).toBe("canceled")
    expect(span?.status._tag === "Ended" && span.status.exit._tag).toBe("Failure")
  }),
)

it.effect("classifies a tool cause containing interruption as canceled", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const cause = Cause.fromReasons([
      Cause.makeFailReason(new Error("concurrent failure")),
      Cause.makeInterruptReason(),
    ])

    const exit = yield* ToolTelemetry.execute(
      { sessionID: "session", agent: "explore", call: { id: "call", name: "read" } },
      Effect.failCause(cause),
      () => "tool.execution",
    ).pipe(Effect.exit, Effect.provideService(Tracer.Tracer, tracer))

    const span = spans.find((span) => span.name === "execute_tool read")
    expect(span?.attributes.get(ATTR_ERROR_TYPE)).toBe("canceled")
    expect(span?.attributes.get(ATTR_OPENCODE_ERROR_SOURCE)).toBe("cancellation")
    expect(span?.attributes.get(ATTR_OPENCODE_ERROR_STAGE)).toBe("execution")
    expect(span?.attributes.get(ATTR_OPENCODE_TOOL_OUTCOME)).toBe("canceled")
    expect(span?.status._tag === "Ended" && span.status.exit._tag).toBe("Failure")
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBeTrue()
    expect(Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined).toBeInstanceOf(
      Error,
    )
  }),
)

it.effect("applies HTTP response validation without a parent span", () =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get("https://example.test/missing")
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("missing", { status: 404 }))),
    )

    const exit = yield* HttpTelemetry.use(
      http,
      request,
      Effect.succeed,
      HttpClientResponse.filterStatusOk,
    ).pipe(Effect.exit)

    expect(exit._tag).toBe("Failure")
  }),
)

it.effect("omits URL credentials, query, and fragment without changing the request", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })
    const url = "https://user:password@example.test/path?region=us-east-1#fragment"
    let executedUrl: string | undefined
    const request = HttpClientRequest.get(url)
    const http = HttpClient.make((request) => {
      executedUrl = request.url
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok")))
    })

    yield* HttpTelemetry.use(http, request, Effect.succeed).pipe(
      Effect.withSpan("execute_tool webfetch"),
      Effect.provideService(Tracer.Tracer, tracer),
    )

    expect(executedUrl).toBe(url)
    expect(spans.find((span) => span.name === "GET")?.attributes.get(ATTR_URL_FULL)).toBe(
      "https://example.test/path",
    )
  }),
)

test("falls back to local logging when OTLP initialization fails", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-observability-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
        import { Effect } from "effect"
        import { Observability } from "./src/observability.ts"
        await Effect.void.pipe(Effect.provide(Observability.layer), Effect.scoped, Effect.runPromise)
      `,
    ],
    {
      cwd: path.join(import.meta.dir, "../.."),
      env: {
        ...process.env,
        OTEL_EXPORTER_OTLP_ENDPOINT: "://invalid",
        XDG_CACHE_HOME: path.join(dir, "cache"),
        XDG_CONFIG_HOME: path.join(dir, "config"),
        XDG_DATA_HOME: path.join(dir, "data"),
        XDG_STATE_HOME: path.join(dir, "state"),
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])

  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
})

test("file logger appends concurrent runs with a run on every line", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")
  const write = (runID: string) =>
    Effect.forEach(
      Array.from({ length: 50 }, (_, index) => index),
      (index) => Effect.logInfo(`entry-${index}`),
    ).pipe(
      Effect.provide(Logger.layer([fileLogger(file, runID)]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
      Effect.scoped,
    )

  await Effect.runPromise(Effect.all([write("run-a"), write("run-b")], { concurrency: "unbounded" }))

  const lines = (await Bun.file(file).text()).trim().split("\n")
  expect(lines).toHaveLength(100)
  expect(lines.filter((line) => line.includes("run=run-a"))).toHaveLength(50)
  expect(lines.filter((line) => line.includes("run=run-b"))).toHaveLength(50)
  expect(lines.every((line) => line.startsWith("timestamp=") && line.includes(" level=INFO "))).toBe(true)
  expect(lines.every((line) => !line.includes(" fiber="))).toBe(true)
  expect(lines.every((line) => !line.startsWith("{"))).toBe(true)
})

test("file logger flattens nested objects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-test-"))
  await using _ = {
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
  const file = path.join(dir, "opencode.log")

  await Effect.logInfo("request complete", {
    request: { method: "GET", timing: { duration: 42 } },
    tags: ["api", "test"],
  }).pipe(
    Effect.annotateLogs({ session: { id: "session-1" } }),
    Effect.provide(Logger.layer([fileLogger(file, "run-a")]).pipe(Layer.provide(NodeFileSystem.layer), Layer.orDie)),
    Effect.scoped,
    Effect.runPromise,
  )

  const line = (await Bun.file(file).text()).trim()
  expect(line).toContain('message="request complete"')
  expect(line).toContain("request.method=GET")
  expect(line).toContain("request.timing.duration=42")
  expect(line).toContain('tags="[\\\"api\\\",\\\"test\\\"]"')
  expect(line).toContain("session.id=session-1")
  expect(line).not.toContain("request={")
})
