import { describe, expect } from "bun:test"
import { Cause, Clock, Deferred, Effect, Fiber, References, Stream, Tracer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { FetchHttpClient, HttpClientRequest } from "effect/unstable/http"
import { LLM, LLMEvent, Message, Usage } from "../src"
import * as OpenAIChat from "../src/protocols/openai-chat"
import * as OpenAIResponses from "../src/protocols/openai-responses"
import { LLMClient } from "../src/route"
import { it } from "./lib/effect"
import { dynamicResponse, fixedResponse, runtimeLayer } from "./lib/http"
import { deltaChunk, usageChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_STREAM,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_TOP_K,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_OPENCODE_ERROR_SOURCE,
  ATTR_OPENCODE_ERROR_STAGE,
  ATTR_OPENCODE_LLM_PROTOCOL,
  ATTR_OPENCODE_LLM_ROUTE,
  ATTR_OPENCODE_PROVIDER_HTTP_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
} from "../src/semconv"
import { RequestIssued, ResponseChunkReceived, stream as instrument } from "../src/telemetry"
import { LLMHttpTelemetry } from "../src/telemetry/http"
import { LLMWebSocketTelemetry } from "../src/telemetry/websocket"

const ATTR_AGENT_STEP_INDEX = "test.agent.step.index"
const ATTR_AGENT_STEP_TRIGGER = "test.agent.step.trigger"

describe("GenAI telemetry", () => {
  it.effect("tracks the OpenTelemetry GenAI registry projection", () =>
    Effect.sync(() => {
      expect({
        ATTR_GEN_AI_OPERATION_NAME,
        ATTR_GEN_AI_PROVIDER_NAME,
        ATTR_GEN_AI_REQUEST_STREAM,
        ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
        ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
        GEN_AI_OPERATION_NAME_VALUE_CHAT,
      }).toMatchObject({
        ATTR_GEN_AI_OPERATION_NAME: "gen_ai.operation.name",
        ATTR_GEN_AI_PROVIDER_NAME: "gen_ai.provider.name",
        ATTR_GEN_AI_REQUEST_STREAM: "gen_ai.request.stream",
        ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK: "gen_ai.response.time_to_first_chunk",
        ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS: "gen_ai.usage.reasoning.output_tokens",
        GEN_AI_OPERATION_NAME_VALUE_CHAT: "chat",
      })
    }),
  )

  it.effect("records safe semantic convention attributes for a streaming model call", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const usage = {
        prompt_tokens: 5,
        completion_tokens: 2,
        total_tokens: 7,
        prompt_tokens_details: { cached_tokens: 1 },
        completion_tokens_details: { reasoning_tokens: 1 },
      }
      const model = OpenAIChat.route
        .with({
          endpoint: {
            baseURL: "https://api.openai.test/v1",
            query: { api_key: "secret-key", key: "short-key", sig: "signed-value" },
          },
        })
        .model({ id: "gpt-4o-mini" })
      let traceparent: string | undefined
      const request = LLM.request({
        model,
        system: "secret system prompt",
        prompt: "secret user prompt",
        generation: { maxTokens: 20, temperature: 0, topP: 0.9, topK: 40 },
      })
      const response = yield* Effect.useSpan("invoke_agent build", (agent) =>
        LLMClient.generate(request).pipe(
          Effect.provide(
            dynamicResponse((input) =>
              Effect.sync(() => {
                traceparent = input.request.headers.traceparent
                return input.respond(
                  sseEvents(
                    deltaChunk({ role: "assistant", content: "Hello" }),
                    deltaChunk({ content: " there" }),
                    deltaChunk({}, "stop"),
                    usageChunk(usage),
                  ),
                  { headers: { "content-type": "text/event-stream" } },
                )
              }),
            ),
          ),
          Effect.annotateSpans({
            [ATTR_GEN_AI_CONVERSATION_ID]: "session-1",
            [ATTR_AGENT_STEP_INDEX]: 1,
            [ATTR_AGENT_STEP_TRIGGER]: "input",
          }),
          Effect.withParentSpan(agent),
        ),
      ).pipe(Effect.provideService(Tracer.Tracer, tracer))

      const span = spans.find((span) => span.name === "chat gpt-4o-mini")
      expect(response.usage).toEqual(
        new Usage({
          inputTokens: 5,
          outputTokens: 2,
          nonCachedInputTokens: 4,
          cacheReadInputTokens: 1,
          reasoningTokens: 1,
          totalTokens: 7,
          providerMetadata: { openai: usage },
        }),
      )
      expect(span?.kind).toBe("client")
      expect(Object.fromEntries(span?.attributes ?? [])).toMatchObject({
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
        [ATTR_GEN_AI_PROVIDER_NAME]: "openai",
        [ATTR_GEN_AI_REQUEST_MODEL]: "gpt-4o-mini",
        [ATTR_GEN_AI_REQUEST_STREAM]: true,
        [ATTR_GEN_AI_REQUEST_MAX_TOKENS]: 20,
        [ATTR_GEN_AI_REQUEST_TEMPERATURE]: 0,
        [ATTR_GEN_AI_REQUEST_TOP_P]: 0.9,
        [ATTR_GEN_AI_REQUEST_TOP_K]: 40,
        [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: ["stop"],
        [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: 5,
        [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: 2,
        [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: 1,
        [ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: 1,
        [ATTR_GEN_AI_CONVERSATION_ID]: "session-1",
        [ATTR_AGENT_STEP_INDEX]: 1,
        [ATTR_AGENT_STEP_TRIGGER]: "input",
        [ATTR_SERVER_ADDRESS]: "api.openai.test",
        [ATTR_SERVER_PORT]: 443,
        [ATTR_OPENCODE_LLM_ROUTE]: "openai-chat",
        [ATTR_OPENCODE_LLM_PROTOCOL]: "openai-chat",
      })
      expect(span?.attributes.get(ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK)).toBeNumber()
      expect(span?.attributes.has(ATTR_GEN_AI_SYSTEM_INSTRUCTIONS)).toBe(false)
      expect(span?.attributes.has(ATTR_GEN_AI_INPUT_MESSAGES)).toBe(false)
      expect(span?.attributes.has(ATTR_GEN_AI_OUTPUT_MESSAGES)).toBe(false)
      expect(ancestorNames(span)).toContain("invoke_agent build")
      const http = spans.find((span) => span.attributes.get(ATTR_HTTP_REQUEST_METHOD) === "POST")
      expect(http?.name).toBe("POST")
      expect(http?.attributes.get(ATTR_HTTP_RESPONSE_STATUS_CODE)).toBe(200)
      expect(http?.attributes.get(ATTR_SERVER_PORT)).toBe(443)
      expect(http?.attributes.get(ATTR_URL_FULL)).toStartWith("https://api.openai.test/")
      expect(http?.attributes.get(ATTR_URL_FULL)).not.toContain("?")
      expect(http?.attributes.get(ATTR_URL_FULL)).not.toContain("secret-key")
      expect(http?.attributes.get(ATTR_URL_FULL)).not.toContain("short-key")
      expect(http?.attributes.get(ATTR_URL_FULL)).not.toContain("signed-value")
      expect(ancestorNames(http)).toContain("chat gpt-4o-mini")
      expect(
        span?.status._tag === "Ended" && http?.status._tag === "Ended"
          ? span.status.endTime >= http.status.endTime
          : false,
      ).toBeTrue()
      expect(traceparent).toBeUndefined()
    }),
  )

  it.effect("uses the last reported usage when finish omits it", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "gpt-4o-mini" })
      const request = LLM.request({ model, prompt: "secret" })

      yield* instrument(
        request,
        Stream.fromIterable([
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: { inputTokens: 17, outputTokens: 9 } }),
          LLMEvent.finish({ reason: "stop" }),
        ]),
      ).pipe(Stream.runDrain, Effect.provideService(Tracer.Tracer, tracer))

      const span = spans.find((span) => span.name === "chat gpt-4o-mini")
      expect(span?.attributes.get(ATTR_GEN_AI_USAGE_INPUT_TOKENS)).toBe(17)
      expect(span?.attributes.get(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS)).toBe(9)
    }),
  )

  it.effect("preserves the model stream when span creation defects", () =>
    Effect.gen(function* () {
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "broken-tracer-model" })
      const events = [LLMEvent.finish({ reason: "stop" })]
      const tracer = Tracer.make({
        span() {
          throw new Error("broken tracer")
        },
      })

      const result = yield* instrument(LLM.request({ model, prompt: "secret" }), Stream.fromIterable(events)).pipe(
        Stream.runCollect,
        Effect.provideService(Tracer.Tracer, tracer),
      )

      expect(Array.from(result)).toEqual(events)
    }),
  )

  it.effect("respects disabled tracing", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "disabled-model" })
      const events = [LLMEvent.finish({ reason: "stop" })]

      const result = yield* instrument(LLM.request({ model, prompt: "secret" }), Stream.fromIterable(events)).pipe(
        Stream.runCollect,
        Effect.provideService(References.TracerEnabled, false),
        Effect.provideService(Tracer.Tracer, tracer),
      )

      expect(Array.from(result)).toEqual(events)
      expect(spans).toHaveLength(0)
    }),
  )

  it.effect("does not create transport spans beneath a disabled model span", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "disabled-transport-model" })

      yield* Effect.useSpan("parent", () =>
        LLMClient.generate(LLM.request({ model, prompt: "secret" })).pipe(
          Effect.provide(fixedResponse(sseEvents(deltaChunk({}, "stop")))),
          Effect.withTracerEnabled(false),
        ),
      ).pipe(Effect.provideService(Tracer.Tracer, tracer))

      expect(spans.map((span) => span.name)).toEqual(["parent"])
    }),
  )

  it.effect("requires an explicit model span for transport instrumentation", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })

      yield* Effect.useSpan("ambient", () =>
        Effect.all(
          [
            LLMHttpTelemetry.stream(HttpClientRequest.post("https://example.test/path"), Stream.empty).pipe(
              Stream.runDrain,
            ),
            LLMWebSocketTelemetry.stream("wss://example.test/path", Stream.empty).pipe(Stream.runDrain),
          ],
          { discard: true },
        ),
      ).pipe(Effect.provideService(Tracer.Tracer, tracer))

      expect(spans.map((span) => span.name)).toEqual(["ambient"])
    }),
  )

  it.effect("does not attribute downstream consumer failures to transports", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "consumer-failure-model" })
      const failure = new Error("consumer failed")

      const error = yield* LLMClient.stream(LLM.request({ model, prompt: "secret" })).pipe(
        Stream.runForEach(() => Effect.fail(failure)),
        Effect.provide(fixedResponse(sseEvents(deltaChunk({ role: "assistant", content: "Hello" })))),
        Effect.flip,
        Effect.provideService(Tracer.Tracer, tracer),
      )

      expect(error).toBe(failure)
      const modelSpan = spans.find((span) => span.name === "chat consumer-failure-model")
      const httpSpan = spans.find((span) => span.attributes.get(ATTR_HTTP_REQUEST_METHOD) === "POST")
      expect(modelSpan?.attributes.get(ATTR_ERROR_TYPE)).toBe("incomplete_response")
      expect(httpSpan?.attributes.has(ATTR_ERROR_TYPE)).toBeFalse()
      expect(httpSpan?.status._tag === "Ended" && httpSpan.status.exit._tag).toBe("Success")
    }),
  )

  it.effect("closes a model span when its stream fiber is interrupted", () =>
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
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "interrupted-model" })
      const source = Stream.concat(
        Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.as(LLMEvent.stepStart({ index: 0 })))),
        Stream.never,
      )

      yield* Effect.gen(function* () {
        const fiber = yield* instrument(LLM.request({ model, prompt: "secret" }), source).pipe(
          Stream.runDrain,
          Effect.forkChild,
        )
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))

      const span = spans.find((span) => span.name === "chat interrupted-model")
      expect(span?.attributes.get(ATTR_ERROR_TYPE)).toBe("canceled")
      expect(span?.status._tag === "Ended" && span.status.exit._tag).toBe("Failure")
    }),
  )

  it.effect("measures first-chunk latency from request issuance", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "timing-model" })
      const source = Stream.concat(
        Stream.fromEffect(
          Effect.gen(function* () {
            const requestIssued = yield* RequestIssued
            if (requestIssued) yield* requestIssued(yield* Clock.currentTimeNanos)
            yield* TestClock.adjust("250 millis")
            const firstChunk = yield* ResponseChunkReceived
            if (firstChunk) yield* firstChunk
            return LLMEvent.stepStart({ index: 0 })
          }),
        ),
        Stream.succeed(LLMEvent.finish({ reason: "stop" })),
      )

      yield* instrument(LLM.request({ model, prompt: "secret" }), source).pipe(
        Stream.runDrain,
        Effect.provideService(Tracer.Tracer, tracer),
      )

      const span = spans.find((span) => span.name === "chat timing-model")
      expect(span?.attributes.get(ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK)).toBe(0.25)
    }),
  )

  it.effect("omits first-chunk latency when request issuance is unavailable", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "unknown-origin-model" })
      const source = Stream.fromIterable([LLMEvent.finish({ reason: "stop" })])

      yield* instrument(LLM.request({ model, prompt: "secret" }), source).pipe(
        Stream.runDrain,
        Effect.provideService(Tracer.Tracer, tracer),
      )

      const span = spans.find((span) => span.name === "chat unknown-origin-model")
      expect(span?.attributes.has(ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK)).toBeFalse()
    }),
  )

  it.effect("uses the semantic convention provider identity", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const model = OpenAIChat.route
        .with({ provider: "xai", endpoint: { baseURL: "https://api.x.ai/v1" } })
        .model({ id: "grok" })

      yield* instrument(
        LLM.request({ model, prompt: "secret" }),
        Stream.fromIterable([LLMEvent.finish({ reason: "stop" })]),
      ).pipe(Stream.runDrain, Effect.provideService(Tracer.Tracer, tracer))

      expect(spans.find((span) => span.name === "chat grok")?.attributes.get(ATTR_GEN_AI_PROVIDER_NAME)).toBe("x_ai")
    }),
  )

  it.effect("finalizes duplicate terminal events once", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "duplicate-terminal-model" })
      const usage = new Usage({ inputTokens: 5, outputTokens: 2 })
      const duplicateUsage = new Usage({ inputTokens: 99, outputTokens: 99 })

      yield* instrument(
        LLM.request({ model, prompt: "secret" }),
        Stream.fromIterable([
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
          LLMEvent.finish({ reason: "stop", usage }),
          LLMEvent.finish({ reason: "length", usage: duplicateUsage }),
        ]),
      ).pipe(Stream.runDrain, Effect.provideService(Tracer.Tracer, tracer))

      const span = spans.find((span) => span.name === "chat duplicate-terminal-model")
      expect(span?.attributes.get(ATTR_GEN_AI_RESPONSE_FINISH_REASONS)).toEqual(["stop"])
      expect(span?.attributes.get(ATTR_GEN_AI_USAGE_INPUT_TOKENS)).toBe(5)
      expect(span?.status._tag === "Ended" && span.status.exit._tag).toBe("Success")
    }),
  )

  it.effect("marks error finish reasons as provider failures", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "error-finish-model" })

      yield* instrument(
        LLM.request({ model, prompt: "secret" }),
        Stream.succeed(LLMEvent.finish({ reason: "error" })),
      ).pipe(Stream.runDrain, Effect.provideService(Tracer.Tracer, tracer))

      const span = spans.find((span) => span.name === "chat error-finish-model")
      expect(span?.attributes.get(ATTR_ERROR_TYPE)).toBe("provider_error")
      expect(span?.attributes.get(ATTR_OPENCODE_ERROR_SOURCE)).toBe("provider")
      expect(span?.status._tag === "Ended" && span.status.exit._tag).toBe("Failure")
    }),
  )

  it.live("does not mutate provider request headers", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const received: { traceparent?: string; b3?: string } = {}
        const server = Bun.serve({
          port: 0,
          fetch(request) {
            received.traceparent = request.headers.get("traceparent") ?? undefined
            received.b3 = request.headers.get("b3") ?? undefined
            return new Response(
              sseEvents(deltaChunk({ role: "assistant", content: "Hello" }), deltaChunk({}, "stop")),
              {
                headers: { "content-type": "text/event-stream" },
              },
            )
          },
        })
        return { received, server }
      }),
      ({ received, server }) =>
        Effect.gen(function* () {
          const spans: Tracer.NativeSpan[] = []
          const tracer = Tracer.make({
            span(options) {
              const span = new Tracer.NativeSpan(options)
              spans.push(span)
              return span
            },
          })
          const model = OpenAIChat.route
            .with({ endpoint: { baseURL: new URL("v1", server.url).toString() } })
            .model({ id: "gpt-4o-mini" })

          yield* LLMClient.generate(LLM.request({ model, prompt: "secret" })).pipe(
            Effect.provide(runtimeLayer(FetchHttpClient.layer)),
            Effect.withSpan("invoke_agent build"),
            Effect.provideService(Tracer.Tracer, tracer),
          )

          const http = spans.find((span) => span.attributes.get(ATTR_HTTP_REQUEST_METHOD) === "POST")
          expect(http).toBeDefined()
          expect(received.traceparent).toBeUndefined()
          expect(received.b3).toBeUndefined()
        }),
      ({ server }) => Effect.promise(() => server.stop(true)),
    ),
  )

  it.effect("marks structured provider failures with safe span errors", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const model = OpenAIResponses.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "gpt-4o-mini" })

      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "secret" })).pipe(
        Effect.provide(fixedResponse(sseEvents({ type: "error", code: "overloaded", message: "try later" }))),
        Effect.provideService(Tracer.Tracer, tracer),
      )

      const span = spans.find((span) => span.name === "chat gpt-4o-mini")
      expect(response.finishReason).toBe("error")
      expect(span?.attributes.get(ATTR_ERROR_TYPE)).toBe("provider_error")
      expect(span?.attributes.get(ATTR_OPENCODE_ERROR_SOURCE)).toBe("provider")
      expect(span?.attributes.get(ATTR_OPENCODE_ERROR_STAGE)).toBe("response")
      expect(span?.attributes.has(ATTR_GEN_AI_RESPONSE_FINISH_REASONS)).toBeFalse()
      expect(span?.status._tag).toBe("Ended")
      expect(span?.status._tag === "Ended" && span.status.exit._tag).toBe("Failure")
      expect(spanFailure(span)?.message).toBe("provider_error")
      expect(spanFailure(span)?.message).not.toContain("try later")
    }),
  )

  it.effect("records request compilation failures only on the model span", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "gpt-4o-mini" })

      yield* LLMClient.generate(
        LLM.request({
          model,
          messages: [Message.assistant({ type: "media", mediaType: "image/png", data: "aGVsbG8=" })],
        }),
      ).pipe(Effect.provide(fixedResponse("")), Effect.flip, Effect.provideService(Tracer.Tracer, tracer))

      const span = spans.find((span) => span.name === "chat gpt-4o-mini")
      expect(span?.attributes.get(ATTR_ERROR_TYPE)).toBe("InvalidRequest")
      expect(span?.attributes.get(ATTR_OPENCODE_ERROR_SOURCE)).toBe("request")
      expect(span?.attributes.get(ATTR_OPENCODE_ERROR_STAGE)).toBe("compile")
      expect(span?.status._tag === "Ended" && span.status.exit._tag).toBe("Failure")
      expect(spans.some((span) => span.name === "LLM.compile")).toBeFalse()
    }),
  )

  it.effect("marks HTTP failures and incomplete model streams", () =>
    Effect.gen(function* () {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "gpt-4o-mini" })
      const request = LLM.request({ model, prompt: "secret" })

      yield* LLMClient.generate(request).pipe(
        Effect.provide(fixedResponse("bad request", { status: 400 })),
        Effect.flip,
        Effect.provideService(Tracer.Tracer, tracer),
      )
      const failed = spans.find((span) => span.name === "chat gpt-4o-mini")
      expect(failed?.attributes.get(ATTR_ERROR_TYPE)).toBe("InvalidRequest")
      expect(failed?.attributes.get(ATTR_OPENCODE_ERROR_SOURCE)).toBe("provider")
      expect(failed?.attributes.get(ATTR_OPENCODE_PROVIDER_HTTP_STATUS_CODE)).toBe(400)
      expect(failed?.status._tag === "Ended" && failed.status.exit._tag).toBe("Failure")
      expect(spanFailure(failed)?.message).toBe("InvalidRequest")
      expect(spanFailure(failed)?.message).not.toContain("bad request")
      const failedHttp = spans.find((span) => span.attributes.get(ATTR_HTTP_REQUEST_METHOD) === "POST")
      expect(failedHttp?.attributes.get(ATTR_ERROR_TYPE)).toBe("InvalidRequest")
      expect(spanFailure(failedHttp)?.message).toBe("InvalidRequest")

      spans.length = 0
      yield* LLMClient.stream(request).pipe(
        Stream.take(1),
        Stream.runDrain,
        Effect.provide(fixedResponse(sseEvents(deltaChunk({ role: "assistant", content: "Hello" })))),
        Effect.provideService(Tracer.Tracer, tracer),
      )
      const canceled = spans.find((span) => span.name === "chat gpt-4o-mini")
      expect(canceled?.attributes.get(ATTR_ERROR_TYPE)).toBe("incomplete_response")
      expect(canceled?.status._tag === "Ended" && canceled.status.exit._tag).toBe("Failure")
      const canceledHttp = spans.find((span) => span.attributes.get(ATTR_HTTP_REQUEST_METHOD) === "POST")
      expect(canceledHttp?.attributes.has(ATTR_ERROR_TYPE)).toBeFalse()
      expect(canceledHttp?.status._tag === "Ended" && canceledHttp.status.exit._tag).toBe("Success")
    }),
  )
})

function ancestorNames(span: Tracer.NativeSpan | undefined) {
  const names: string[] = []
  let current = span?.parent._tag === "Some" ? span.parent.value : undefined
  while (current?._tag === "Span") {
    names.push(current.name)
    current = current.parent._tag === "Some" ? current.parent.value : undefined
  }
  return names
}

function spanFailure(span: Tracer.NativeSpan | undefined) {
  if (span?.status._tag !== "Ended" || span.status.exit._tag !== "Failure") return
  const failure = Cause.squash(span.status.exit.cause)
  return failure instanceof Error ? failure : undefined
}
