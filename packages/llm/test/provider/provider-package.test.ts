import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, LLMClient } from "../../src"
import { Anthropic, OpenAI, OpenAICodex } from "../../src/providers"
import { it } from "../lib/effect"
import { dynamicResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const JsonRecord = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
const decodeJsonRecord = Schema.decodeUnknownSync(JsonRecord)

const requestFor = (model: ReturnType<typeof OpenAI.model>) =>
  LLM.request({
    model,
    prompt: "Say hello.",
    cache: "none",
  })

describe("provider package contract", () => {
  it.effect("builds OpenAI Responses models from flat settings", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        requestFor(
          OpenAI.model("gpt-x", {
            apiKey: "sk-test",
            headers: { "x-package": "openai" },
            body: { metadata: { source: "package" } },
            providerOptions: { store: true },
            limits: { context: 100, output: 20 },
          }),
        ),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              const body = decodeJsonRecord(input.text)

              expect(web.headers.get("authorization")).toBe("Bearer sk-test")
              expect(web.headers.get("x-package")).toBe("openai")
              expect(body).toMatchObject({
                model: "gpt-x",
                metadata: { source: "package" },
                store: true,
                stream: true,
              })
              expect(body).not.toHaveProperty("apiKey")
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("builds Codex models against the ChatGPT Codex endpoint with optional account header", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        requestFor(OpenAICodex.model("gpt-5-codex", { apiKey: "oauth-token", accountID: "account-123" })),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)

              expect(web.url.startsWith("https://chatgpt.com/backend-api/codex")).toBe(true)
              expect(web.headers.get("authorization")).toBe("Bearer oauth-token")
              expect(web.headers.get("chatgpt-account-id")).toBe("account-123")
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )

      yield* LLMClient.generate(requestFor(OpenAICodex.model("gpt-5-codex", { apiKey: "oauth-token" }))).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)

              expect(web.url.startsWith("https://chatgpt.com/backend-api/codex")).toBe(true)
              expect(web.headers.get("authorization")).toBe("Bearer oauth-token")
              expect(web.headers.get("chatgpt-account-id")).toBeNull()
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )

  it.effect("builds Anthropic Messages models with x-api-key auth", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(requestFor(Anthropic.model("claude-x", { apiKey: "anthropic-key" }))).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              const body = decodeJsonRecord(input.text)

              expect(web.headers.get("x-api-key")).toBe("anthropic-key")
              expect(body).toMatchObject({ model: "claude-x", stream: true })
              return input.respond(
                sseEvents({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )
    }),
  )
})
