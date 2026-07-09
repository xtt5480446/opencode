import { createCerebras } from "@ai-sdk/cerebras"
import { createDeepInfra } from "@ai-sdk/deepinfra"
import { createMistral } from "@ai-sdk/mistral"
import { createOpenAI } from "@ai-sdk/openai"
import { describe, expect, test } from "bun:test"

test("Mistral sends promptCacheKey as prompt_cache_key", async () => {
  let body: Record<string, unknown> | undefined
  const mockFetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return Response.json({
        id: "response-1",
        created: 0,
        model: "mistral-large-latest",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
    { preconnect: fetch.preconnect },
  )
  const model = createMistral({ apiKey: "test", fetch: mockFetch })("mistral-large-latest")

  await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    providerOptions: { mistral: { promptCacheKey: "session-123" } },
  })

  expect(body?.prompt_cache_key).toBe("session-123")
})

test("OpenAI Responses sends promptCacheKey as prompt_cache_key", async () => {
  let body: Record<string, unknown> | undefined
  const mockFetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return Response.json({
        id: "response-1",
        created_at: 0,
        model: "gpt-5",
        object: "response",
        output: [],
        usage: { input_tokens: 1, output_tokens: 0 },
        status: "completed",
      })
    },
    { preconnect: fetch.preconnect },
  )
  const model = createOpenAI({ apiKey: "test", fetch: mockFetch }).responses("gpt-5")

  await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    providerOptions: { openai: { promptCacheKey: "session-123" } },
  })

  expect(body?.prompt_cache_key).toBe("session-123")
})

describe("OpenAI-compatible provider cache keys", () => {
  for (const provider of [
    { name: "Cerebras", create: createCerebras, namespace: "cerebras" },
    { name: "DeepInfra", create: createDeepInfra, namespace: "deepinfra" },
  ]) {
    test(`${provider.name} passes prompt_cache_key through`, async () => {
      let body: Record<string, unknown> | undefined
      const mockFetch = Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return Response.json({
            id: "response-1",
            created: 0,
            model: "test-model",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        },
        { preconnect: fetch.preconnect },
      )
      const model = provider.create({ apiKey: "test", fetch: mockFetch })("test-model")

      await model.doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
        providerOptions: { [provider.namespace]: { prompt_cache_key: "session-123" } },
      })

      expect(body?.prompt_cache_key).toBe("session-123")
    })
  }
})
