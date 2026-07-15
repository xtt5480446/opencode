import { Option, Schema } from "effect"
import {
  APIError,
  Authentication,
  BadRequest,
  ContentPolicy,
  ContextOverflow,
  HttpContext,
  HttpRateLimitDetails,
  NotFound,
  PermissionDenied,
  ProviderErrorEvent,
  ProviderMetadata,
  QuotaExceeded,
  RateLimit,
  ServerError,
  TimeoutError,
  isLLMError,
  type LLMError,
} from "./schema"

const patterns = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /model_context_window_exceeded/i,
]

export const isContextOverflow = (message: string) =>
  patterns.some((pattern) => pattern.test(message)) || /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)

export const isContextOverflowFailure = (failure: unknown) =>
  isLLMError(failure)
    ? failure._tag === "LLM.ContextOverflow"
    : Schema.is(ProviderErrorEvent)(failure) && failure.classification === "context-overflow"

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const OVERFLOW_CODES = new Set(["context_length_exceeded", "model_context_window_exceeded"])
const QUOTA_CODES = new Set(["insufficient_quota", "usage_not_included", "billing_error"])
const CONTENT_POLICY_CODES = new Set([
  "content_filter",
  "content_policy_error",
  "content_policy_violation",
  "responsibleaipolicyviolation",
])
const SERVER_CODES = new Set([
  "api_error",
  "internal_error",
  "internalserverexception",
  "modelstreamerrorexception",
  "overloaded_error",
  "server_error",
  "server_is_overloaded",
  "serviceunavailableexception",
])
const INVALID_REQUEST_CODES = new Set([
  "invalid_prompt",
  "invalid_request_error",
  "request_too_large",
  "validationexception",
])
const RATE_LIMIT_TEXT = /rate increased too quickly|rate[-_\s]?limit|too[_\s]?many[_\s]?requests/i
const QUOTA_TEXT = /insufficient[-_\s]?quota|quota[-_\s]?exceeded/i

export interface ApiFailure {
  readonly message: string
  readonly status?: number | undefined
  /** Provider machine-readable error code or type string (e.g. `context_length_exceeded`, `overloaded_error`). */
  readonly code?: string | undefined
  /** Provider or SDK retry hint, used only when stronger structured signals are absent. */
  readonly isRetryable?: boolean | undefined
  readonly retryAfterMs?: number | undefined
  readonly rateLimit?: HttpRateLimitDetails | undefined
  readonly requestID?: string | undefined
  readonly http?: HttpContext | undefined
  readonly providerMetadata?: ProviderMetadata | undefined
}

type CommonFields = {
  readonly message: string
  readonly status: number | undefined
  readonly code: string | undefined
  readonly requestID: string | undefined
  readonly http: HttpContext | undefined
  readonly providerMetadata: ProviderMetadata | undefined
}

function serverError(input: ApiFailure, common: CommonFields) {
  return new ServerError({ ...common, retryAfterMs: input.retryAfterMs })
}

function rateLimit(input: ApiFailure, common: CommonFields) {
  return new RateLimit({ ...common, retryAfterMs: input.retryAfterMs, rateLimit: input.rateLimit })
}

export const extractApiFailureCode = (input: unknown): string | undefined => providerCodes(input)[0]

/**
 * One classifier for every failure a remote API deliberately reports.
 * Protocols call it with in-stream error payloads, the request executor with
 * non-2xx responses, and the AI SDK adapter with `APICallError`s, so all
 * three surfaces produce identical `LLMError` tags.
 *
 * Precedence: context overflow (most specific, 4xx-scoped), content policy,
 * provider signals, HTTP status, then the generic `APIError` fallback.
 */
export const classifyApiFailure = (input: ApiFailure): LLMError => {
  const body = input.http?.body ?? ""
  const codes = [input.code, ...providerCodes(body), ...providerCodes(input.message)].filter(
    (code): code is string => code !== undefined,
  )
  const normalizedCodes = codes.map((code) => code.toLowerCase())
  const text = body || input.message
  const common: CommonFields = {
    message: input.message,
    status: input.status,
    code: codes[0],
    requestID: input.requestID,
    http: input.http,
    providerMetadata: input.providerMetadata,
  }
  const clientScoped = input.status === undefined || (input.status >= 400 && input.status < 500)

  if (
    clientScoped &&
    (normalizedCodes.some((code) => OVERFLOW_CODES.has(code)) || isContextOverflow(text))
  )
    return new ContextOverflow(common)
  if (input.status === 408) return new TimeoutError({ message: input.message, http: input.http })
  if (clientScoped && normalizedCodes.some((code) => CONTENT_POLICY_CODES.has(code))) return new ContentPolicy(common)
  if (normalizedCodes.some((code) => QUOTA_CODES.has(code)) || (input.status === 429 && QUOTA_TEXT.test(text)))
    return new QuotaExceeded(common)
  if (input.status === 401 || normalizedCodes.includes("authentication_error")) return new Authentication(common)
  if (input.status === 403 || normalizedCodes.includes("permission_error")) return new PermissionDenied(common)
  if (input.status === 404 || normalizedCodes.includes("not_found_error")) return new NotFound(common)
  if (normalizedCodes.some((code) => INVALID_REQUEST_CODES.has(code))) return new BadRequest(common)
  if (
    normalizedCodes.some(
      (code) => code.includes("rate_limit") || code === "too_many_requests" || code === "throttlingexception",
    ) ||
    RATE_LIMIT_TEXT.test(text)
  )
    return rateLimit(input, common)
  if (
    normalizedCodes.some(
      (code) => SERVER_CODES.has(code) || code.includes("exhausted") || code.includes("unavailable"),
    )
  )
    return serverError(input, common)
  if (input.status === 429) return rateLimit(input, common)
  if (input.status !== undefined && input.status >= 500)
    return input.isRetryable === false ? new APIError(common) : serverError(input, common)
  if (
    input.status === 400 ||
    input.status === 409 ||
    input.status === 413 ||
    input.status === 422
  )
    return new BadRequest(common)
  return new APIError(common)
}

function providerCodes(value: unknown) {
  const decoded = typeof value === "string" ? Option.getOrUndefined(decodeJson(value)) : value
  if (!isRecord(decoded)) return []
  const error = isRecord(decoded.error) ? decoded.error : undefined
  const innerError = isRecord(error?.inner_error)
    ? error.inner_error
    : isRecord(error?.innererror)
      ? error.innererror
      : undefined
  return [error?.code, error?.type, innerError?.code, decoded.code, decoded.type]
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .map(String)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
