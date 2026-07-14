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
})
