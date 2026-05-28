import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { ConfigProvider } from "@opencode-ai/core/config/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { it } from "../plugin/provider-helper"

function options(headers: Record<string, string>, variant?: string) {
  return {
    headers,
    body: {},
    aisdk: {
      provider: {},
      request: {},
    },
    variant,
  }
}

const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigProvider.Plugin", () => {
  it.effect("loads configured providers and applies later model overrides", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const plugin = yield* PluginV2.Service
      const providerID = ProviderV2.ID.make("custom")
      const modelID = ModelV2.ID.make("chat")
      const config = Config.Service.of({
        directories: () => Effect.succeed([]),
        get: () =>
          Effect.succeed([
            new Config.Loaded({
              source: new Config.MemorySource({ type: "memory" }),
              info: decode({
                providers: {
                  custom: {
                    name: "Configured",
                    endpoint: { type: "unknown" },
                    options: options({ first: "first", shared: "first" }),
                    models: {
                      chat: {
                        name: "First",
                        capabilities: { tools: true, input: ["text"], output: ["text"] },
                        enabled: false,
                        limit: { context: 100, output: 50 },
                        options: options({ first: "first", shared: "first" }, "retained"),
                        variants: [
                          {
                            id: "fast",
                            headers: { first: "first", shared: "first" },
                            body: {},
                            aisdk: { provider: {}, request: {} },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            }),
            new Config.Loaded({
              source: new Config.MemorySource({ type: "memory" }),
              info: decode({
                providers: {
                  custom: {
                    endpoint: { type: "aisdk", package: "custom-sdk", url: "https://example.test" },
                    options: options({ last: "last", shared: "last" }),
                    models: {
                      chat: {
                        apiID: "api-chat",
                        name: "Last",
                        options: options({ last: "last", shared: "last" }),
                        variants: [
                          {
                            id: "fast",
                            headers: { last: "last", shared: "last" },
                            body: {},
                            aisdk: { provider: {}, request: {} },
                          },
                          {
                            id: "slow",
                            headers: { slow: "slow" },
                            body: {},
                            aisdk: { provider: {}, request: {} },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            }),
            new Config.Loaded({
              source: new Config.MemorySource({ type: "memory" }),
              info: decode({
                providers: {
                  custom: { name: "Renamed" },
                },
              }),
            }),
          ]),
      })

      yield* plugin.add({
        ...ConfigProvider.Plugin,
        effect: ConfigProvider.Plugin.effect.pipe(
          Effect.provideService(Config.Service, config),
          Effect.provideService(Catalog.Service, catalog),
        ),
      })

      const provider = yield* catalog.provider.get(providerID)
      const model = yield* catalog.model.get(providerID, modelID)
      expect(provider.name).toBe("Renamed")
      expect(provider.enabled).toEqual({ via: "custom", data: {} })
      expect(provider.endpoint).toEqual({ type: "aisdk", package: "custom-sdk", url: "https://example.test" })
      expect(provider.options.headers).toEqual({ first: "first", shared: "last", last: "last" })
      expect(model.apiID).toBe(ModelV2.ID.make("api-chat"))
      expect(model.name).toBe("Last")
      expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
      expect(model.enabled).toBe(false)
      expect(model.limit).toEqual({ context: 100, output: 50 })
      expect(model.options.headers).toEqual({ first: "first", shared: "last", last: "last" })
      expect(model.options.variant).toBe("retained")
      expect(model.variants.map((variant) => variant.id)).toEqual([
        ModelV2.VariantID.make("fast"),
        ModelV2.VariantID.make("slow"),
      ])
      expect(model.variants[0]?.headers).toEqual({ first: "first", shared: "last", last: "last" })
      expect(model.variants[1]?.headers).toEqual({ slow: "slow" })
    }),
  )
})
