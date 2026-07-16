import { describe, expect, test } from "bun:test"
import { HttpContext, HttpRequestDetails, classifyApiFailure, isContextOverflow } from "../src"

describe("provider error classification", () => {
  test("classifies Z.AI GLM token limit messages as context overflow", () => {
    expect(isContextOverflow("tokens in request more than max tokens allowed")).toBe(true)
  })

  test("extracts provider codes from HTTP response bodies", () => {
    expect(
      classifyApiFailure({
        message: "Request failed",
        status: 400,
        http: new HttpContext({
          request: new HttpRequestDetails({ method: "POST", url: "https://provider.test", headers: {} }),
          body: JSON.stringify({ error: { code: "insufficient_quota" } }),
        }),
      }),
    ).toMatchObject({ _tag: "LLM.QuotaExceeded", code: "insufficient_quota" })
  })

  test("classifies only V1 structured quota codes", () => {
    expect(classifyApiFailure({ message: "Failed", status: 400, code: "billing_error" })._tag).toBe("LLM.BadRequest")
    expect(classifyApiFailure({ message: "Quota exceeded", status: 429 })._tag).toBe("LLM.RateLimit")
  })

  test("classifies HTTP request timeouts", () => {
    expect(classifyApiFailure({ message: "Request timed out", status: 408 })).toMatchObject({
      _tag: "LLM.TimeoutError",
    })
  })

  test("keeps 5xx safety failures retryable", () => {
    expect(
      classifyApiFailure({
        message: "Request failed",
        status: 500,
        http: new HttpContext({
          request: new HttpRequestDetails({ method: "POST", url: "https://provider.test", headers: {} }),
          body: "Internal safety check failed",
        }),
      }),
    ).toMatchObject({ _tag: "LLM.ServerError" })
  })

  test("uses structured codes before HTTP status", () => {
    expect(classifyApiFailure({ message: "Failed", status: 500 })._tag).toBe("LLM.ServerError")
    expect(classifyApiFailure({ message: "Failed", status: 500, code: "overloaded_error" })._tag).toBe(
      "LLM.ServerError",
    )
    expect(classifyApiFailure({ message: '{"type":"request_too_large"}', status: 500 })._tag).toBe("LLM.BadRequest")
    expect(classifyApiFailure({ message: "Failed", status: 429 })._tag).toBe("LLM.RateLimit")
  })

  test("classifies only structured content-policy signals", () => {
    expect(
      [
        "content_policy_violation",
        "content_policy_error",
        "content_filter",
        "ResponsibleAIPolicyViolation",
      ].map((code) => classifyApiFailure({ message: "Request rejected", status: 400, code })._tag),
    ).toEqual(["LLM.ContentPolicy", "LLM.ContentPolicy", "LLM.ContentPolicy", "LLM.ContentPolicy"])
    expect(classifyApiFailure({ message: "Request rejected by a safety check", status: 400 })).toMatchObject({
      _tag: "LLM.BadRequest",
    })
  })

  test("extracts nested Azure content-policy codes", () => {
    expect(
      classifyApiFailure({
        message: JSON.stringify({
          error: {
            code: "invalid_request_error",
            inner_error: { code: "ResponsibleAIPolicyViolation" },
          },
        }),
        status: 400,
      }),
    ).toMatchObject({ _tag: "LLM.ContentPolicy" })
  })

  test("retains the Cerebras no-body overflow heuristic", () => {
    expect(classifyApiFailure({ message: "413 status code (no body)", status: 413 })).toMatchObject({
      _tag: "LLM.ContextOverflow",
    })
  })

  test("classifies V1 plain-text rate limit fallbacks", () => {
    expect(
      [
        "Request rate increased too quickly",
        "Rate limit exceeded, please try again later",
        "Too many requests, please slow down",
      ].map((message) => classifyApiFailure({ message })._tag),
    ).toEqual(["LLM.RateLimit", "LLM.RateLimit", "LLM.RateLimit"])
  })

  test("classifies V1 JSON rate limit fallbacks", () => {
    expect(
      [
        '{"type":"error","error":{"type":"too_many_requests"}}',
        '{"type":"error","error":{"code":"rate_limit_exceeded"}}',
        '{"code":"bad_request","error":{"code":"rate_limit_exceeded"}}',
        '{"type":"error","error":{"code":"unknown","type":"too_many_requests"}}',
      ].map((message) => classifyApiFailure({ message })._tag),
    ).toEqual(["LLM.RateLimit", "LLM.RateLimit", "LLM.RateLimit", "LLM.RateLimit"])
  })

  test("prioritizes specific codes over generic provider types", () => {
    expect(
      [
        '{"error":{"code":"rate_limit_exceeded","type":"invalid_request_error"}}',
        '{"error":{"code":"server_error","type":"invalid_request_error"}}',
      ].map((message) => classifyApiFailure({ message })._tag),
    ).toEqual(["LLM.RateLimit", "LLM.ServerError"])
    expect(classifyApiFailure({ message: "Missing", status: 404, code: "invalid_request_error" })._tag).toBe(
      "LLM.NotFound",
    )
    expect(classifyApiFailure({ message: "Limited", status: 404, code: "rate_limit_exceeded" })._tag).toBe(
      "LLM.RateLimit",
    )
  })

  test("classifies V1 overloaded provider codes", () => {
    expect(
      ['{"code":"resource_exhausted"}', '{"code":"service_unavailable"}'].map(
        (message) => classifyApiFailure({ message })._tag,
      ),
    ).toEqual(["LLM.ServerError", "LLM.ServerError"])
  })

  test("classifies nested provider codes when a top-level code is also present", () => {
    expect(
      [
        '{"code":"bad_request","error":{"code":"usage_not_included"}}',
        '{"code":"bad_request","error":{"code":"server_error"}}',
        '{"code":"bad_request","error":{"type":"invalid_request_error"}}',
      ].map((message) => classifyApiFailure({ message })._tag),
    ).toEqual(["LLM.QuotaExceeded", "LLM.ServerError", "LLM.BadRequest"])
  })

  test("keeps unknown and malformed provider payloads non-retryable", () => {
    expect(classifyApiFailure({ message: '{"error":{"message":"no_kv_space"}}' })._tag).toBe("LLM.APIError")
    expect(classifyApiFailure({ message: '{"type":"error","error":{"code":123}}' })._tag).toBe("LLM.APIError")
    expect(classifyApiFailure({ message: "not-json" })._tag).toBe("LLM.APIError")
  })
})
