export * as ConfigProvider from "./provider"

import { Effect, Schema } from "effect"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { ProviderV2 } from "../provider"
import { ModelV2 } from "../model"
import { PluginV2 } from "../plugin"

class Model extends Schema.Class<Model>("ConfigV2.Model")({
  apiID: ModelV2.ID.pipe(Schema.optional),
  family: ModelV2.Family.pipe(Schema.optional),
  name: Schema.String.pipe(Schema.optional),
  endpoint: ProviderV2.Endpoint.pipe(Schema.optional),
  capabilities: ModelV2.Capabilities.pipe(Schema.optional),
  options: Schema.Struct({
    ...ProviderV2.Options.fields,
    variant: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  variants: Schema.Struct({
    id: ModelV2.VariantID,
    ...ProviderV2.Options.fields,
  }).pipe(Schema.Array, Schema.optional),
  cost: ModelV2.Cost.pipe(Schema.Array).pipe(Schema.optional),
  enabled: Schema.Boolean.pipe(Schema.optional),
  limit: Schema.Struct({
    context: Schema.Int,
    input: Schema.Int.pipe(Schema.optional),
    output: Schema.Int,
  }).pipe(Schema.optional),
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Provider")({
  name: Schema.String.pipe(Schema.optional),
  endpoint: ProviderV2.Endpoint.pipe(Schema.optional),
  options: ProviderV2.Options.pipe(Schema.optional),
  models: Schema.Record(Schema.String, Model).pipe(Schema.optional),
}) {}

export const Plugin = PluginV2.define({
  id: PluginV2.ID.make("config-provider"),
  effect: Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const config = yield* Config.Service
    const load = yield* catalog.loader()
    const files = yield* config.get()

    yield* load((catalog) => {
      for (const file of files) {
        for (const [id, item] of Object.entries(file.info.providers ?? {})) {
          const providerID = ProviderV2.ID.make(id)
          catalog.provider.update(providerID, (provider) => {
            if (item.name !== undefined) provider.name = item.name
            provider.enabled = { via: "custom", data: {} }
            if (item.endpoint !== undefined) provider.endpoint = { ...item.endpoint }
            if (item.options !== undefined) {
              Object.assign(provider.options.headers, item.options.headers)
              Object.assign(provider.options.body, item.options.body)
              Object.assign(provider.options.aisdk.provider, item.options.aisdk.provider)
              Object.assign(provider.options.aisdk.request, item.options.aisdk.request)
            }
          })

          for (const [id, config] of Object.entries(item.models ?? {})) {
            catalog.model.update(providerID, ModelV2.ID.make(id), (model) => {
              if (config.apiID !== undefined) model.apiID = config.apiID
              if (config.family !== undefined) model.family = config.family
              if (config.name !== undefined) model.name = config.name
              if (config.endpoint !== undefined) model.endpoint = { ...config.endpoint }
              if (config.capabilities !== undefined) {
                model.capabilities = {
                  tools: config.capabilities.tools,
                  input: [...config.capabilities.input],
                  output: [...config.capabilities.output],
                }
              }
              if (config.options !== undefined) {
                Object.assign(model.options.headers, config.options.headers)
                Object.assign(model.options.body, config.options.body)
                Object.assign(model.options.aisdk.provider, config.options.aisdk.provider)
                Object.assign(model.options.aisdk.request, config.options.aisdk.request)
                if (config.options.variant !== undefined) model.options.variant = config.options.variant
              }
              if (config.variants !== undefined) {
                for (const variant of config.variants) {
                  let existing = model.variants.find((item) => item.id === variant.id)
                  if (!existing) {
                    existing = {
                      id: variant.id,
                      headers: {},
                      body: {},
                      aisdk: {
                        provider: {},
                        request: {},
                      },
                    }
                    model.variants.push(existing)
                  }
                  Object.assign(existing.headers, variant.headers)
                  Object.assign(existing.body, variant.body)
                  Object.assign(existing.aisdk.provider, variant.aisdk.provider)
                  Object.assign(existing.aisdk.request, variant.aisdk.request)
                }
              }
              if (config.cost !== undefined) {
                model.cost = config.cost.map((cost) => ({
                  tier: cost.tier && { ...cost.tier },
                  input: cost.input,
                  output: cost.output,
                  cache: { ...cost.cache },
                }))
              }
              if (config.enabled !== undefined) model.enabled = config.enabled
              if (config.limit !== undefined) model.limit = { ...config.limit }
            })
          }
        }
      }
    })
  }),
})
