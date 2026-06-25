export * as ProviderV2 from "./provider"

import { Schema } from "effect"
import { Provider } from "@opencode-ai/schema/provider"
import { Integration } from "./integration"
import { withStatics } from "./schema"
import type { DeepMutable } from "./schema"

export const ID = Provider.ID
export type ID = typeof ID.Type

// Temporary runtime schema until core catalog consumers migrate to the flat
// package identity in @opencode-ai/schema.
export interface AISDK extends Schema.Schema.Type<typeof AISDK> {}
export const AISDK = Schema.Struct({
  type: Schema.Literal("aisdk"),
  package: Schema.String,
  url: Schema.String.pipe(Schema.optional),
  settings: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
})

export interface Native extends Schema.Schema.Type<typeof Native> {}
export const Native = Schema.Struct({
  type: Schema.Literal("native"),
  url: Schema.String.pipe(Schema.optional),
  settings: Schema.Record(Schema.String, Schema.Unknown),
})

export const Api = Schema.Union([AISDK, Native]).pipe(Schema.toTaggedUnion("type"))
export type Api = typeof Api.Type

export const Request = Provider.Request
export type Request = Provider.Request

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  integrationID: Integration.ID.pipe(Schema.optional),
  name: Schema.String,
  disabled: Schema.Boolean.pipe(Schema.optional),
  api: Api,
  request: Request,
})
  .annotate({ identifier: "ProviderV2.Info" })
  .pipe(
    withStatics((schema) => ({
      empty: (id: ID) =>
        schema.make({
          id,
          name: id,
          api: { type: "native", settings: {} },
          request: { headers: {}, body: {} },
        }),
    })),
  )

export type MutableApi<T extends Api = Api> = T extends Api
  ? Omit<DeepMutable<T>, "settings"> & (undefined extends T["settings"] ? { settings?: any } : { settings: any })
  : never

export type MutableInfo = Omit<DeepMutable<Info>, "api"> & { api: MutableApi }
