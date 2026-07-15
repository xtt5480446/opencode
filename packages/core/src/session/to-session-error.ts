import { isLLMError, ToolFailure } from "@opencode-ai/ai"
import { Tool } from "@opencode-ai/plugin/v2/effect/tool"
import { SessionError } from "@opencode-ai/schema/session-error"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { Integration } from "../integration"
import { ToolOutputStore } from "../tool-output-store"
import { AgentNotFoundError, StepFailedError, UserInterruptedError } from "./error"
import { SessionRunnerModel } from "./runner/model"

export function toSessionError(cause: unknown): SessionError.Error {
  if (isLLMError(cause)) {
    switch (cause._tag) {
      case "LLM.RateLimit":
        return { type: "provider.rate-limit", message: cause.message }
      case "LLM.Authentication":
        return { type: "provider.auth", message: cause.message }
      case "LLM.PermissionDenied":
        return { type: "provider.auth", message: cause.message }
      case "LLM.NotFound":
        return { type: "provider.not-found", message: cause.message }
      case "LLM.QuotaExceeded":
        return { type: "provider.quota", message: cause.message }
      case "LLM.ContentPolicy":
        return { type: "provider.content-filter", message: cause.message }
      case "LLM.ContextOverflow":
        return { type: "provider.context-overflow", message: cause.message }
      case "LLM.ConnectionError":
        return { type: "provider.transport", message: cause.message }
      case "LLM.TimeoutError":
        return { type: "provider.timeout", message: cause.message }
      case "LLM.ServerError":
        return { type: "provider.internal", message: cause.message }
      case "LLM.MalformedResponse":
        return { type: "provider.invalid-output", message: cause.message }
      case "LLM.BadRequest":
        return { type: "provider.invalid-request", message: cause.message }
      case "LLM.NoRoute":
        return { type: "provider.no-route", message: cause.message }
      case "LLM.APIError":
        return { type: "provider.unknown", message: cause.message }
      default: {
        const exhaustive: never = cause
        return exhaustive
      }
    }
  }
  if (cause instanceof PermissionV2.BlockedError) return { type: "permission.rejected", message: cause.message }
  if (cause instanceof QuestionV2.RejectedError) return { type: "aborted", message: cause.message }
  if (cause instanceof ToolFailure || cause instanceof Tool.Failure)
    return cause.error === undefined ? { type: "tool.execution", message: cause.message } : toSessionError(cause.error)
  if (cause instanceof StepFailedError) return cause.error
  if (cause instanceof AgentNotFoundError) return { type: "unknown", message: cause.message }
  if (cause instanceof UserInterruptedError) return { type: "aborted", message: cause.message }
  if (
    cause instanceof SessionRunnerModel.ModelNotSelectedError ||
    cause instanceof SessionRunnerModel.ModelUnavailableError ||
    cause instanceof SessionRunnerModel.VariantUnavailableError ||
    cause instanceof SessionRunnerModel.UnsupportedPackageError
  )
    return { type: "provider.no-route", message: cause.message }
  if (cause instanceof Integration.AuthorizationError) return { type: "provider.auth", message: cause.message }
  if (cause instanceof ToolOutputStore.StorageError) return { type: "unknown", message: cause.message }
  return { type: "unknown", message: cause instanceof Error ? cause.message : String(cause) }
}
