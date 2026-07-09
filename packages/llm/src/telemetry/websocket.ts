export * as LLMWebSocketTelemetry from "./websocket"

import { Cause, Clock, Effect, Exit, Option, References, Stream } from "effect"
import { ParentSpan, type Span } from "effect/Tracer"
import {
  ATTR_ERROR_TYPE,
  ATTR_NETWORK_PROTOCOL_NAME,
  ATTR_NETWORK_TRANSPORT,
  ATTR_OPENCODE_ERROR_SOURCE,
  ATTR_OPENCODE_ERROR_STAGE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from "../semconv"
import { LLMError } from "../schema"
import { safeUrl } from "./http"
import { currentModelSpan } from "./context"

export { RequestIssued, ResponseChunkReceived } from "./http"

const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchCauseIf(
    effect,
    (cause) => !Cause.hasInterrupts(cause),
    () => Effect.void,
  )

export const stream = <A, R>(urlValue: string, source: Stream.Stream<A, LLMError, R>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const parent = yield* currentModelSpan
      if (!parent) return source
      const url = URL.canParse(urlValue) ? new URL(urlValue) : undefined
      const port = url?.port
        ? Number(url.port)
        : url?.protocol === "wss:"
          ? 443
          : url?.protocol === "ws:"
            ? 80
            : undefined
      const span = yield* Effect.makeSpan("websocket.exchange", {
        kind: "client",
        parent,
        attributes: {
          [ATTR_NETWORK_PROTOCOL_NAME]: "websocket",
          [ATTR_NETWORK_TRANSPORT]: "tcp",
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
      })
      const state: State = {}
      yield* Effect.addFinalizer((exit) => observe(finalize(span, state, exit)))
      return observeStream(span, state, source)
    }).pipe(
      Effect.withTracerEnabled(true),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        () => Effect.succeed(source),
      ),
    ),
  )

type State = { terminal?: Exit.Exit<void, unknown> }

function observeStream<A, R>(span: Span, state: State, source: Stream.Stream<A, LLMError, R>) {
  const terminate = (exit: Exit.Exit<void, unknown>, type?: string) => {
    if (state.terminal) return
    state.terminal = exit
    if (type) span.attribute(ATTR_ERROR_TYPE, type)
  }
  return source.pipe(
    Stream.tapCause((cause) =>
      observe(
        Effect.gen(function* () {
          const error = Option.getOrUndefined(Cause.findErrorOption(cause))
          if (Cause.hasInterruptsOnly(cause)) {
            terminate(Exit.failCause(cause))
            return
          }
          const type = error?.reason._tag ?? "unknown"
          span.attribute(
            ATTR_OPENCODE_ERROR_SOURCE,
            error?.reason._tag === "Transport"
              ? "transport"
              : error?.reason._tag === "InvalidProviderOutput"
                ? "protocol"
                : "provider",
          )
          span.attribute(ATTR_OPENCODE_ERROR_STAGE, "websocket")
          terminate(Exit.fail(new Error(type)), type)
        }),
      ),
    ),
    Stream.provideService(ParentSpan, span),
    Stream.provideService(References.TracerEnabled, false),
  )
}

function finalize(span: Span, state: State, scopeExit: Exit.Exit<unknown, unknown>) {
  return Effect.gen(function* () {
    if (!state.terminal) {
      state.terminal = Exit.isFailure(scopeExit) && Cause.hasInterruptsOnly(scopeExit.cause)
        ? Exit.failCause(scopeExit.cause)
        : Exit.void
    }
    span.end(yield* Clock.currentTimeNanos, state.terminal)
  })
}
