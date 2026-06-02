import { describe, expect, test } from "bun:test"
import { parseProviderErrorBody } from "../src/routes/zen/util/providerError"

describe("provider error parsing", () => {
  test("parses SSE error bodies from upstream rate limits", () => {
    expect(
      parseProviderErrorBody(
        'event:error\ndata: {"error":{"type":"rate_limit_error","message":"Too many requests"}}\n\n',
        "Too Many Requests",
      ),
    ).toEqual({
      error: {
        type: "rate_limit_error",
        message: "Too many requests",
      },
    })
  })

  test("wraps plain text errors in provider error shape", () => {
    expect(parseProviderErrorBody("overloaded", "Too Many Requests")).toEqual({
      error: {
        message: "overloaded",
      },
    })
  })
})
