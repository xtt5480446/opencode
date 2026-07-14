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
          body: JSON.stringify({ error: { code: "billing_error" } }),
        }),
      }),
    ).toMatchObject({ _tag: "LLM.QuotaExceeded", code: "billing_error" })
  })

  test("classifies HTTP request timeouts", () => {
    expect(classifyApiFailure({ message: "Request timed out", status: 408 })).toMatchObject({
      _tag: "LLM.TimeoutError",
    })
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
