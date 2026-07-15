export * as SessionRunnerRetry from "./retry"

import type { LLMError } from "@opencode-ai/ai"
import { SessionError } from "@opencode-ai/schema/session-error"
import { Data, Duration, Effect, Schedule } from "effect"
import { EventV2 } from "../../event"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import type { SessionRunner } from "./index"

export class RetryableFailure extends Data.TaggedError("SessionRunner.RetryableFailure")<{
  readonly cause: LLMError
  readonly assistantMessageID: SessionMessage.ID
  readonly error: SessionError.Error
  readonly step: number
}> {}

export function isRetryable(error: LLMError) {
  switch (error._tag) {
    case "LLM.RateLimit":
    case "LLM.ServerError":
    case "LLM.ConnectionError":
    case "LLM.TimeoutError":
      return true
    case "LLM.Authentication":
    case "LLM.PermissionDenied":
    case "LLM.NotFound":
    case "LLM.QuotaExceeded":
    case "LLM.ContentPolicy":
    case "LLM.ContextOverflow":
    case "LLM.MalformedResponse":
    case "LLM.BadRequest":
    case "LLM.NoRoute":
    case "LLM.APIError":
      return false
    default: {
      const exhaustive: never = error
      return exhaustive
    }
  }
}

const retryAfter = (failure: RetryableFailure) => {
  if (failure.cause._tag === "LLM.RateLimit" || failure.cause._tag === "LLM.ServerError")
    return failure.cause.retryAfterMs
  return undefined
}

export const schedule = (events: EventV2.Interface, sessionID: SessionSchema.ID) =>
  Schedule.exponential("2 seconds").pipe(
    Schedule.take(4),
    Schedule.setInputType<RetryableFailure | SessionRunner.RunError>(),
    Schedule.passthrough,
    Schedule.while(({ input }) => input instanceof RetryableFailure),
    Schedule.modifyDelay((failure, delay) => {
      const minimum = failure instanceof RetryableFailure ? retryAfter(failure) : undefined
      return Effect.succeed(minimum === undefined ? delay : Duration.max(delay, Duration.millis(minimum)))
    }),
    Schedule.tap((metadata) =>
      metadata.input instanceof RetryableFailure
        ? events.publish(SessionEvent.RetryScheduled, {
            sessionID,
            assistantMessageID: metadata.input.assistantMessageID,
            attempt: metadata.attempt + 1,
            at: metadata.now + Duration.toMillis(metadata.duration),
            error: metadata.input.error,
          })
        : Effect.void,
    ),
  )
