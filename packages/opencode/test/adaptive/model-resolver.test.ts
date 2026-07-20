import { describe, expect, test } from "bun:test"
import { Catalog } from "@opencode-ai/core/catalog"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { LLM, Model as ResolvedModel } from "@opencode-ai/llm"
import * as OpenAIResponses from "@opencode-ai/llm/protocols/openai-responses"
import { Effect, Layer } from "effect"
import { Headers } from "effect/unstable/http"
import { AdaptiveModelResolver } from "@/adaptive/model-resolver"
import { Auth } from "@/auth"

const providerID = ProviderV2.ID.make("test-provider")
const modelID = ModelV2.ID.make("test-model")
const variant = ModelV2.VariantID.make("high")
const ref = { providerID, id: modelID, variant }

const model = ModelV2.Info.make({
  id: modelID,
  providerID,
  name: "Test model",
  api: {
    id: ModelV2.ID.make("wire-model"),
    type: "aisdk",
    package: "@ai-sdk/openai",
    url: "https://provider.example/v1",
  },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  request: { headers: {}, body: {} },
  variants: [{ id: variant, headers: { "x-variant": "high" }, body: { reasoning: { effort: "high" } } }],
  time: { released: 0 },
  cost: [],
  status: "active",
  enabled: true,
  limit: { context: 262_144, output: 32_768 },
})

const auth = (value: Auth.Info | undefined) =>
  Auth.Service.of({
    get: () => Effect.succeed(value),
    all: () => Effect.succeed(value ? { [providerID]: value } : {}),
    set: () => Effect.void,
    remove: () => Effect.void,
  })

const catalog = (input: { disabled?: boolean; model?: ModelV2.Info } = {}) =>
  Catalog.Service.of({
    provider: {
      get: () =>
        Effect.succeed(
          ProviderV2.Info.make({
            id: providerID,
            name: "Test provider",
            disabled: input.disabled,
            api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://provider.example/v1" },
            request: { headers: {}, body: {} },
          }),
        ),
    },
    model: { get: () => Effect.succeed(input.model ?? model) },
  } as unknown as Catalog.Interface)

const layer = (resolveRef: SessionRunnerModel.Interface["resolveRef"], catalogService = catalog()) =>
  Layer.mergeAll(
    Layer.succeed(
      SessionRunnerModel.Service,
      SessionRunnerModel.Service.of({ resolve: () => Effect.die("unused"), resolveRef }),
    ),
    Layer.succeed(Catalog.Service, catalogService),
  )

describe("AdaptiveModelResolver", () => {
  test("keeps the normal V2 resolution path authoritative", async () => {
    const primary = ResolvedModel.make({
      id: "wire-model",
      provider: providerID,
      route: OpenAIResponses.route.with({ limits: { context: 262_144, output: 32_768 } }),
    })
    const legacy = Auth.Service.of({
      get: () => Effect.die("legacy auth must not be read"),
      all: () => Effect.die("unused"),
      set: () => Effect.die("unused"),
      remove: () => Effect.die("unused"),
    })
    const result = await Effect.runPromise(
      AdaptiveModelResolver.resolveRef({ model: ref, auth: legacy }).pipe(
        Effect.provide(layer(() => Effect.succeed(primary))),
      ),
    )

    expect(result).toBe(primary)
  })

  test("reuses a providers-login API key in memory and preserves the requested variant", async () => {
    const key = "legacy-api-key"
    const unavailable = new SessionRunnerModel.ModelUnavailableError({ providerID, modelID })
    const result = await Effect.runPromise(
      AdaptiveModelResolver.resolveRef({
        model: ref,
        auth: auth(new Auth.Api({ type: "api", key, metadata: { tenant: "work" } })),
      }).pipe(Effect.provide(layer(() => Effect.fail(unavailable)))),
    )
    const headers = await Effect.runPromise(
      result.route.auth.apply({
        request: LLM.request({ model: result, prompt: "Hello" }),
        method: "POST",
        url: "https://provider.example/v1/responses",
        body: "{}",
        headers: Headers.empty,
      }),
    )

    expect(headers.authorization).toBe(`Bearer ${key}`)
    expect(result.route.defaults.headers).toMatchObject({ "x-variant": "high" })
    expect(result.route.defaults.http?.body).toEqual({ tenant: "work", reasoning: { effort: "high" } })
    expect(JSON.stringify(result)).not.toContain(key)
  })

  test("does not use legacy auth to bypass a disabled provider", async () => {
    const unavailable = new SessionRunnerModel.ModelUnavailableError({ providerID, modelID })
    const failure = await Effect.runPromise(
      AdaptiveModelResolver.resolveRef({
        model: ref,
        auth: auth(new Auth.Api({ type: "api", key: "legacy-api-key" })),
      }).pipe(Effect.provide(layer(() => Effect.fail(unavailable), catalog({ disabled: true }))), Effect.flip),
    )

    expect(failure).toBe(unavailable)
  })
})
