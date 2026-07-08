export * as Search from "./search.js"

import { Schema } from "effect"
import { IntegrationID } from "./integration-id.js"
import { optional } from "./schema.js"

export interface Input extends Schema.Schema.Type<typeof Input> {}
export const Input = Schema.Struct({
  query: Schema.String,
  providerID: IntegrationID.pipe(optional),
}).annotate({ identifier: "Search.Input" })

export interface ProviderOutput extends Schema.Schema.Type<typeof ProviderOutput> {}
export const ProviderOutput = Schema.Struct({
  text: Schema.String,
  metadata: Schema.Json.pipe(optional),
}).annotate({ identifier: "Search.ProviderOutput" })

export class Result extends Schema.Class<Result>("Search.Result")({
  providerID: IntegrationID,
  ...ProviderOutput.fields,
}) {}
