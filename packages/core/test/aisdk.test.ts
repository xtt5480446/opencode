import { APICallError, type LanguageModelV3, type LanguageModelV3CallOptions } from "@ai-sdk/provider"
import { AISDK } from "@opencode-ai/core/aisdk"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LLM, Message } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import { expect } from "bun:test"
import { Effect, Stream } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(AISDK.locationLayer)

const model = (packageName: string, settings: Record<string, unknown> = {}) =>
  ModelV2.Info.make({
    ...ModelV2.Info.empty(ProviderV2.ID.make("test-provider"), ModelV2.ID.make("catalog-model")),
    modelID: ModelV2.ID.make("api-model"),
    package: ProviderV2.aisdk(packageName),
    settings,
    limit: { context: 100, output: 20 },
  })

const failingLanguage = (error: unknown): LanguageModelV3 => ({
  specificationVersion: "v3",
  provider: "test-provider",
  modelId: "api-model",
  supportedUrls: {},
  doGenerate: async () => {
    throw error
  },
  doStream: async () => {
    throw error
  },
})

it.effect("keys language models by package and flattened overlays", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const loaded: string[] = []
    yield* aisdk.hook.sdk((event) => {
      loaded.push(event.package)
      event.sdk = { languageModel: () => ({ package: event.package }) }
    })

    const first = yield* aisdk.language(model("first", { region: "us-east-1" }))
    const second = yield* aisdk.language(model("second", { region: "us-east-1" }))
    const third = yield* aisdk.language(model("second", { region: "us-west-2" }))

    expect(first).not.toBe(second)
    expect(second).not.toBe(third)
    expect(loaded).toEqual(["first", "second", "second"])
  }),
)

it.effect("projects request settings, headers, and body overlays", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    let body: unknown
    yield* aisdk.hook.sdk((event) => {
      body = event.options.body
      event.sdk = { languageModel: () => ({ provider: event.model.providerID }) }
    })

    const input = model("@ai-sdk/google", {
      apiKey: "secret",
      thinkingConfig: { thinkingBudget: 1024 },
    })
    const resolved = yield* aisdk.model({
      ...input,
      headers: { "x-test": "header" },
      body: { safety_setting: "strict" },
    })
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: resolved, prompt: "Hello" }),
    )

    expect(prepared.body.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingBudget: 1024 } },
    })
    expect(prepared.body.headers).toEqual({ "x-test": "header" })
    expect(body).toEqual({ safety_setting: "strict" })
  }),
)

it.effect("maps pro reasoning bodies to AI SDK provider options", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    let body: unknown
    yield* aisdk.hook.sdk((event) => {
      body = event.options.body
      event.sdk = { languageModel: () => ({ provider: event.model.providerID }) }
    })

    const resolved = yield* aisdk.model({
      ...model("@ai-sdk/openai"),
      body: { reasoning: { mode: "pro" } },
    })
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: resolved, prompt: "Hello" }),
    )

    expect(body).toBeUndefined()
    expect(prepared.body.providerOptions).toEqual({ openai: { reasoningMode: "pro" } })
  }),
)

it.effect("projects replay metadata onto AI SDK prompt parts", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = { languageModel: () => ({ provider: event.model.providerID }) }
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/anthropic"))
    expect(resolved.route.providerMetadataKey).toBe("anthropic")
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({
        model: resolved,
        messages: [
          Message.assistant([
            { type: "reasoning", text: "Think", providerMetadata: { anthropic: { signature: "signed" } } },
            {
              type: "tool-call",
              id: "hosted",
              name: "web_search",
              input: { query: "Effect" },
              providerExecuted: true,
              providerMetadata: { anthropic: { blockType: "server_tool_use" } },
            },
          ]),
        ],
      }),
    )

    expect(prepared.body.prompt).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Think",
            providerOptions: { anthropic: { signature: "signed" } },
          },
          {
            type: "tool-call",
            toolCallId: "hosted",
            toolName: "web_search",
            input: { query: "Effect" },
            providerExecuted: true,
            providerOptions: { anthropic: { blockType: "server_tool_use" } },
          },
        ],
      },
    ])
  }),
)

it.effect("redacts and classifies AI SDK API failures", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    const apiError = new APICallError({
      message: "Billing failed",
      url: "https://provider.test/v1?key=url-secret",
      requestBodyValues: { apiKey: "request-secret" },
      statusCode: 400,
      responseHeaders: { "x-api-key": "header-secret" },
      responseBody: JSON.stringify({
        error: { code: "billing_error", api_key: "body-secret", detail: "x".repeat(20_000) },
      }),
    })
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {}
    })
    yield* aisdk.hook.language((event) => {
      event.language = failingLanguage(apiError)
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/openai"))
    const request = LLM.request({ model: resolved, prompt: "Hello" })
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(request)
    const error = yield* resolved.route
      .streamPrepared(prepared.body, request, { http: { execute: () => Effect.die("unused") } })
      .pipe(Stream.runDrain, Effect.flip)

    expect(error).toMatchObject({
      _tag: "LLM.QuotaExceeded",
      code: "billing_error",
      http: {
        request: { url: "https://provider.test/v1?key=%3Credacted%3E" },
        response: { headers: { "x-api-key": "<redacted>" } },
      },
    })
    expect("http" in error ? error.http?.body : undefined).not.toContain("body-secret")
    expect("http" in error ? error.http?.bodyTruncated : undefined).toBe(true)
  }),
)

it.effect("classifies AI SDK request timeouts", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {}
    })
    yield* aisdk.hook.language((event) => {
      event.language = failingLanguage(new DOMException("The operation timed out", "TimeoutError"))
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/openai"))
    const request = LLM.request({ model: resolved, prompt: "Hello" })
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(request)
    const error = yield* resolved.route
      .streamPrepared(prepared.body, request, { http: { execute: () => Effect.die("unused") } })
      .pipe(Stream.runDrain, Effect.flip)

    expect(error).toMatchObject({ _tag: "LLM.TimeoutError", message: "The operation timed out" })
  }),
)
