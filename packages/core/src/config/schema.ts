export * as ConfigV2 from "./schema"

import { Schema } from "effect"
import { Catalog } from "../catalog"
import { Policy as PolicyV2 } from "../policy"
import { ConfigProvider } from "./provider"

// Each core domain exports the policy actions it supports. Adding an action to
// this union makes it valid in authored config while keeping Policy generic.
export const PolicyAction = Schema.Union([Catalog.PolicyActions])

export class Policy extends Schema.Class<Policy>("ConfigV2.Policy")({
  ...PolicyV2.Info.fields,
  action: PolicyAction,
}) {}

export class Info extends Schema.Class<Info>("ConfigV2.Info")({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.String.pipe(Schema.optional).annotate({
    description: "Default shell to use for terminal and shell tool execution",
  }),
  policies: Policy.pipe(Schema.Array, Schema.optional),
  providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(Schema.optional),
}) {}

export class FileSource extends Schema.Class<FileSource>("ConfigV2.FileSource")({
  type: Schema.Literal("file"),
  path: Schema.String,
}) {}

export class MemorySource extends Schema.Class<MemorySource>("ConfigV2.MemorySource")({
  type: Schema.Literal("memory"),
}) {}

export const Source = Schema.Union([FileSource, MemorySource]).pipe(Schema.toTaggedUnion("type"))
export type Source = typeof Source.Type

export class Loaded extends Schema.Class<Loaded>("ConfigV2.Loaded")({
  source: Source,
  info: Info,
}) {}
