export * as LLMTelemetry from "./telemetry"

import { Cause, Clock, Effect, Exit, References, Stream } from "effect"
import { ParentSpan, type Span } from "effect/Tracer"
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_TYPE,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY,
  ATTR_GEN_AI_REQUEST_SEED,
  ATTR_GEN_AI_REQUEST_STOP_SEQUENCES,
  ATTR_GEN_AI_REQUEST_STREAM,
  ATTR_GEN_AI_REQUEST_TEMPERATURE,
  ATTR_GEN_AI_REQUEST_TOP_K,
  ATTR_GEN_AI_REQUEST_TOP_P,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  ATTR_OPENCODE_LLM_PROTOCOL,
  ATTR_OPENCODE_LLM_ROUTE,
  ATTR_OPENCODE_ERROR_SOURCE,
  ATTR_OPENCODE_ERROR_STAGE,
  ATTR_OPENCODE_PROVIDER_HTTP_STATUS_CODE,
  ATTR_OPENCODE_PROVIDER_REQUEST_ID,
  ATTR_OPENCODE_TRANSPORT_KIND,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  GEN_AI_OUTPUT_TYPE_VALUE_JSON,
  GEN_AI_OUTPUT_TYPE_VALUE_TEXT,
} from "./semconv"
import { LLMError, LLMEvent, type LLMRequest, type Usage } from "./schema"
import { RequestIssued, ResponseChunkReceived } from "./telemetry/http"

export { RequestIssued, ResponseChunkReceived } from "./telemetry/http"

type TelemetryState = {
  requestIssued?: bigint
  firstChunkReceived?: bigint
  usage?: Usage
  terminal?: Exit.Exit<void, Error>
}

const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchCauseIf(
    effect,
    (cause) => !Cause.hasInterrupts(cause),
    () => Effect.void,
  )

export function stream(request: LLMRequest, source: Stream.Stream<LLMEvent, LLMError>) {
  const generation = request.generation
  const operation = request.model.route.operation
  const baseURL = request.model.route.endpoint.baseURL
  const url = baseURL && URL.canParse(baseURL) ? new URL(baseURL) : undefined
  const server = serverAttributes(url)
  const outputType =
    request.responseFormat?.type === "text"
      ? GEN_AI_OUTPUT_TYPE_VALUE_TEXT
      : request.responseFormat?.type === "json"
        ? GEN_AI_OUTPUT_TYPE_VALUE_JSON
        : undefined
  const attributes = {
    [ATTR_GEN_AI_OPERATION_NAME]: operation,
    [ATTR_GEN_AI_PROVIDER_NAME]: request.model.provider,
    [ATTR_GEN_AI_REQUEST_MODEL]: request.model.id,
    [ATTR_GEN_AI_REQUEST_STREAM]: true,
    [ATTR_OPENCODE_LLM_ROUTE]: request.model.route.id,
    [ATTR_OPENCODE_LLM_PROTOCOL]: request.model.route.protocol,
    ...server,
    ...(generation?.maxTokens === undefined ? {} : { [ATTR_GEN_AI_REQUEST_MAX_TOKENS]: generation.maxTokens }),
    ...(generation?.temperature === undefined ? {} : { [ATTR_GEN_AI_REQUEST_TEMPERATURE]: generation.temperature }),
    ...(generation?.topK === undefined || !Number.isInteger(generation.topK)
      ? {}
      : { [ATTR_GEN_AI_REQUEST_TOP_K]: generation.topK }),
    ...(generation?.topP === undefined ? {} : { [ATTR_GEN_AI_REQUEST_TOP_P]: generation.topP }),
    ...(generation?.frequencyPenalty === undefined
      ? {}
      : { [ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY]: generation.frequencyPenalty }),
    ...(generation?.presencePenalty === undefined
      ? {}
      : { [ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY]: generation.presencePenalty }),
    ...(generation?.seed === undefined ? {} : { [ATTR_GEN_AI_REQUEST_SEED]: generation.seed }),
    ...(generation?.stop === undefined ? {} : { [ATTR_GEN_AI_REQUEST_STOP_SEQUENCES]: generation.stop }),
    ...(outputType === undefined ? {} : { [ATTR_GEN_AI_OUTPUT_TYPE]: outputType }),
  }
  return Stream.unwrap(
    Effect.gen(function* () {
      if (!(yield* References.TracerEnabled)) return source
      const span = yield* Effect.makeSpan(`${operation} ${request.model.id}`, {
        kind: "client",
        attributes,
      })
      const state: TelemetryState = {}
      yield* Effect.addFinalizer((exit) => observe(finalize(span, state, exit)))
      return observeStream({
        span,
        state,
        stream: source,
        stopSequences: generation?.stop,
      })
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.succeed(source),
      ),
    ),
  )
}

function observeStream(input: {
  readonly span: Span
  readonly state: TelemetryState
  readonly stream: Stream.Stream<LLMEvent, LLMError>
  readonly stopSequences?: ReadonlyArray<string>
}) {
  const terminate = (exit: Exit.Exit<void, Error>, errorType?: string) => {
    if (input.state.terminal) return false
    input.state.terminal = exit
    if (errorType) input.span.attribute(ATTR_ERROR_TYPE, errorType)
    return true
  }
  return input.stream.pipe(
    Stream.onStart(
      observe(
        Effect.sync(() => {
          if (input.stopSequences !== undefined)
            input.span.attribute(ATTR_GEN_AI_REQUEST_STOP_SEQUENCES, [...input.stopSequences])
        }),
      ),
    ),
    Stream.tap((event) =>
      observe(
        Effect.sync(() => {
          if (input.state.terminal) return
          if ("usage" in event && event.usage !== undefined) input.state.usage = event.usage
          if (LLMEvent.is.finish(event)) {
            const type = event.reason === "error" ? "provider_error" : undefined
            if (!terminate(type ? Exit.fail(new Error(type)) : Exit.void, type)) return
            const attributes = finishAttributes(event)
            for (const [key, value] of Object.entries(attributes)) input.span.attribute(key, value)
            if (type) {
              input.span.attribute(ATTR_OPENCODE_ERROR_SOURCE, "provider")
              input.span.attribute(ATTR_OPENCODE_ERROR_STAGE, "response")
            }
          }
          if (LLMEvent.is.providerError(event)) {
            const type = errorType(event)
            input.span.attribute(ATTR_OPENCODE_ERROR_SOURCE, "provider")
            input.span.attribute(ATTR_OPENCODE_ERROR_STAGE, "response")
            terminate(Exit.fail(new Error(type)), type)
          }
        }),
      ),
    ),
    Stream.tapCause((cause) =>
      observe(
        Effect.gen(function* () {
          const type = Cause.hasInterruptsOnly(cause) ? "canceled" : causeErrorType(cause)
          const error = Cause.squash(cause)
          if (error instanceof LLMError) {
            for (const [key, value] of Object.entries(llmErrorAttributes(error))) input.span.attribute(key, value)
          }
          terminate(Exit.fail(new Error(type)), type)
        }),
      ),
    ),
    Stream.provideService(ParentSpan, input.span),
    Stream.provideService(RequestIssued, (time) =>
      observe(
        Effect.sync(() => {
          input.state.requestIssued ??= time
          recordFirstChunk(input.span, input.state)
        }),
      ),
    ),
    Stream.provideService(
      ResponseChunkReceived,
      observe(
        Effect.gen(function* () {
          input.state.firstChunkReceived ??= yield* Clock.currentTimeNanos
          recordFirstChunk(input.span, input.state)
        }),
      ),
    ),
    Stream.provideService(References.TracerEnabled, false),
  )
}

function finalize(span: Span, state: TelemetryState, scopeExit: Exit.Exit<unknown, unknown>) {
  return Effect.gen(function* () {
    if (!state.terminal) {
      const type = Exit.isFailure(scopeExit) && Cause.hasInterruptsOnly(scopeExit.cause)
        ? "canceled"
        : "incomplete_response"
      span.attribute(ATTR_ERROR_TYPE, type)
      state.terminal = Exit.fail(new Error(type))
    }
    if (state.usage) {
      for (const [key, value] of Object.entries(usageAttributes(state.usage))) span.attribute(key, value)
    }
    span.end(yield* Clock.currentTimeNanos, state.terminal)
  })
}

function recordFirstChunk(span: Span, state: TelemetryState) {
  if (state.requestIssued === undefined || state.firstChunkReceived === undefined) return
  span.attribute(ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK, Number(state.firstChunkReceived - state.requestIssued) / 1e9)
}

function finishAttributes(event: Extract<LLMEvent, { readonly type: "finish" }>) {
  return {
    [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [finishReason(event.reason)],
  }
}

function finishReason(reason: Extract<LLMEvent, { readonly type: "finish" }>["reason"]) {
  if (reason === "tool-calls") return "tool_calls"
  if (reason === "content-filter") return "content_filter"
  return reason
}

function errorType(event: Extract<LLMEvent, { readonly type: "provider-error" }>) {
  if (event.classification) return event.classification
  return "provider_error"
}

function llmErrorAttributes(error: LLMError) {
  const reason = error.reason
  const http = "http" in reason ? reason.http : undefined
  const status = http?.response?.status
  const providerStream = error.method === "stream"
  const source =
    reason._tag === "Transport"
      ? "transport"
      : reason._tag === "InvalidProviderOutput"
        ? "protocol"
        : reason._tag === "NoRoute"
          ? "configuration"
          : providerStream
            ? "provider"
            : reason._tag === "InvalidRequest" && http === undefined
              ? "request"
              : reason._tag === "Authentication" && http === undefined
                ? "configuration"
                : "provider"
  const stage =
    reason._tag === "Transport"
      ? "transport"
      : reason._tag === "InvalidProviderOutput"
        ? "parse"
        : reason._tag === "NoRoute"
          ? "resolve"
          : providerStream
            ? "response"
            : http === undefined && (reason._tag === "InvalidRequest" || reason._tag === "Authentication")
              ? "compile"
              : "response"
  return {
    [ATTR_OPENCODE_ERROR_SOURCE]: source,
    [ATTR_OPENCODE_ERROR_STAGE]: stage,
    ...(status === undefined ? {} : { [ATTR_OPENCODE_PROVIDER_HTTP_STATUS_CODE]: status }),
    ...(http?.requestId === undefined ? {} : { [ATTR_OPENCODE_PROVIDER_REQUEST_ID]: http.requestId }),
    ...(reason._tag === "Transport" && reason.kind ? { [ATTR_OPENCODE_TRANSPORT_KIND]: reason.kind } : {}),
  }
}

function causeErrorType(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  if (error instanceof LLMError) return error.reason._tag
  if (error instanceof Error) return error.name
  return "unknown"
}

function usageAttributes(usage: Usage | undefined) {
  if (!usage) return {}
  return {
    ...(usage.inputTokens === undefined ? {} : { [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.outputTokens }),
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : { [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: usage.cacheReadInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { [ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: usage.cacheWriteInputTokens }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { [ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: usage.reasoningTokens }),
  }
}

function serverAttributes(url: URL | undefined) {
  if (!url) return {}
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : url.protocol === "http:" ? 80 : undefined
  return {
    [ATTR_SERVER_ADDRESS]: url.hostname,
    ...(port === undefined ? {} : { [ATTR_SERVER_PORT]: port }),
  }
}
