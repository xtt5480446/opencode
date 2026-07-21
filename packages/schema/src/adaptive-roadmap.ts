export * as AdaptiveRoadmap from "./adaptive-roadmap"

import { Schema } from "effect"
import { AdaptiveTask } from "./adaptive-task"
import { NonNegativeInt, optional } from "./schema"

export const NodeStatus = Schema.Literals([
  "unresolved",
  "discovering",
  "blocked",
  "ready",
  "running",
  "candidate",
  "validating",
  "integrated",
  "failed",
  "conflict",
]).annotate({ identifier: "AdaptiveRoadmap.NodeStatus" })
export type NodeStatus = typeof NodeStatus.Type

export const DependencyKind = Schema.Literals(["hard", "contract", "informational", "validation"]).annotate({
  identifier: "AdaptiveRoadmap.DependencyKind",
})
export type DependencyKind = typeof DependencyKind.Type

export const DetailKind = Schema.Literals(["requirements", "contracts", "decisions", "validation"]).annotate({
  identifier: "AdaptiveRoadmap.DetailKind",
})
export type DetailKind = typeof DetailKind.Type

export const DetailStatus = Schema.Literals(["unresolved", "draft", "ready", "superseded"]).annotate({
  identifier: "AdaptiveRoadmap.DetailStatus",
})
export type DetailStatus = typeof DetailStatus.Type

export class RequirementBaseline extends Schema.Class<RequirementBaseline>("AdaptiveRoadmap.RequirementBaseline")({
  objective: Schema.String,
  scope: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  acceptance: Schema.Array(Schema.String),
}) {}

export class DetailRef extends Schema.Class<DetailRef>("AdaptiveRoadmap.DetailRef")({
  key: Schema.String,
  kind: DetailKind,
  version: NonNegativeInt,
  status: DetailStatus,
}) {}

export class InterfaceRef extends Schema.Class<InterfaceRef>("AdaptiveRoadmap.InterfaceRef")({
  key: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["function", "type", "schema", "command", "file-format", "service", "other"]),
  signature: Schema.String,
  version: NonNegativeInt,
  state: DetailStatus,
}) {}

export class Dependency extends Schema.Class<Dependency>("AdaptiveRoadmap.Dependency")({
  nodeID: Schema.String,
  kind: DependencyKind,
  contractKey: Schema.String.pipe(optional),
  reason: Schema.String,
}) {}

export class Node extends Schema.Class<Node>("AdaptiveRoadmap.Node")({
  id: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  status: NodeStatus,
  owner: AdaptiveTask.AgentID.pipe(optional),
  interfaces: Schema.Array(InterfaceRef),
  dependencies: Schema.Array(Dependency),
  details: Schema.Array(DetailRef),
  acceptance: Schema.Array(Schema.String),
  risks: Schema.Array(Schema.String),
  unresolved: Schema.Array(Schema.String),
}) {}

export class Info extends Schema.Class<Info>("AdaptiveRoadmap.Info")({
  taskID: AdaptiveTask.ID,
  revision: NonNegativeInt,
  requirement: RequirementBaseline,
  nodes: Schema.Array(Node),
  risks: Schema.Array(Schema.String),
  unresolved: Schema.Array(Schema.String),
}) {}
