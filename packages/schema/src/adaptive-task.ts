export * as AdaptiveTask from "./adaptive-task"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { statics } from "./schema"

const id = <Prefix extends string, Brand extends string>(prefix: Prefix, brand: Brand) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^${prefix}[0-9A-Za-z]{26}$`))).pipe(
    Schema.brand(brand),
    Schema.annotate({ identifier: brand }),
    statics((schema) => ({ create: () => schema.make(prefix + ascending()) })),
  )

export const ID = id("adt_", "AdaptiveTask.ID")
export type ID = typeof ID.Type
export const AgentID = id("ada_", "AdaptiveTask.AgentID")
export type AgentID = typeof AgentID.Type
export const RequestID = id("adr_", "AdaptiveTask.RequestID")
export type RequestID = typeof RequestID.Type
export const ContextManifestID = id("acm_", "AdaptiveTask.ContextManifestID")
export type ContextManifestID = typeof ContextManifestID.Type

export const Mode = Schema.Literals(["normal", "benchmark"]).annotate({ identifier: "AdaptiveTask.Mode" })
export type Mode = typeof Mode.Type

export const Role = Schema.Literals([
  "coordinator",
  "roadmap-reviewer",
  "discovery",
  "implementation",
  "validator",
  "integration",
]).annotate({ identifier: "AdaptiveTask.Role" })
export type Role = typeof Role.Type

export const Status = Schema.Literals([
  "planning",
  "running",
  "needs_input",
  "stopped",
  "cancelled",
  "failed",
  "completed",
  "invalid",
]).annotate({ identifier: "AdaptiveTask.Status" })
export type Status = typeof Status.Type
