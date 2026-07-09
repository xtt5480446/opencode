export * as HttpTelemetry from "./http"

import { Cause, Clock, Effect, Exit, Option } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
  ATTR_OPENCODE_ERROR_SOURCE,
  ATTR_OPENCODE_ERROR_STAGE,
} from "./semconv"
import { ToolTelemetry } from "./tool"
import { AgentTelemetry } from "./agent"

export const use = <A, E, R>(
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  consume: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>,
  validate?: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
): Effect.Effect<A, E | HttpClientError.HttpClientError, R> =>
  Effect.gen(function* () {
    const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.catchCauseIf(
        effect,
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.void,
      )
    const state: { responseStatus?: number } = {}
    const execute = http.execute(request).pipe(
      Effect.flatMap(validate ?? Effect.succeed),
      Effect.tap((response) => Effect.sync(() => (state.responseStatus = response.status))),
      Effect.flatMap(consume),
    )
    const parent =
      (yield* ToolTelemetry.currentSpan) ??
      (yield* AgentTelemetry.currentSpan) ??
      Option.getOrUndefined(yield* Effect.option(Effect.currentSpan))
    if (!parent) return yield* execute
    const url = URL.canParse(request.url) ? new URL(request.url) : undefined
    const port = url?.port
      ? Number(url.port)
      : url?.protocol === "https:"
        ? 443
        : url?.protocol === "http:"
          ? 80
          : undefined
    const span = yield* Effect.makeSpan(request.method, {
      kind: "client",
      parent,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: request.method,
        ...(url
          ? {
              [ATTR_SERVER_ADDRESS]: url.hostname,
              ...(port === undefined ? {} : { [ATTR_SERVER_PORT]: port }),
              [ATTR_URL_FULL]: safeUrl(url),
              [ATTR_URL_PATH]: url.pathname,
              [ATTR_URL_SCHEME]: url.protocol.slice(0, -1),
            }
          : {}),
      },
    }).pipe(
      Effect.withTracerEnabled(true),
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (!span) return yield* execute
    return yield* execute.pipe(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.onExit((exit) =>
        observe(
          Effect.gen(function* () {
            if (state.responseStatus !== undefined)
              span.attribute(ATTR_HTTP_RESPONSE_STATUS_CODE, state.responseStatus)
            if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) {
              span.end(yield* Clock.currentTimeNanos, exit)
              return
            }
            const error = Option.getOrUndefined(Exit.findErrorOption(exit))
            const type = HttpClientError.isHttpClientError(error)
              ? error.reason._tag
              : error instanceof Error
                ? error.name
                : "unknown"
            const status =
              HttpClientError.isHttpClientError(error) && "response" in error.reason
                ? error.reason.response.status
                : undefined
            if (status !== undefined) span.attribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status)
            span.attribute(ATTR_ERROR_TYPE, type)
            span.attribute(ATTR_OPENCODE_ERROR_SOURCE, "transport")
            span.attribute(
              ATTR_OPENCODE_ERROR_STAGE,
              status !== undefined ? "response" : state.responseStatus !== undefined ? "response_stream" : "request",
            )
            span.end(yield* Clock.currentTimeNanos, Exit.fail(new Error(type)))
          }),
        ),
      ),
      Effect.withParentSpan(span, { captureStackTrace: false }),
      Effect.withTracerEnabled(false),
    )
  })

function safeUrl(url: URL) {
  const safe = new URL(url)
  safe.username = ""
  safe.password = ""
  safe.search = ""
  safe.hash = ""
  return safe.toString()
}
