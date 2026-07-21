export * as AdaptiveEvent from "./adaptive-event"

import { Schema } from "effect"
import { AdaptiveOperation } from "./adaptive-operation"
import { AdaptiveRoadmap } from "./adaptive-roadmap"
import { AdaptiveTask } from "./adaptive-task"
import { Event } from "./event"
import { NonNegativeInt, optional, PositiveInt } from "./schema"

const Base = {
  taskID: AdaptiveTask.ID,
  timeCreated: NonNegativeInt,
}
const options = {
  durable: {
    aggregate: "taskID",
    version: 1,
  },
} as const
const ToolPreview = Schema.String.check(Schema.isMaxLength(8192))
const ToolPayloadBase = Schema.Struct({
  hash: AdaptiveOperation.Hash,
  preview: ToolPreview,
  complete: Schema.Boolean,
  blob: AdaptiveOperation.Hash.pipe(optional),
})
const durableToolPayload = Schema.makeFilter<Schema.Schema.Type<typeof ToolPayloadBase>>((payload) =>
  payload.complete || payload.blob !== undefined ? undefined : "An incomplete Tool payload requires a blob reference",
)

export interface ToolPayload extends Schema.Schema.Type<typeof ToolPayload> {}
export const ToolPayload = ToolPayloadBase.annotate({ identifier: "AdaptiveEvent.ToolPayload" }).check(
  durableToolPayload,
)

export class DetailRecord extends Schema.Class<DetailRecord>("AdaptiveEvent.DetailRecord")({
  nodeID: Schema.String,
  ref: AdaptiveRoadmap.DetailRef,
  body: Schema.String,
  contentHash: AdaptiveOperation.Hash,
}) {}

export const TaskCreated = Event.define({
  type: "adaptive.task.created",
  ...options,
  schema: { ...Base, task: AdaptiveTask.Summary },
})
export type TaskCreated = typeof TaskCreated.Type

export const RoadmapCommitted = Event.define({
  type: "adaptive.roadmap.committed",
  ...options,
  schema: {
    ...Base,
    roadmap: AdaptiveRoadmap.Info,
    details: Schema.Array(DetailRecord),
    contentHash: AdaptiveOperation.Hash,
    sourceAgentID: AdaptiveTask.AgentID,
    sourceGeneration: PositiveInt,
  },
})
export type RoadmapCommitted = typeof RoadmapCommitted.Type

export const DetailCommitted = Event.define({
  type: "adaptive.detail.committed",
  ...options,
  schema: {
    ...Base,
    detail: DetailRecord,
    sourceAgentID: AdaptiveTask.AgentID,
    sourceGeneration: PositiveInt,
  },
})
export type DetailCommitted = typeof DetailCommitted.Type

export const AssignmentCreated = Event.define({
  type: "adaptive.assignment.created",
  ...options,
  schema: { ...Base, assignment: AdaptiveOperation.Assignment },
})
export type AssignmentCreated = typeof AssignmentCreated.Type

export const AgentGenerationStarted = Event.define({
  type: "adaptive.agent.generation.started",
  ...options,
  schema: {
    ...Base,
    agentID: AdaptiveTask.AgentID,
    role: AdaptiveTask.Role,
    generation: PositiveInt,
    nodeID: Schema.String.pipe(optional),
    assignmentID: AdaptiveOperation.AssignmentID.pipe(optional),
    reason: Schema.String.pipe(optional),
  },
})
export type AgentGenerationStarted = typeof AgentGenerationStarted.Type

export const AgentGenerationLost = Event.define({
  type: "adaptive.agent.generation.lost",
  ...options,
  schema: {
    ...Base,
    agentID: AdaptiveTask.AgentID,
    role: AdaptiveTask.Role,
    generation: PositiveInt,
    nodeID: Schema.String.pipe(optional),
    assignmentID: AdaptiveOperation.AssignmentID.pipe(optional),
    reason: Schema.String,
  },
})
export type AgentGenerationLost = typeof AgentGenerationLost.Type

export const RecoveryVerified = Event.define({
  type: "adaptive.recovery.verified",
  ...options,
  schema: { ...Base, verification: AdaptiveOperation.RecoveryVerification },
})
export type RecoveryVerified = typeof RecoveryVerified.Type

export const ToolCalled = Event.define({
  type: "adaptive.tool.called",
  ...options,
  schema: {
    ...Base,
    agentID: AdaptiveTask.AgentID,
    generation: PositiveInt,
    assignmentID: AdaptiveOperation.AssignmentID.pipe(optional),
    tool: Schema.String,
    callID: Schema.String,
    input: ToolPayload,
  },
})
export type ToolCalled = typeof ToolCalled.Type

export const ToolSettled = Event.define({
  type: "adaptive.tool.settled",
  ...options,
  schema: {
    ...Base,
    agentID: AdaptiveTask.AgentID,
    generation: PositiveInt,
    assignmentID: AdaptiveOperation.AssignmentID.pipe(optional),
    tool: Schema.String,
    callID: Schema.String,
    status: Schema.Literals(["succeeded", "failed", "denied", "interrupted"]),
    output: ToolPayload,
    errorCode: Schema.String.pipe(optional),
  },
})
export type ToolSettled = typeof ToolSettled.Type

export const DecisionRecorded = Event.define({
  type: "adaptive.decision.recorded",
  ...options,
  schema: {
    ...Base,
    agentID: AdaptiveTask.AgentID,
    generation: PositiveInt,
    nodeID: Schema.String,
    detail: AdaptiveRoadmap.DetailRef,
    summary: Schema.String,
    reason: Schema.String,
    evidence: Schema.Array(AdaptiveOperation.EvidenceRef),
  },
})
export type DecisionRecorded = typeof DecisionRecorded.Type

export const DependencyReported = Event.define({
  type: "adaptive.dependency.reported",
  ...options,
  schema: {
    ...Base,
    agentID: AdaptiveTask.AgentID,
    generation: PositiveInt,
    nodeID: Schema.String,
    targetNodeID: Schema.String,
    currentKind: AdaptiveRoadmap.DependencyKind,
    proposedKind: AdaptiveRoadmap.DependencyKind,
    reason: Schema.String,
    blocksCorrectness: Schema.Boolean,
  },
})
export type DependencyReported = typeof DependencyReported.Type

export const CheckpointSaved = Event.define({
  type: "adaptive.checkpoint.saved",
  ...options,
  schema: { ...Base, checkpoint: AdaptiveOperation.Checkpoint },
})
export type CheckpointSaved = typeof CheckpointSaved.Type

export const CandidateSubmitted = Event.define({
  type: "adaptive.candidate.submitted",
  ...options,
  schema: { ...Base, report: AdaptiveOperation.CandidateReport },
})
export type CandidateSubmitted = typeof CandidateSubmitted.Type

export const ContextSplitRequired = Event.define({
  type: "adaptive.context.split.required",
  ...options,
  schema: {
    ...Base,
    agentID: AdaptiveTask.AgentID,
    generation: PositiveInt,
    nodeID: Schema.String,
    assignmentID: AdaptiveOperation.AssignmentID.pipe(optional),
    reasonCode: Schema.Literal("CONTEXT_SPLIT_REQUIRED"),
    reason: Schema.String,
    mandatoryTokens: NonNegativeInt,
    inputBudget: NonNegativeInt,
  },
})
export type ContextSplitRequired = typeof ContextSplitRequired.Type

export const DurableDefinitions = Event.inventory(
  TaskCreated,
  RoadmapCommitted,
  DetailCommitted,
  AssignmentCreated,
  AgentGenerationStarted,
  AgentGenerationLost,
  RecoveryVerified,
  ToolCalled,
  ToolSettled,
  DecisionRecorded,
  DependencyReported,
  CheckpointSaved,
  CandidateSubmitted,
  ContextSplitRequired,
)

export const Definitions = Event.inventory(...DurableDefinitions)
export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" })
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "AdaptiveDurableEvent" })
export type DurableEvent = typeof Durable.Type

export const All = Schema.Union(Definitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type Event = typeof All.Type
export type Type = Event["type"]
