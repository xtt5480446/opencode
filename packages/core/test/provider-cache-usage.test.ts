import { createCohere } from "@ai-sdk/cohere"
import { createGroq } from "@ai-sdk/groq"
import { createTogetherAI } from "@ai-sdk/togetherai"
import { describe, expect, test } from "bun:test"

const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }]

describe("provider cache usage", () => {
  test("Cohere reports cached input tokens", async () => {
    const model = createCohere({
      apiKey: "test",
      fetch: mockFetch({
        generation_id: "response-1",
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        finish_reason: "COMPLETE",
        usage: {
          billed_units: { input_tokens: 500, output_tokens: 1 },
          tokens: { input_tokens: 500, output_tokens: 1, cached_tokens: 400 },
        },
      }),
    })("command-r")

    const result = await model.doGenerate({ prompt })
    expect(result.usage.inputTokens).toEqual({ total: 500, noCache: 100, cacheRead: 400, cacheWrite: undefined })
  })

  test("Groq reports cached input tokens", async () => {
    const model = createGroq({
      apiKey: "test",
      fetch: mockFetch({
        id: "response-1",
        created: 0,
        model: "openai/gpt-oss-20b",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 1,
          total_tokens: 501,
          prompt_tokens_details: { cached_tokens: 400 },
        },
      }),
    })("openai/gpt-oss-20b")

    const result = await model.doGenerate({ prompt })
    expect(result.usage.inputTokens).toEqual({ total: 500, noCache: 100, cacheRead: 400, cacheWrite: undefined })
  })

  test("Together AI reports flat cached input tokens", async () => {
    const model = createTogetherAI({
      apiKey: "test",
      fetch: mockFetch({
        id: "response-1",
        created: 0,
        model: "moonshotai/Kimi-K2.6",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 500, completion_tokens: 1, total_tokens: 501, cached_tokens: 400 },
      }),
    })("moonshotai/Kimi-K2.6")

    const result = await model.doGenerate({ prompt })
    expect(result.usage.inputTokens).toEqual({ total: 500, noCache: 100, cacheRead: 400, cacheWrite: undefined })
  })
})

function mockFetch(response: unknown) {
  return Object.assign(async () => Response.json(response), { preconnect: fetch.preconnect })
}
