export * as AdaptiveContextRender from "./render"

import { AdaptiveEvent } from "@opencode-ai/schema/adaptive-event"
import { AdaptiveOperation } from "@opencode-ai/schema/adaptive-operation"
import { AdaptiveRoadmap } from "@opencode-ai/schema/adaptive-roadmap"

type SortValue = string | number

const compare = (left: SortValue, right: SortValue) => {
  if (typeof left === "number" && typeof right === "number") return left - right
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const compareTuple = (left: readonly SortValue[], right: readonly SortValue[]) => {
  for (let index = 0; index < left.length; index++) {
    const result = compare(left[index], right[index])
    if (result !== 0) return result
  }
  return 0
}

const list = (values: readonly string[]) => values.map((value) => `- ${value}`)

const detailRef = (value: AdaptiveRoadmap.DetailRef) => `${value.kind}: ${value.key}@${value.version} [${value.status}]`

export function requirement(value: AdaptiveRoadmap.RequirementBaseline): string {
  return [
    "# Requirement Baseline",
    `Objective: ${value.objective}`,
    "Scope:",
    ...list(value.scope),
    "Constraints:",
    ...list(value.constraints),
    "Acceptance:",
    ...list(value.acceptance),
  ].join("\n")
}

export function roadmap(value: AdaptiveRoadmap.Info): string {
  const nodes = value.nodes
    .slice()
    .sort((left, right) => compareTuple([left.id, left.title], [right.id, right.title]))
    .flatMap((node, index) => [...(index === 0 ? [] : [""]), ...renderNode(node)])
  return [
    requirement(value.requirement),
    "",
    `# Roadmap r${value.revision}`,
    ...nodes,
    ...(value.risks.length > 0 ? ["", "# Roadmap Risks:", ...list(value.risks)] : []),
    ...(value.unresolved.length > 0 ? ["# Roadmap Unresolved:", ...list(value.unresolved)] : []),
  ].join("\n")
}

export function assignment(value: AdaptiveOperation.Assignment): string {
  return [
    `# Assignment ${value.id}`,
    `Node: ${value.nodeID}`,
    `Roadmap Revision: r${value.roadmapRevision}`,
    `Generation: ${value.generation}`,
    `Base Commit: ${value.baseCommit}`,
    "Detail References:",
    ...value.detailRefs
      .slice()
      .sort((left, right) => compareDetailRef(left, right))
      .map((ref) => `- ${detailRef(ref)}`),
    "Permitted Paths:",
    ...list(value.permittedPaths.slice().sort(compare)),
    "Acceptance Commands:",
    ...list(value.acceptanceCommands),
  ].join("\n")
}

export function detail(value: AdaptiveEvent.DetailRecord): string {
  return [
    `# Detail ${detailRef(value.ref)}`,
    `Node: ${value.nodeID}`,
    `Content Hash: ${value.contentHash}`,
    "",
    value.body,
  ].join("\n")
}

export function checkpoint(value: AdaptiveOperation.Checkpoint): string {
  return [
    `# Checkpoint ${value.sequence}`,
    `Node: ${value.nodeID}`,
    `Roadmap Revision: r${value.roadmapRevision}`,
    `Generation: ${value.generation}`,
    `Event Cursor: ${value.eventCursor}`,
    `Worktree Head: ${value.worktreeHead}`,
    `Diff Hash: ${value.diffHash}`,
    "Completed:",
    ...list(value.completed.slice().sort(compare)),
    "Decisions:",
    ...value.decisions
      .slice()
      .sort((left, right) => compareTuple([left.key, left.version], [right.key, right.version]))
      .map((decision) => `- ${decision.key}@${decision.version}`),
    "Modified Paths:",
    ...list(value.modifiedPaths.slice().sort(compare)),
    "Evidence:",
    ...list(value.evidence.slice().sort(compare)),
    "Remaining:",
    ...list(value.remaining.slice().sort(compare)),
    "Next Action:",
    value.nextAction,
  ].join("\n")
}

function renderNode(value: AdaptiveRoadmap.Node): readonly string[] {
  return [
    `## ${value.id} [${value.status}]`,
    `Title: ${value.title}`,
    `Owner: ${value.owner ?? "unassigned"}`,
    `Goal: ${value.goal}`,
    "Interfaces:",
    ...value.interfaces
      .slice()
      .sort((left, right) =>
        compareTuple(
          [left.key, left.name, left.kind, left.signature, left.version, left.state],
          [right.key, right.name, right.kind, right.signature, right.version, right.state],
        ),
      )
      .map((item) => `- ${item.name} | ${item.kind} | ${item.signature} | ${item.key}@${item.version} [${item.state}]`),
    "Dependencies:",
    ...value.dependencies
      .slice()
      .sort((left, right) =>
        compareTuple(
          [left.kind, left.nodeID, left.contractKey ?? "", left.reason],
          [right.kind, right.nodeID, right.contractKey ?? "", right.reason],
        ),
      )
      .map((dependency) =>
        `- ${dependency.kind}: ${dependency.nodeID}${dependency.contractKey ? ` (${dependency.contractKey})` : ""} - ${dependency.reason}`,
      ),
    "Details:",
    ...value.details
      .slice()
      .sort((left, right) => compareDetailRef(left, right))
      .map((ref) => `- ${detailRef(ref)}`),
    "Acceptance:",
    ...list(value.acceptance),
    ...(value.risks.length > 0 ? ["Risks:", ...list(value.risks)] : []),
    ...(value.unresolved.length > 0 ? ["Unresolved:", ...list(value.unresolved)] : []),
  ]
}

function compareDetailRef(left: AdaptiveRoadmap.DetailRef, right: AdaptiveRoadmap.DetailRef) {
  return compareTuple([left.kind, left.key, left.version, left.status], [right.kind, right.key, right.version, right.status])
}
