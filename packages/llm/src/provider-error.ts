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

const OVERFLOW_CODES = new Set(["context_length_exceeded", "model_context_window_exceeded"])
const QUOTA_CODES = new Set(["insufficient_quota", "usage_not_included", "billing_error"])
const QUOTA_TEXT = /insufficient[-_\s]?quota|quota[-_\s]?exceeded/i
const CONTENT_POLICY_TEXT = /content[-_\s]?policy|content_filter|safety/i
const SERVER_ERROR_STATUS = (status: number) => status >= 500 || status === 529
const decodeBodyJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const CODE_CLASSIFICATION: Record<string, (input: ApiFailure, common: CommonFields) => LLMError> = {
  overloaded_error: serverError,
  api_error: serverError,
  server_error: serverError,
  internal_error: serverError,
  server_is_overloaded: serverError,
  internalServerException: serverError,
  serviceUnavailableException: serverError,
  modelStreamErrorException: serverError,
  rate_limit_error: rateLimit,
  rate_limit_exceeded: rateLimit,
  too_many_requests: rateLimit,
  throttlingException: rateLimit,
  authentication_error: (_input, common) => new Authentication(common),
  permission_error: (_input, common) => new PermissionDenied(common),
  not_found_error: (_input, common) => new NotFound(common),
  invalid_request_error: (_input, common) => new BadRequest(common),
  invalid_prompt: (_input, common) => new BadRequest(common),
  validationException: (_input, common) => new BadRequest(common),
}

export interface ApiFailure {
  readonly message: string
  readonly status?: number | undefined
  /** Provider machine-readable error code or type string (e.g. `context_length_exceeded`, `overloaded_error`). */
  readonly code?: string | undefined
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

const providerCode = (body: string) => {
  const decoded = Option.getOrUndefined(decodeBodyJson(body))
  if (typeof decoded !== "object" || decoded === null) return undefined
  const error = (decoded as Record<string, unknown>).error
  if (typeof error !== "object" || error === null) return undefined
  const fields = error as Record<string, unknown>
  if (typeof fields.code === "string") return fields.code
  if (typeof fields.type === "string") return fields.type
  return undefined
}

/**
 * One classifier for every failure a remote API deliberately reports.
 * Protocols call it with in-stream error payloads, the request executor with
 * non-2xx responses, and the AI SDK adapter with `APICallError`s, so all
 * three surfaces produce identical `LLMError` tags.
 *
 * Precedence: context overflow (most specific, 4xx-scoped), content policy,
 * HTTP status, provider code, then the generic `APIError` fallback.
 */
export const classifyApiFailure = (input: ApiFailure): LLMError => {
  const body = input.http?.body ?? ""
  const code = input.code ?? providerCode(body)
  const common: CommonFields = {
    message: input.message,
    status: input.status,
    code,
    requestID: input.requestID,
    http: input.http,
    providerMetadata: input.providerMetadata,
  }
  const clientScoped = input.status === undefined || (input.status >= 400 && input.status < 500)
  if (
    clientScoped &&
    ((code !== undefined && OVERFLOW_CODES.has(code)) ||
      isContextOverflow(input.message) ||
      (body.length > 0 && isContextOverflow(body)))
  )
    return new ContextOverflow(common)
  if (CONTENT_POLICY_TEXT.test(body.length > 0 ? body : input.message)) return new ContentPolicy(common)
  if (code !== undefined && QUOTA_CODES.has(code)) return new QuotaExceeded(common)
  if (input.status === 401) return new Authentication(common)
  if (input.status === 403) return new PermissionDenied(common)
  if (input.status === 404) return new NotFound(common)
  if (input.status === 429) {
    if (QUOTA_TEXT.test(body.length > 0 ? body : input.message)) return new QuotaExceeded(common)
    return rateLimit(input, common)
  }
  if (input.status !== undefined && SERVER_ERROR_STATUS(input.status)) return serverError(input, common)
  if (input.status === 400 || input.status === 409 || input.status === 413 || input.status === 422)
    return new BadRequest(common)
  const byCode = code === undefined ? undefined : CODE_CLASSIFICATION[code]
  if (byCode) return byCode(input, common)
  return new APIError(common)
}
