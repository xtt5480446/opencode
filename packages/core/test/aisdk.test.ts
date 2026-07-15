import {
  APICallError,
  InvalidResponseDataError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
} from "@ai-sdk/provider"
import { AISDK } from "@opencode-ai/core/aisdk"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { LLM, Message } from "@opencode-ai/ai"
import { LLMClient } from "@opencode-ai/ai/route"
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
    expect(prepared.body.providerOptions).toEqual({
      openai: { forceReasoning: true, reasoningMode: "pro" },
    })
  }),
)

it.effect("maps package-specific AI SDK provider option keys", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = { languageModel: () => ({ provider: event.model.providerID }) }
    })

    const cases = [
      ["@ai-sdk/github-copilot", "copilot", { reasoningEffort: "high" }],
      ["@ai-sdk/amazon-bedrock/mantle", "openai", { reasoningEffort: "high", forceReasoning: true }],
      ["@ai-sdk/openai-compatible", "test-provider", { reasoningEffort: "high" }],
      ["@jerome-benoit/sap-ai-provider-v2", "sap-ai", { reasoningEffort: "high" }],
      ["ai-gateway-provider", "openaiCompatible", { reasoningEffort: "high" }],
    ] as const
    for (const [packageName, key, settings] of cases) {
      const resolved = yield* aisdk.model(model(packageName, { reasoningEffort: "high" }))
      const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
        LLM.request({ model: resolved, prompt: "Hello" }),
      )
      expect(prepared.body.providerOptions).toEqual({ [key]: settings })
    }
  }),
)

it.effect("forces reasoning and projects both Azure AI SDK namespaces", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = { languageModel: () => ({ provider: event.model.providerID }) }
    })

    const openai = yield* aisdk.model(model("@ai-sdk/openai", { reasoningEffort: "high" }))
    const openaiPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: openai, prompt: "Hello" }),
    )
    expect(openaiPrepared.body.providerOptions).toEqual({
      openai: { reasoningEffort: "high", forceReasoning: true },
    })

    const azure = yield* aisdk.model(model("@ai-sdk/azure", { reasoningEffort: "high" }))
    const azurePrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: azure, prompt: "Hello" }),
    )
    expect(azurePrepared.body.providerOptions).toEqual({
      openai: { reasoningEffort: "high", forceReasoning: true },
      azure: { reasoningEffort: "high", forceReasoning: true },
    })
  }),
)

it.effect("routes AI Gateway model options by upstream prefix", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = { languageModel: () => ({ provider: event.model.providerID }) }
    })

    const anthropic = yield* aisdk.model({
      ...model("@ai-sdk/gateway", {
        gateway: { order: ["anthropic"] },
        thinking: { type: "adaptive" },
      }),
      modelID: ModelV2.ID.make("anthropic/claude-sonnet-5"),
    })
    const anthropicPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: anthropic, prompt: "Hello" }),
    )
    expect(anthropicPrepared.body.providerOptions).toEqual({
      gateway: { order: ["anthropic"] },
      anthropic: { thinking: { type: "adaptive" } },
    })

    const bedrock = yield* aisdk.model({
      ...model("@ai-sdk/gateway", { reasoningConfig: { type: "enabled" } }),
      modelID: ModelV2.ID.make("amazon/nova-2-lite"),
    })
    const bedrockPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: bedrock, prompt: "Hello" }),
    )
    expect(bedrockPrepared.body.providerOptions).toEqual({
      bedrock: { reasoningConfig: { type: "enabled" } },
    })

    const fallback = yield* aisdk.model({
      ...model("@ai-sdk/gateway", { reasoningEffort: "high" }),
      modelID: ModelV2.ID.make("deepseek/deepseek-v4"),
    })
    const fallbackPrepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(
      LLM.request({ model: fallback, prompt: "Hello" }),
    )
    expect(fallbackPrepared.body.providerOptions).toEqual({
      deepseek: { reasoningEffort: "high" },
    })
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
      message: "Quota exceeded",
      url: "https://provider.test/v1?key=url-secret",
      requestBodyValues: { apiKey: "request-secret" },
      statusCode: 400,
      responseHeaders: { "x-api-key": "header-secret" },
      responseBody: JSON.stringify({
        error: { code: "insufficient_quota", api_key: "body-secret", detail: "x".repeat(20_000) },
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
      code: "insufficient_quota",
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

it.effect("classifies structured AI SDK stream errors", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {}
    })
    yield* aisdk.hook.language((event) => {
      event.language = {
        ...failingLanguage(new Error("unused")),
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
              controller.close()
            },
          }),
          request: { body: {} },
        }),
      }
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/anthropic"))
    const request = LLM.request({ model: resolved, prompt: "Hello" })
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(request)
    const error = yield* resolved.route
      .streamPrepared(prepared.body, request, { http: { execute: () => Effect.die("unused") } })
      .pipe(Stream.runDrain, Effect.flip)

    expect(error).toMatchObject({ _tag: "LLM.ServerError", code: "overloaded_error", message: "Overloaded" })
  }),
)

it.effect("classifies malformed AI SDK response causes", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {}
    })
    yield* aisdk.hook.language((event) => {
      event.language = failingLanguage(
        new APICallError({
          message: "Failed to process successful response",
          url: "https://provider.test/v1",
          requestBodyValues: {},
          statusCode: 200,
          cause: new InvalidResponseDataError({ data: { invalid: true } }),
        }),
      )
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/openai"))
    const request = LLM.request({ model: resolved, prompt: "Hello" })
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(request)
    const error = yield* resolved.route
      .streamPrepared(prepared.body, request, { http: { execute: () => Effect.die("unused") } })
      .pipe(Stream.runDrain, Effect.flip)

    expect(error).toMatchObject({ _tag: "LLM.MalformedResponse", message: 'Invalid response data: {"invalid":true}.' })
  }),
)

it.effect("respects non-retryable unclassified AI SDK failures", () =>
  Effect.gen(function* () {
    const aisdk = yield* AISDK.Service
    yield* aisdk.hook.sdk((event) => {
      event.sdk = {}
    })
    yield* aisdk.hook.language((event) => {
      event.language = failingLanguage(
        new APICallError({
          message: "Provider adapter rejected the request",
          url: "https://provider.test/v1",
          requestBodyValues: {},
          isRetryable: false,
        }),
      )
    })

    const resolved = yield* aisdk.model(model("@ai-sdk/openai"))
    const request = LLM.request({ model: resolved, prompt: "Hello" })
    const prepared = yield* LLMClient.prepare<LanguageModelV3CallOptions>(request)
    const error = yield* resolved.route
      .streamPrepared(prepared.body, request, { http: { execute: () => Effect.die("unused") } })
      .pipe(Stream.runDrain, Effect.flip)

    expect(error).toMatchObject({ _tag: "LLM.APIError", message: "Provider adapter rejected the request" })
  }),
)
