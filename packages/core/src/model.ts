import { Schema } from "effect"
import { Model } from "@opencode-ai/schema/model"
import { ProviderV2 } from "./provider"
import { withStatics } from "./schema"
import type { DeepMutable } from "./schema"

export const ID = Model.ID
export type ID = typeof ID.Type

export const VariantID = Model.VariantID
export type VariantID = typeof VariantID.Type

export const Family = Model.Family
export type Family = Model.Family

export const Capabilities = Model.Capabilities
export type Capabilities = Model.Capabilities

export const Cost = Model.Cost

export const Ref = Model.Ref
export type Ref = typeof Ref.Type

// Temporary runtime schema until core catalog consumers migrate to the flat
// package identity in @opencode-ai/schema.
export const Api = Schema.Union([
  Schema.Struct({ id: ID, ...ProviderV2.AISDK.fields }),
  Schema.Struct({ id: ID, ...ProviderV2.Native.fields }),
]).pipe(Schema.toTaggedUnion("type"))
export type Api = typeof Api.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  providerID: ProviderV2.ID,
  family: Family.pipe(Schema.optional),
  name: Schema.String,
  api: Api,
  capabilities: Capabilities,
  request: Schema.Struct({
    ...ProviderV2.Request.fields,
    variant: Schema.String.pipe(Schema.optional),
  }),
  variants: Schema.Struct({
    id: VariantID,
    ...ProviderV2.Request.fields,
  }).pipe(Schema.Array, Schema.mutable),
  time: Schema.Struct({ released: Schema.Finite }),
  cost: Cost.pipe(Schema.Array, Schema.mutable),
  status: Schema.Literals(["alpha", "beta", "deprecated", "active"]),
  enabled: Schema.Boolean,
  limit: Schema.Struct({
    context: Schema.Int,
    input: Schema.Int.pipe(Schema.optional),
    output: Schema.Int,
  }),
})
  .annotate({ identifier: "ModelV2.Info" })
  .pipe(
    withStatics((schema) => ({
      empty: (providerID: ProviderV2.ID, modelID: ID) =>
        schema.make({
          id: modelID,
          providerID,
          name: modelID,
          api: { id: modelID, type: "native", settings: {} },
          capabilities: { tools: false, input: [], output: [] },
          request: { headers: {}, body: {} },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 0, output: 0 },
        }),
    })),
  )

export type MutableInfo = Omit<DeepMutable<Info>, "api"> & { api: ProviderV2.MutableApi<Api> }

export function parse(input: string): { providerID: ProviderV2.ID; modelID: ID } {
  const [providerID, ...modelID] = input.split("/")
  return {
    providerID: ProviderV2.ID.make(providerID),
    modelID: ID.make(modelID.join("/")),
  }
}

export * as ModelV2 from "./model"
