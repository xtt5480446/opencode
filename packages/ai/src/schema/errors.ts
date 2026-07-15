import { Schema } from "effect"
import { ModelID, ProviderID, ProviderMetadata, RouteID } from "./ids"

export const ProviderFailureClassification = Schema.Literal("context-overflow")
export type ProviderFailureClassification = typeof ProviderFailureClassification.Type

export class HttpRequestDetails extends Schema.Class<HttpRequestDetails>("LLM.HttpRequestDetails")({
  method: Schema.String,
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
}) {}

export class HttpResponseDetails extends Schema.Class<HttpResponseDetails>("LLM.HttpResponseDetails")({
  status: Schema.Number,
  headers: Schema.Record(Schema.String, Schema.String),
}) {}

export class HttpRateLimitDetails extends Schema.Class<HttpRateLimitDetails>("LLM.HttpRateLimitDetails")({
  retryAfterMs: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  remaining: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  reset: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class HttpContext extends Schema.Class<HttpContext>("LLM.HttpContext")({
  request: HttpRequestDetails,
  response: Schema.optional(HttpResponseDetails),
  body: Schema.optional(Schema.String),
  bodyTruncated: Schema.optional(Schema.Boolean),
  requestId: Schema.optional(Schema.String),
  rateLimit: Schema.optional(HttpRateLimitDetails),
}) {}

/**
 * Fields shared by every failure the remote API deliberately reported —
 * whether as a non-2xx response, an SSE error event, a WebSocket error
 * message, or a binary exception frame. `status` is absent when the error
 * arrived mid-stream without an HTTP status; `code` carries the provider's
 * machine-readable error code (e.g. `context_length_exceeded`) when one
 * exists.
 */
const apiFailureFields = {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.String),
  requestID: Schema.optional(Schema.String),
  http: Schema.optional(HttpContext),
  providerMetadata: Schema.optional(ProviderMetadata),
}

/** Provider rejected the request as invalid (400/409/422, `invalid_request_error`, ...). */
export class BadRequest extends Schema.TaggedErrorClass<BadRequest>()("LLM.BadRequest", {
  ...apiFailureFields,
  parameter: Schema.optional(Schema.String),
}) {}

/** Credentials are missing, invalid, or expired (401). */
export class Authentication extends Schema.TaggedErrorClass<Authentication>()("LLM.Authentication", {
  ...apiFailureFields,
}) {}

/** Authenticated but not allowed (403). */
export class PermissionDenied extends Schema.TaggedErrorClass<PermissionDenied>()("LLM.PermissionDenied", {
  ...apiFailureFields,
}) {}

/** Model or endpoint does not exist (404). */
export class NotFound extends Schema.TaggedErrorClass<NotFound>()("LLM.NotFound", {
  ...apiFailureFields,
}) {}

/** Transient request throttling (429). Retryable; honor `retryAfterMs` when present. */
export class RateLimit extends Schema.TaggedErrorClass<RateLimit>()("LLM.RateLimit", {
  ...apiFailureFields,
  retryAfterMs: Schema.optional(Schema.Number),
  rateLimit: Schema.optional(HttpRateLimitDetails),
}) {}

/** Account-level quota or billing exhaustion. Unlike `RateLimit`, waiting does not help. */
export class QuotaExceeded extends Schema.TaggedErrorClass<QuotaExceeded>()("LLM.QuotaExceeded", {
  ...apiFailureFields,
}) {}

/** Provider refused the content for policy/safety reasons. */
export class ContentPolicy extends Schema.TaggedErrorClass<ContentPolicy>()("LLM.ContentPolicy", {
  ...apiFailureFields,
}) {}

/**
 * The request exceeds the model's context window. Designated tag because
 * Core recovers from it structurally (compaction) rather than surfacing it.
 * Upgraded from `BadRequest` by the shared classifier in `provider-error.ts`.
 */
export class ContextOverflow extends Schema.TaggedErrorClass<ContextOverflow>()("LLM.ContextOverflow", {
  ...apiFailureFields,
}) {}

/** Provider-side failure (5xx, `overloaded_error`, internal exceptions). Retryable. */
export class ServerError extends Schema.TaggedErrorClass<ServerError>()("LLM.ServerError", {
  ...apiFailureFields,
  retryAfterMs: Schema.optional(Schema.Number),
}) {}

/** Any other deliberate API rejection that matches no designated tag (402, 405, 410, ...). */
export class APIError extends Schema.TaggedErrorClass<APIError>()("LLM.APIError", {
  ...apiFailureFields,
}) {}

/** Communication failed: connect failure, reset, socket close, DNS. No API response involved. */
export class ConnectionError extends Schema.TaggedErrorClass<ConnectionError>()("LLM.ConnectionError", {
  message: Schema.String,
  kind: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  http: Schema.optional(HttpContext),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The request or stream read timed out before the provider answered. */
export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()("LLM.TimeoutError", {
  message: Schema.String,
  url: Schema.optional(Schema.String),
  http: Schema.optional(HttpContext),
}) {}

/**
 * Transport succeeded but the content broke the protocol contract:
 * undecodable frames, premature EOF without a terminal `finish`, duplicate
 * terminals, or output after a terminal event.
 */
export class MalformedResponse extends Schema.TaggedErrorClass<MalformedResponse>()("LLM.MalformedResponse", {
  message: Schema.String,
  route: Schema.optional(Schema.String),
  raw: Schema.optional(Schema.String),
  providerMetadata: Schema.optional(ProviderMetadata),
}) {}

/** Request construction failed locally: the selected model resolves to no executable route. */
export class NoRoute extends Schema.TaggedErrorClass<NoRoute>()("LLM.NoRoute", {
  route: RouteID,
  provider: ProviderID,
  model: ModelID,
}) {
  override get message() {
    return `No LLM route for ${this.provider}/${this.model} using ${this.route}`
  }
}

const members = [
  BadRequest,
  Authentication,
  PermissionDenied,
  NotFound,
  RateLimit,
  QuotaExceeded,
  ContentPolicy,
  ContextOverflow,
  ServerError,
  APIError,
  ConnectionError,
  TimeoutError,
  MalformedResponse,
  NoRoute,
] as const

export const LLMErrorSchema = Schema.Union(members)

/**
 * Every failure of one LLM request. `LLMEvent` streams carry output only;
 * all failures — HTTP rejections, in-stream provider error events, transport
 * failures, and protocol-contract violations — exit through this union on
 * the stream's error channel.
 */
export type LLMError = typeof LLMErrorSchema.Type

export const isLLMError = (value: unknown): value is LLMError =>
  members.some((member) => value instanceof member)

/**
 * Failure type for tool execute handlers. Handlers must map their internal
 * errors to this shape; the runtime catches `ToolFailure`s and surfaces them
 * as `tool-error` events plus a `tool-result` of `type: "error"` so the model
 * can self-correct.
 *
 * Anything thrown or yielded by a handler that is not a `ToolFailure` is
 * treated as a defect and fails the stream.
 */
export class ToolFailure extends Schema.TaggedErrorClass<ToolFailure>()("LLM.ToolFailure", {
  message: Schema.String,
  error: Schema.optional(Schema.Defect()),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}
