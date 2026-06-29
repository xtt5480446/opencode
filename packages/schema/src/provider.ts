export * as Provider from "./provider"

import { Schema } from "effect"
import { Integration } from "./integration"
import { optional, statics } from "./schema"

export const ID = Schema.String.pipe(
  Schema.brand("ProviderV2.ID"),
  statics((schema) => ({
    opencode: schema.make("opencode"),
    anthropic: schema.make("anthropic"),
    openai: schema.make("openai"),
    google: schema.make("google"),
    googleVertex: schema.make("google-vertex"),
    githubCopilot: schema.make("github-copilot"),
    amazonBedrock: schema.make("amazon-bedrock"),
    azure: schema.make("azure"),
    openrouter: schema.make("openrouter"),
    mistral: schema.make("mistral"),
    gitlab: schema.make("gitlab"),
  })),
)
export type ID = typeof ID.Type

export const Package = Schema.String
export type Package = typeof Package.Type

export const Overlays = {
  settings: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  headers: Schema.Record(Schema.String, Schema.String).pipe(optional),
  body: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
}

export interface Request extends Schema.Schema.Type<typeof Request> {}
export const Request = Schema.Struct({
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Record(Schema.String, Schema.Json),
}).annotate({ identifier: "Provider.Request" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  integrationID: Integration.ID.pipe(optional),
  name: Schema.String,
  disabled: Schema.Boolean.pipe(optional),
  package: Package,
  ...Overlays,
})
  .annotate({ identifier: "ProviderV2.Info" })
  .pipe(
    statics((schema) => ({
      empty: (id: ID) => schema.make({ id, name: id, package: "" }),
    })),
  )
