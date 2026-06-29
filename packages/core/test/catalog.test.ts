import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Integration } from "@opencode-ai/core/integration"
import { Credential } from "@opencode-ai/core/credential"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { Policy } from "@opencode-ai/core/policy"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("test") })),
)
const it = testEffect(
  Catalog.locationLayer.pipe(
    Layer.provideMerge(EventV2.defaultLayer),
    Layer.provideMerge(locationLayer),
    Layer.provideMerge(Credential.defaultLayer),
  ),
)

describe("CatalogV2", () => {
  it.effect("publishes an updated event after catalog changes", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const events = yield* EventV2.Service
      const updated = yield* events
        .subscribe(Catalog.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* catalog.transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))

      expect((yield* Fiber.join(updated)).length).toBe(1)
    }),
  )

  it.effect("derives availability from active credentials without changing provider state", () => {
    const integrationID = Integration.ID.make("test")
    const layer = Catalog.locationLayer.pipe(
      Layer.fresh,
      Layer.provideMerge(EventV2.defaultLayer),
      Layer.provideMerge(locationLayer),
      Layer.provideMerge(Credential.defaultLayer.pipe(Layer.fresh)),
    )

    return Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      yield* catalog.transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
      yield* credentials.create({
        integrationID,
        label: "First",
        value: Credential.Key.make({ type: "key", key: "first", metadata: { tenant: "one" } }),
      })

      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([ProviderV2.ID.make("test")])
      expect(required(yield* catalog.provider.get(ProviderV2.ID.make("test"))).body).toBeUndefined()
      yield* credentials.create({
        integrationID,
        label: "Second",
        value: Credential.Key.make({ type: "key", key: "second", metadata: { tenant: "two" } }),
      })
      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([ProviderV2.ID.make("test")])
      expect(required(yield* catalog.provider.get(ProviderV2.ID.make("test"))).body).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect("derives availability from a provider's integration", () => {
    const integrationID = Integration.ID.make("gateway")
    const providerID = ProviderV2.ID.make("remote")
    const layer = Catalog.locationLayer.pipe(
      Layer.fresh,
      Layer.provideMerge(EventV2.defaultLayer),
      Layer.provideMerge(locationLayer),
      Layer.provideMerge(Credential.defaultLayer.pipe(Layer.fresh)),
    )

    return Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* (yield* Integration.Service).transform((editor) => editor.update(integrationID, () => {}))
      yield* catalog.transform((editor) =>
        editor.provider.update(providerID, (provider) => {
          provider.integrationID = integrationID
        }),
      )
      expect(yield* catalog.provider.available()).toEqual([])

      yield* (yield* Credential.Service).create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([providerID])
    }).pipe(Effect.provide(layer))
  })

  it.effect("projects environment connections without a catalog plugin", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.CATALOG_TEST_API_KEY
        process.env.CATALOG_TEST_API_KEY = "secret"
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          const integrations = yield* Integration.Service
          const providerID = ProviderV2.ID.make("test")
          yield* integrations.transform((editor) =>
            editor.method.update({
              integrationID: Integration.ID.make(providerID),
              method: { type: "env", names: ["CATALOG_TEST_API_KEY"] },
            }),
          )
          yield* catalog.transform((editor) => editor.provider.update(providerID, () => {}))

          expect((yield* catalog.provider.available()).map((provider) => provider.id)).toContain(providerID)
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.CATALOG_TEST_API_KEY
          else process.env.CATALOG_TEST_API_KEY = previous
        }),
    ),
  )

  it.effect("keeps provider API settings flat", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      yield* catalog.transform((catalog) =>
        catalog.provider.update(providerID, (provider) => {
          provider.package = ProviderV2.aisdk("@ai-sdk/openai-compatible")
          provider.settings = { baseURL: "https://override.example.com" }
        }),
      )

      expect(required(yield* catalog.provider.get(providerID))).toMatchObject({
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { baseURL: "https://override.example.com" },
      })
    }),
  )

  it.effect("resolves model settings and upstream model ID", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      const modelID = ModelV2.ID.make("model")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.package = ProviderV2.aisdk("@ai-sdk/openai-compatible")
          provider.settings = { baseURL: "https://provider.example.com" }
        })
        catalog.model.update(providerID, modelID, (model) => {
          model.modelID = ModelV2.ID.make("upstream-model")
          model.settings = { baseURL: "https://override.example.com" }
        })
      })

      expect(required(yield* catalog.model.get(providerID, modelID))).toMatchObject({
        id: modelID,
        modelID: ModelV2.ID.make("upstream-model"),
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { baseURL: "https://override.example.com" },
      })
    }),
  )

  it.effect("resolves default model transport from provider transport", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      const modelID = ModelV2.ID.make("model")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.package = ProviderV2.aisdk("@ai-sdk/openai-compatible")
          provider.settings = { baseURL: "https://provider.example.com" }
        })
        catalog.model.update(providerID, modelID, () => {})
      })

      expect(required(yield* catalog.model.get(providerID, modelID))).toMatchObject({
        id: modelID,
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { baseURL: "https://provider.example.com" },
      })
    }),
  )

  it.effect("resolves provider and model overlay merges", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      const modelID = ModelV2.ID.make("model")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.headers = { provider: "provider", "X-Shared": "provider" }
          provider.body = {
            provider: true,
            reasoning: { type: "enabled", budget: 8_000 },
            stop: ["END"],
            disabled: { type: "enabled" },
          }
        })
        catalog.model.update(providerID, modelID, (model) => {
          model.headers = { model: "model", "x-shared": "model" }
          model.body = {
            model: true,
            request: true,
            reasoning: { budget: 32_000 },
            stop: ["STOP"],
            disabled: null,
          }
        })
      })

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.headers).toEqual({ provider: "provider", "x-shared": "model", model: "model" })
      expect(model.body).toEqual({
        provider: true,
        model: true,
        request: true,
        reasoning: { type: "enabled", budget: 32_000 },
        stop: ["STOP"],
        disabled: null,
      })
    }),
  )

  it.effect("falls back to newest available model when no default is configured", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, ModelV2.ID.make("old"), (model) => {
          model.time.released = 1000
        })
        catalog.model.update(providerID, ModelV2.ID.make("new"), (model) => {
          model.time.released = 2000
        })
      })

      expect((yield* catalog.model.default())?.id).toMatch("new")
    }),
  )

  it.effect("uses a transform-provided default model until that transform is replaced", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      const old = ModelV2.ID.make("old")
      const newest = ModelV2.ID.make("new")
      const models = (catalog: Catalog.Draft) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, old, (model) => {
          model.time.released = 1000
        })
        catalog.model.update(providerID, newest, (model) => {
          model.time.released = 2000
        })
      }

      let configured = true
      yield* catalog.transform((catalog) => {
        models(catalog)
        if (configured) catalog.model.default.set(providerID, old)
      })
      expect((yield* catalog.model.default())?.id).toBe(old)

      configured = false
      yield* catalog.reload()
      expect((yield* catalog.model.default())?.id).toBe(newest)
    }),
  )

  it.effect("ignores a configured default on a disabled provider", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const disabledProvider = ProviderV2.ID.make("disabled")
      const enabledProvider = ProviderV2.ID.make("enabled")
      const disabledModel = ModelV2.ID.make("configured")
      const fallbackModel = ModelV2.ID.make("fallback")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(disabledProvider, (provider) => {
          provider.disabled = true
        })
        catalog.model.update(disabledProvider, disabledModel, () => {})
        catalog.provider.update(enabledProvider, () => {})
        catalog.model.update(enabledProvider, fallbackModel, () => {})
        catalog.model.default.set(disabledProvider, disabledModel)
      })

      expect(yield* catalog.model.default()).toMatchObject({
        providerID: enabledProvider,
        id: fallbackModel,
      })
    }),
  )

  it.effect("small model prefers small keyword candidates before cost scoring", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.make("test")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, ModelV2.ID.make("cheap-large"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [{ input: 1, output: 1, cache: { read: 0, write: 0 } }]
          model.time.released = Date.now()
        })
        catalog.model.update(providerID, ModelV2.ID.make("expensive-mini"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [{ input: 10, output: 10, cache: { read: 0, write: 0 } }]
          model.time.released = Date.now()
        })
      })

      expect((yield* catalog.model.small(providerID))?.id).toMatch("expensive-mini")
    }),
  )

  it.effect("removes providers denied by policy after loading", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const policy = yield* Policy.Service
      const providerID = ProviderV2.ID.make("blocked")
      yield* policy.load([new Policy.Info({ effect: "deny", action: "provider.use", resource: "blocked" })])
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, ModelV2.ID.make("model"), () => {})
      })

      expect(yield* catalog.provider.all()).toEqual([])
      expect(yield* catalog.model.all()).toEqual([])
      expect(yield* catalog.provider.get(providerID)).toBeUndefined()
    }),
  )
})
