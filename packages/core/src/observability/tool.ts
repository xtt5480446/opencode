export * as ToolTelemetry from "./tool"

import { Cause, Clock, Effect, Exit, Option } from "effect"
import type { Span } from "effect/Tracer"
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_OPENCODE_ERROR_SOURCE,
  ATTR_OPENCODE_ERROR_STAGE,
  ATTR_OPENCODE_LINK_TYPE,
  ATTR_OPENCODE_SESSION_PARENT_ID,
  ATTR_OPENCODE_SUBAGENT_AGENT_NAME,
  ATTR_OPENCODE_SUBAGENT_SESSION_ID,
  ATTR_OPENCODE_TOOL_OUTCOME,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
} from "./semconv"
import { AgentTelemetry } from "./agent"
import { SessionTelemetry } from "./session"

export const currentSpan = Effect.option(Effect.currentSpan).pipe(
  Effect.map(Option.getOrUndefined),
  Effect.map(findToolSpan),
)

const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchCauseIf(
    effect,
    (cause) => !Cause.hasInterrupts(cause),
    () => Effect.void,
  )

export const execute = <A, E, R>(
  input: {
    readonly sessionID: string
    readonly agent: string
    readonly call: { readonly id: string; readonly name: string }
  },
  effect: Effect.Effect<A, E, R>,
  errorType: (cause: unknown) => string,
  resultErrorType?: (result: A) => string | undefined,
) =>
  Effect.gen(function* () {
    const toolSpan = yield* currentSpan
    const agentSpan = yield* AgentTelemetry.currentSpan
    const parent = toolSpan ?? agentSpan
    const parentSessionID = agentSpan?.attributes.get(ATTR_OPENCODE_SESSION_PARENT_ID)
    const span = yield* Effect.makeSpan(`execute_tool ${input.call.name}`, {
      kind: "internal",
      parent,
      attributes: {
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
        [ATTR_GEN_AI_TOOL_NAME]: input.call.name,
        [ATTR_GEN_AI_TOOL_TYPE]: "function",
        [ATTR_GEN_AI_TOOL_CALL_ID]: input.call.id,
        [ATTR_GEN_AI_AGENT_NAME]: input.agent,
        [ATTR_GEN_AI_CONVERSATION_ID]: input.sessionID,
        ...(typeof parentSessionID === "string" ? { [ATTR_OPENCODE_SESSION_PARENT_ID]: parentSessionID } : {}),
      },
    }).pipe(
      Effect.withTracerEnabled(true),
      Effect.catchCause(() => Effect.succeed(undefined)),
    )
    if (!span) return yield* effect
    return yield* effect.pipe(
      Effect.tap((settlement) =>
        observe(
          Effect.gen(function* () {
            const type = resultErrorType?.(settlement)
            span.attribute(ATTR_OPENCODE_TOOL_OUTCOME, type ? "error" : "completed")
            if (!type) return
            span.attribute(ATTR_OPENCODE_ERROR_SOURCE, "tool")
            span.attribute(ATTR_OPENCODE_ERROR_STAGE, "execution")
            span.attribute(ATTR_ERROR_TYPE, type)
            span.end(yield* Clock.currentTimeNanos, Exit.fail(new Error(type)))
          }),
        ),
      ),
      Effect.onExit((exit) => {
        if (span.status._tag === "Ended") return Effect.void
        if (Exit.isSuccess(exit))
          return observe(
            Effect.gen(function* () {
              span.end(yield* Clock.currentTimeNanos, exit)
            }),
          )
        const canceled = Cause.hasInterrupts(exit.cause)
        return observe(
          Effect.gen(function* () {
            const type = canceled
              ? "canceled"
              : yield* Effect.sync(() => errorType(Cause.squash(exit.cause))).pipe(
                  Effect.catchCause(() => Effect.succeed("unknown")),
                )
            span.attribute(ATTR_OPENCODE_TOOL_OUTCOME, canceled ? "canceled" : "error")
            span.attribute(ATTR_OPENCODE_ERROR_SOURCE, canceled ? "cancellation" : "tool")
            span.attribute(ATTR_OPENCODE_ERROR_STAGE, "execution")
            span.attribute(ATTR_ERROR_TYPE, type)
            span.end(yield* Clock.currentTimeNanos, Exit.fail(new Error(type)))
          }),
        )
      }),
      Effect.withParentSpan(span, { captureStackTrace: false }),
      Effect.withTracerEnabled(false),
    )
  })

export const child = (input: { readonly agent: string; readonly sessionID: string }) =>
  Effect.gen(function* () {
    const span = yield* currentSpan
    if (span)
      yield* observe(
        Effect.sync(() => {
          span.attribute(ATTR_OPENCODE_SUBAGENT_AGENT_NAME, input.agent)
          span.attribute(ATTR_OPENCODE_SUBAGENT_SESSION_ID, input.sessionID)
        }),
      )
    return {
      resume: <A, E, R>(effect: Effect.Effect<A, E, R>, background: boolean) =>
        effect.pipe(
          Effect.provideService(SessionTelemetry.TraceParent, background ? null : span),
          Effect.provideService(
            SessionTelemetry.TraceLinks,
            background && span ? [{ span, attributes: { [ATTR_OPENCODE_LINK_TYPE]: "subagent" } }] : [],
          ),
        ),
    }
  })

function findToolSpan(span: Span | undefined): Span | undefined {
  if (!span) return
  if (span.attributes.get(ATTR_GEN_AI_OPERATION_NAME) === GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL) return span
  const parent = Option.getOrUndefined(span.parent)
  return findToolSpan(parent?._tag === "Span" ? parent : undefined)
}
