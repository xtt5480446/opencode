export * as AdaptiveOperation from "./adaptive-operation"

import { Schema } from "effect"
import { AdaptiveRoadmap } from "./adaptive-roadmap"
import { AdaptiveTask } from "./adaptive-task"
import { ascending } from "./identifier"
import { NonNegativeInt, PositiveInt, RelativePath, statics } from "./schema"

export const AssignmentID = Schema.String.annotate({ identifier: "AdaptiveOperation.AssignmentID" })
  .check(Schema.isPattern(/^aas_[0-9A-Za-z]{26}$/))
  .pipe(
    Schema.brand("AdaptiveOperation.AssignmentID"),
    statics((schema) => ({ create: () => schema.make("aas_" + ascending()) })),
  )
export type AssignmentID = typeof AssignmentID.Type

export const Hash = Schema.String.annotate({ identifier: "AdaptiveOperation.Hash" }).check(
  Schema.isPattern(/^sha256:[0-9a-f]{64}$/),
)
export type Hash = typeof Hash.Type

export const EvidenceRef = Schema.String.annotate({ identifier: "AdaptiveOperation.EvidenceRef" })
export type EvidenceRef = typeof EvidenceRef.Type

export class VersionRef extends Schema.Class<VersionRef>("AdaptiveOperation.VersionRef")({
  key: Schema.String,
  version: NonNegativeInt,
}) {}

export class Assignment extends Schema.Class<Assignment>("AdaptiveOperation.Assignment")({
  id: AssignmentID,
  taskID: AdaptiveTask.ID,
  workerID: AdaptiveTask.AgentID,
  nodeID: Schema.String,
  roadmapRevision: NonNegativeInt,
  detailRefs: Schema.Array(AdaptiveRoadmap.DetailRef),
  permittedPaths: Schema.Array(RelativePath),
  baseCommit: Schema.String,
  acceptanceCommands: Schema.Array(Schema.String),
  generation: PositiveInt,
  timeCreated: NonNegativeInt,
}) {}

export class Checkpoint extends Schema.Class<Checkpoint>("AdaptiveOperation.Checkpoint")({
  assignmentID: AssignmentID,
  workerID: AdaptiveTask.AgentID,
  generation: PositiveInt,
  sequence: NonNegativeInt,
  eventCursor: NonNegativeInt,
  roadmapRevision: NonNegativeInt,
  nodeID: Schema.String,
  completed: Schema.Array(Schema.String),
  decisions: Schema.Array(VersionRef),
  modifiedPaths: Schema.Array(RelativePath),
  evidence: Schema.Array(EvidenceRef),
  remaining: Schema.Array(Schema.String),
  nextAction: Schema.String,
  worktreeHead: Schema.String,
  diffHash: Hash,
  timeCreated: NonNegativeInt,
}) {}

export class KeyFile extends Schema.Class<KeyFile>("AdaptiveOperation.KeyFile")({
  path: RelativePath,
  contentHash: Hash,
}) {}

export class RecoveryVerification extends Schema.Class<RecoveryVerification>("AdaptiveOperation.RecoveryVerification")({
  assignmentID: AssignmentID,
  workerID: AdaptiveTask.AgentID,
  generation: PositiveInt,
  roadmapRevision: NonNegativeInt,
  observedHead: Schema.String,
  diffHash: Hash,
  statusLines: Schema.Array(Schema.String),
  keyFiles: Schema.Array(KeyFile),
  revalidatedEvidence: Schema.Array(EvidenceRef),
  discrepancies: Schema.Array(Schema.String),
  consistent: Schema.Boolean,
  timeCreated: NonNegativeInt,
}) {}

export class CandidateReport extends Schema.Class<CandidateReport>("AdaptiveOperation.CandidateReport")({
  assignmentID: AssignmentID,
  workerID: AdaptiveTask.AgentID,
  generation: PositiveInt,
  nodeID: Schema.String,
  headCommit: Schema.String,
  diffHash: Hash,
  modifiedPaths: Schema.Array(RelativePath),
  evidence: Schema.Array(EvidenceRef),
  remainingRisks: Schema.Array(Schema.String),
  detailRefs: Schema.Array(AdaptiveRoadmap.DetailRef),
  timeCreated: NonNegativeInt,
}) {}
