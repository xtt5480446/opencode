export * as AgentTelemetry from "./agent"

import type { LLMEvent, Usage } from "@opencode-ai/llm"
import { Cause, Clock, Context, Effect, Exit, Option } from "effect"
import { ParentSpan, type Span } from "effect/Tracer"
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_COMPACTED,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  ATTR_OPENCODE_AGENT_STEP_INDEX,
  ATTR_OPENCODE_AGENT_STEP_TRIGGER,
  ATTR_OPENCODE_COMPACTION_REASON,
  ATTR_OPENCODE_ERROR_SOURCE,
  ATTR_OPENCODE_ERROR_STAGE,
  ATTR_OPENCODE_LINK_TYPE,
  ATTR_OPENCODE_RETRY_ATTEMPT,
  ATTR_OPENCODE_RETRY_DELAY_MS,
  ATTR_OPENCODE_RETRY_DELAY_SOURCE,
  ATTR_OPENCODE_RETRY_DECISION,
  ATTR_OPENCODE_RETRY_MAX_ATTEMPTS,
  ATTR_OPENCODE_SESSION_INPUT_COUNT,
  ATTR_OPENCODE_SESSION_INPUT_DELIVERY,
  ATTR_OPENCODE_SESSION_PARENT_ID,
  ATTR_OPENCODE_TOOL_OUTCOME,
  EVENT_OPENCODE_COMPACTION_COMPLETED,
  EVENT_OPENCODE_COMPACTION_FAILED,
  EVENT_OPENCODE_COMPACTION_STARTED,
  EVENT_OPENCODE_PROVIDER_TOOL_CALLED,
  EVENT_OPENCODE_PROVIDER_TOOL_COMPLETED,
  EVENT_OPENCODE_RETRY_SCHEDULED,
  EVENT_OPENCODE_RETRY_STOPPED,
  EVENT_OPENCODE_SESSION_INPUT_PROMOTED,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
} from "./semconv"
import { SessionTelemetry } from "./session"

export type ModelCallTrigger = "input" | "tool_result" | "retry" | "compaction" | "resume"
export type RetryDecision = "exhausted" | "non_retryable" | "output_started" | "step_limit"

const FailureState = Context.Reference<{ stage?: string } | undefined>("@opencode/AgentTelemetry/FailureState", {
  defaultValue: () => undefined,
})

export const currentSpan = Effect.option(Effect.currentSpan).pipe(
  Effect.map(Option.getOrUndefined),
  Effect.map(findAgentSpan),
)

const observe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchCauseIf(
    effect,
    (cause) => !Cause.hasInterrupts(cause),
    () => Effect.void,
  )

export const invoke = <A, E, R>(
  input: { readonly sessionID: string; readonly agent: string; readonly errorType: (cause: unknown) => string },
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const traceParent = yield* SessionTelemetry.TraceParent
    const traceLinks = yield* SessionTelemetry.TraceLinks
    const turnLinks = yield* SessionTelemetry.TurnLinks
    const previousTurn = turnLinks?.previous()
    const failureState: { stage?: string } = {}
    return yield* Effect.acquireUseRelease(
      Effect.makeSpan(`invoke_agent ${input.agent}`, {
        kind: "internal",
        parent: traceParent ?? undefined,
        root: traceParent === null,
        links: previousTurn
          ? [...traceLinks, { span: previousTurn, attributes: { [ATTR_OPENCODE_LINK_TYPE]: "previous_turn" } }]
          : traceLinks,
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
          [ATTR_GEN_AI_CONVERSATION_ID]: input.sessionID,
          [ATTR_GEN_AI_AGENT_NAME]: input.agent,
        },
      }).pipe(
        Effect.withTracerEnabled(true),
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          () => Effect.succeed(undefined),
        ),
      ),
      (span) =>
        span
          ? Effect.sync(() => turnLinks?.set(span)).pipe(
              Effect.andThen(
                effect.pipe(
                  Effect.withParentSpan(span, { captureStackTrace: false }),
                  Effect.provideService(FailureState, failureState),
                  Effect.withTracerEnabled(false),
                ),
              ),
            )
          : effect,
      (span, exit) => span ? finishSpan(span, exit, failureState, input.errorType) : Effect.void,
    )
  })

function finishSpan<E>(
  span: Span,
  exit: Exit.Exit<unknown, E>,
  failureState: { stage?: string },
  errorType: (cause: unknown) => string,
) {
  return observe(
    Effect.gen(function* () {
      if (Exit.isSuccess(exit)) {
        span.end(yield* Clock.currentTimeNanos, exit)
        return
      }
      const canceled = Cause.hasInterruptsOnly(exit.cause)
      const type = canceled ? "canceled" : yield* classify(() => errorType(Cause.squash(exit.cause)))
      const source = canceled
        ? "cancellation"
        : type.startsWith("provider.")
          ? "provider"
          : type.startsWith("permission.")
            ? "permission"
            : type.startsWith("tool.")
              ? "tool"
              : "session"
      span.attribute(ATTR_ERROR_TYPE, type)
      span.attribute(ATTR_OPENCODE_ERROR_SOURCE, source)
      if (failureState.stage) span.attribute(ATTR_OPENCODE_ERROR_STAGE, failureState.stage)
      span.end(yield* Clock.currentTimeNanos, Exit.fail(new Error(type)))
    }),
  )
}

export const identify = (input: { readonly agent: string; readonly parentSessionID?: string }) =>
  withCurrent((span) => {
    span.attribute(ATTR_GEN_AI_AGENT_NAME, input.agent)
    if (input.parentSessionID) span.attribute(ATTR_OPENCODE_SESSION_PARENT_ID, input.parentSessionID)
  })

export const stage = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const state = yield* FailureState
    return yield* effect.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) && state && !state.stage) state.stage = name
        }),
      ),
    )
  })

export const resetStage = Effect.gen(function* () {
  const state = yield* FailureState
  if (state) state.stage = undefined
})

export const inputPromoted = (input: { readonly delivery: "steer" | "queue"; readonly count: number }) =>
  event(EVENT_OPENCODE_SESSION_INPUT_PROMOTED, {
    [ATTR_OPENCODE_SESSION_INPUT_DELIVERY]: input.delivery,
    [ATTR_OPENCODE_SESSION_INPUT_COUNT]: input.count,
  })

export const compactionStarted = (reason: "manual" | "automatic") =>
  event(EVENT_OPENCODE_COMPACTION_STARTED, { [ATTR_OPENCODE_COMPACTION_REASON]: reason })

export const compactionCompleted = (reason: "manual" | "automatic") =>
  event(EVENT_OPENCODE_COMPACTION_COMPLETED, { [ATTR_OPENCODE_COMPACTION_REASON]: reason })

export const compactionFailed = (reason: "manual" | "automatic") =>
  event(EVENT_OPENCODE_COMPACTION_FAILED, { [ATTR_OPENCODE_COMPACTION_REASON]: reason })

export const modelCall = (input: {
  readonly sessionID: string
  readonly agent: string
  readonly step: number
  readonly trigger: ModelCallTrigger
  readonly retryAttempt?: number
  readonly delivery?: "steer" | "queue"
  readonly compacted: boolean
}) => {
  let usage: Usage | undefined
  const observeEvent = (value: LLMEvent) =>
    Effect.gen(function* () {
      if (value.type === "tool-call" && value.providerExecuted)
        yield* event(EVENT_OPENCODE_PROVIDER_TOOL_CALLED, {
          [ATTR_GEN_AI_TOOL_CALL_ID]: value.id,
          [ATTR_GEN_AI_TOOL_NAME]: value.name,
        })
      if (value.type === "tool-result" && value.providerExecuted)
        yield* event(EVENT_OPENCODE_PROVIDER_TOOL_COMPLETED, {
          [ATTR_GEN_AI_TOOL_CALL_ID]: value.id,
          [ATTR_GEN_AI_TOOL_NAME]: value.name,
          [ATTR_OPENCODE_TOOL_OUTCOME]: value.result.type === "error" ? "error" : "completed",
        })
      if ("usage" in value && value.usage !== undefined) usage = value.usage
      if (value.type === "finish" && usage) yield* recordUsage(usage)
    })
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const agentSpan = yield* currentSpan
      const parentSessionID = agentSpan?.attributes.get(ATTR_OPENCODE_SESSION_PARENT_ID)
      const observed = effect.pipe(
        Effect.annotateSpans({
          [ATTR_GEN_AI_AGENT_NAME]: input.agent,
          [ATTR_GEN_AI_CONVERSATION_ID]: input.sessionID,
          [ATTR_OPENCODE_AGENT_STEP_INDEX]: input.step,
          [ATTR_OPENCODE_AGENT_STEP_TRIGGER]: input.trigger,
          ...(input.retryAttempt === undefined ? {} : { [ATTR_OPENCODE_RETRY_ATTEMPT]: input.retryAttempt }),
          ...(input.delivery === undefined ? {} : { [ATTR_OPENCODE_SESSION_INPUT_DELIVERY]: input.delivery }),
          ...(input.compacted ? { [ATTR_GEN_AI_CONVERSATION_COMPACTED]: true } : {}),
          ...(typeof parentSessionID === "string" ? { [ATTR_OPENCODE_SESSION_PARENT_ID]: parentSessionID } : {}),
        }),
      )
      if (!agentSpan) return yield* observed
      return yield* observed.pipe(Effect.withParentSpan(agentSpan, { captureStackTrace: false }))
    })
  return { observe: observeEvent, run }
}

export const retryScheduled = (input: {
  readonly attempt: number
  readonly maxAttempts: number
  readonly delayMs: number
  readonly retryAfterMs?: number
  readonly errorType: string
}) =>
  event(EVENT_OPENCODE_RETRY_SCHEDULED, {
    [ATTR_OPENCODE_RETRY_ATTEMPT]: input.attempt,
    [ATTR_OPENCODE_RETRY_MAX_ATTEMPTS]: input.maxAttempts,
    [ATTR_OPENCODE_RETRY_DELAY_MS]: input.delayMs,
    [ATTR_OPENCODE_RETRY_DELAY_SOURCE]: input.retryAfterMs === undefined ? "backoff" : "max(backoff,retry_after)",
    [ATTR_OPENCODE_RETRY_DECISION]: "scheduled",
    [ATTR_ERROR_TYPE]: input.errorType,
  })

export const retryStopped = (input: {
  readonly decision: RetryDecision
  readonly attempt: number
  readonly maxAttempts: number
  readonly errorType: string
}) =>
  event(EVENT_OPENCODE_RETRY_STOPPED, {
    [ATTR_OPENCODE_RETRY_DECISION]: input.decision,
    [ATTR_OPENCODE_RETRY_ATTEMPT]: input.attempt,
    [ATTR_OPENCODE_RETRY_MAX_ATTEMPTS]: input.maxAttempts,
    [ATTR_ERROR_TYPE]: input.errorType,
  })

function recordUsage(usage: Usage) {
  return withCurrent((span) => {
    const add = (key: string, value: number | undefined) => {
      if (value === undefined) return
      const current = span.attributes.get(key)
      span.attribute(key, (typeof current === "number" ? current : 0) + value)
    }
    add(ATTR_GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens)
    add(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens)
    add(ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, usage.cacheReadInputTokens)
    add(ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS, usage.cacheWriteInputTokens)
    add(ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS, usage.reasoningTokens)
  })
}

function event(name: string, attributes: Record<string, unknown>) {
  return Effect.gen(function* () {
    const span = yield* currentSpan
    if (!span) return
    const time = yield* Clock.currentTimeNanos
    yield* observe(Effect.sync(() => span.event(name, time, attributes)))
  })
}

function withCurrent(f: (span: Span) => void) {
  return Effect.gen(function* () {
    const span = yield* currentSpan
    if (span) yield* observe(Effect.sync(() => f(span)))
  })
}

function findAgentSpan(span: Span | undefined): Span | undefined {
  if (!span) return
  if (span.attributes.get(ATTR_GEN_AI_OPERATION_NAME) === GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT) return span
  const parent = Option.getOrUndefined(span.parent)
  return findAgentSpan(parent?._tag === "Span" ? parent : undefined)
}

function classify(f: () => string) {
  return Effect.sync(f).pipe(Effect.catchCause(() => Effect.succeed("unknown")))
}
