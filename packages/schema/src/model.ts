export * as Model from "./model"

import { Schema } from "effect"
import { Provider } from "./provider"
import { withStatics } from "./schema"

export const ID = Schema.String.pipe(Schema.brand("ModelV2.ID"))
export type ID = typeof ID.Type

export const VariantID = Schema.String.pipe(Schema.brand("VariantID"))
export type VariantID = typeof VariantID.Type

export const Ref = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  variant: VariantID.pipe(Schema.optional),
})
export type Ref = typeof Ref.Type

export const Family = Schema.String.pipe(Schema.brand("Family"))
export type Family = typeof Family.Type

export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  tools: Schema.Boolean,
  input: Schema.String.pipe(Schema.Array, Schema.mutable),
  output: Schema.String.pipe(Schema.Array, Schema.mutable),
})

export interface Cost extends Schema.Schema.Type<typeof Cost> {}
export const Cost = Schema.Struct({
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Int,
  }).pipe(Schema.optional),
  input: Schema.Finite,
  output: Schema.Finite,
  cache: Schema.Struct({
    read: Schema.Finite,
    write: Schema.Finite,
  }),
})

export interface Variant extends Schema.Schema.Type<typeof Variant> {}
export const Variant = Schema.Struct({
  id: VariantID,
  ...Provider.Overlays,
})

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  providerID: Provider.ID,
  family: Family.pipe(Schema.optional),
  name: Schema.String,
  package: Schema.String.pipe(Schema.optional),
  aisdk: Schema.Literal(true).pipe(Schema.optional),
  ...Provider.Overlays,
  capabilities: Capabilities,
  variants: Variant.pipe(Schema.Array, Schema.mutable, Schema.optional),
  time: Schema.Struct({
    released: Schema.Finite,
  }),
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
      empty: (providerID: Provider.ID, modelID: ID) =>
        schema.make({
          id: modelID,
          providerID,
          name: modelID,
          capabilities: { tools: false, input: [], output: [] },
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 0, output: 0 },
        }),
    })),
  )
