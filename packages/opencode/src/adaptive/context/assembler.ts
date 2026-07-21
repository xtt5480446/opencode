export * as AdaptiveContextAssembler from "./assembler"

import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { AdaptiveRecoveryStore } from "@opencode-ai/core/adaptive/recovery-store"
import { AdaptiveRoadmapStore } from "@opencode-ai/core/adaptive/roadmap-store"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { AdaptiveEvent } from "@opencode-ai/schema/adaptive-event"
import { AdaptiveOperation } from "@opencode-ai/schema/adaptive-operation"
import { AdaptiveRoadmap } from "@opencode-ai/schema/adaptive-roadmap"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { AdaptiveDurable } from "@opencode-ai/schema/durable-event-manifest"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { AdaptiveContextComponent } from "./component"
import { AdaptiveContextRequest } from "./request"
import { AdaptiveContextRender } from "./render"

export interface TextSource {
  readonly sourceRevision: string
  readonly text: string
}

export interface ValidationSource extends TextSource {
  readonly key: string
  readonly status: "succeeded" | "failed"
}

export interface EventSource {
  readonly id: string
  readonly sequence: number
  readonly text: string
}

export interface LocalTailSource extends TextSource {
  readonly turns: number
}

interface InvocationInput {
  readonly id: AdaptiveTask.ContextManifestID
  readonly taskID: AdaptiveTask.ID
  readonly agentID: AdaptiveTask.AgentID
  readonly generation: number
  readonly owner: string
  readonly purpose: string
  readonly turn: number
  readonly roleInstructions: string
  readonly assignmentID?: AdaptiveOperation.AssignmentID
  readonly workspace?: TextSource
  readonly validations?: readonly ValidationSource[]
  readonly openedDetails?: readonly AdaptiveRoadmap.DetailRef[]
  readonly repoMap?: TextSource
  readonly localTail?: LocalTailSource
  readonly messages: readonly unknown[]
  readonly tools: readonly unknown[]
}

export interface Input extends InvocationInput {}

export interface SourceInput extends Omit<InvocationInput, "assignmentID"> {
  readonly agentRole?: AdaptiveTask.Role
  readonly roadmap: AdaptiveRoadmap.Info
  readonly assignment?: AdaptiveOperation.Assignment
  readonly coordinatorCycle?: TextSource
  readonly details: readonly AdaptiveEvent.DetailRecord[]
  readonly checkpoint?: AdaptiveOperation.Checkpoint
  readonly events?: readonly EventSource[]
}

export interface PlanInput extends SourceInput {
  readonly modelPolicy: AdaptiveTask.ModelPolicy
}

export interface Omission {
  readonly key: string
  readonly kind: AdaptiveContextComponent.Kind
  readonly tokens: number
  readonly reason: "budget"
}

export interface ReadyPlan {
  readonly _tag: "Ready"
  readonly inputBudget: number
  readonly components: readonly AdaptiveContextComponent.Component[]
  readonly omissions: readonly Omission[]
  readonly system: readonly string[]
  readonly messages: readonly AdaptiveStore.JsonValue[]
  readonly tools: readonly AdaptiveStore.JsonValue[]
  readonly estimatedTokens: number
  readonly requestHash: string
  readonly promptCacheKey: string
  readonly restartRequired: boolean
  readonly restartReason?: "context_80_percent" | "local_tail_limit" | "event_tail_limit"
}

export interface InvalidSourcePlan {
  readonly _tag: "InvalidSource"
  readonly reason: string
}

export interface ContextBudgetUnsatisfiablePlan {
  readonly _tag: "ContextBudgetUnsatisfiable"
  readonly mandatoryTokens: number
  readonly inputBudget: number
}

export interface ContextSplitRequiredPlan {
  readonly _tag: "ContextSplitRequired"
  readonly mandatoryTokens: number
  readonly inputBudget: number
  readonly nodeID: string
  readonly assignmentID?: AdaptiveOperation.AssignmentID
}

export type Plan = ReadyPlan | InvalidSourcePlan | ContextBudgetUnsatisfiablePlan | ContextSplitRequiredPlan

export interface Assembled extends ReadyPlan {
  readonly manifest: AdaptiveStore.ManifestRecord
}

export class InvalidSourceError extends Schema.TaggedErrorClass<InvalidSourceError>()(
  "AdaptiveContextAssembler.InvalidSource",
  { taskID: AdaptiveTask.ID, reason: Schema.String },
) {}

export class ContextBudgetUnsatisfiableError extends Schema.TaggedErrorClass<ContextBudgetUnsatisfiableError>()(
  "AdaptiveContextAssembler.ContextBudgetUnsatisfiable",
  {
    taskID: AdaptiveTask.ID,
    mandatoryTokens: Schema.Number,
    inputBudget: Schema.Number,
  },
) {}

export class ContextSplitRequiredError extends Schema.TaggedErrorClass<ContextSplitRequiredError>()(
  "AdaptiveContextAssembler.ContextSplitRequired",
  {
    taskID: AdaptiveTask.ID,
    agentID: AdaptiveTask.AgentID,
    generation: Schema.Number,
    nodeID: Schema.String,
    mandatoryTokens: Schema.Number,
    inputBudget: Schema.Number,
  },
) {}

export type Error =
  | InvalidSourceError
  | ContextBudgetUnsatisfiableError
  | ContextSplitRequiredError
  | AdaptiveStore.TaskNotFoundError
  | AdaptiveStore.AgentNotFoundError
  | AdaptiveStore.CorruptModelPolicyError
  | AdaptiveStore.InvalidManifestError
  | AdaptiveStore.DuplicateManifestError
  | AdaptiveStore.ManifestOwnershipMismatchError
  | AdaptiveStore.ManifestSourceChangedError
  | AdaptiveRoadmapStore.TaskNotFoundError
  | AdaptiveRoadmapStore.RoadmapNotFoundError
  | AdaptiveRoadmapStore.CorruptRoadmapError
  | AdaptiveRoadmapStore.DetailNotFoundError
  | AdaptiveRoadmapStore.CorruptDetailError
  | AdaptiveRecoveryStore.AssignmentNotFoundError
  | AdaptiveRecoveryStore.CorruptAssignmentError
  | AdaptiveRecoveryStore.CorruptCheckpointError

export interface Interface {
  readonly assemble: (input: Input) => Effect.Effect<Assembled, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AdaptiveContextAssembler") {}

const selectionRank: Record<AdaptiveContextComponent.Priority, number> = {
  mandatory: 0,
  strong: 1,
  requested: 2,
  ephemeral: 3,
}

const compareText = (left: string, right: string) => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

const candidateRank = (component: AdaptiveContextComponent.Component) => {
  if (component.key === "repo-map") return 0
  if (component.key === "local-tail") return 1
  if (component.key.startsWith("validation:") && component.kind === "tool-event") return 2
  return 0
}

const eventSequence = (component: AdaptiveContextComponent.Component) => {
  if (component.kind !== "tool-event" || !component.key.startsWith("event:")) return undefined
  const sequence = Number(component.key.slice("event:".length).split(":", 1)[0])
  return Number.isSafeInteger(sequence) ? sequence : undefined
}

const compareEvent = (left: AdaptiveContextComponent.Component, right: AdaptiveContextComponent.Component) => {
  const leftSequence = eventSequence(left)
  const rightSequence = eventSequence(right)
  if (leftSequence === undefined || rightSequence === undefined) return 0
  return leftSequence - rightSequence
}

const compareCandidate = (left: AdaptiveContextComponent.Component, right: AdaptiveContextComponent.Component) =>
  selectionRank[left.priority] - selectionRank[right.priority] ||
  candidateRank(left) - candidateRank(right) ||
  compareEvent(left, right) ||
  compareText(left.key, right.key)

const request = (
  input: Pick<PlanInput, "taskID" | "modelPolicy" | "roadmap">,
  system: readonly string[],
  messages: readonly AdaptiveStore.JsonValue[],
  tools: readonly AdaptiveStore.JsonValue[],
) =>
  AdaptiveContextRequest.prepare({
    taskID: input.taskID,
    modelPolicy: input.modelPolicy,
    roadmapRevision: input.roadmap.revision,
    system,
    messages,
    tools,
  })

export function plan(input: PlanInput): Plan {
  const source = validateSource(input)
  if (source) return source

  const normalizedMessages = canonicalArray(input.messages)
  if (!normalizedMessages.ok) return { _tag: "InvalidSource", reason: "messages must contain only canonical JSON" }
  const normalizedTools = canonicalArray(input.tools)
  if (!normalizedTools.ok) return { _tag: "InvalidSource", reason: "tools must contain only canonical JSON" }

  const detailByID = new Map(input.details.map((value) => [`${value.ref.key}@${value.ref.version}`, value]))
  const global = AdaptiveContextComponent.create([
    {
      key: "role-instructions",
      kind: "role-instructions",
      priority: "mandatory",
      sourceRevision: "adaptive-role:v1",
      text: input.roleInstructions,
      evictable: false,
    },
    {
      key: "requirement",
      kind: "requirement",
      priority: "mandatory",
      sourceRevision: `roadmap:${input.roadmap.revision}:requirement`,
      text: AdaptiveContextRender.requirement(input.roadmap.requirement),
      evictable: false,
    },
    {
      key: `roadmap:r${input.roadmap.revision}`,
      kind: "roadmap",
      priority: "mandatory",
      sourceRevision: `roadmap:${input.roadmap.revision}`,
      text: AdaptiveContextRender.roadmap(input.roadmap),
      evictable: false,
    },
  ])
  const inputBudget =
    input.modelPolicy.effectiveContextLimit - input.modelPolicy.outputReserve - input.modelPolicy.safetyReserve
  const globalTokens = request(
    input,
    global.map((component) => component.text),
    normalizedMessages.value,
    normalizedTools.value,
  )
  if (globalTokens.estimatedTokens > inputBudget) {
    return { _tag: "ContextBudgetUnsatisfiable", mandatoryTokens: globalTokens.estimatedTokens, inputBudget }
  }

  const nodeMandatoryInputs: AdaptiveContextComponent.Input[] = []
  if (input.coordinatorCycle) {
    nodeMandatoryInputs.push({
      key: "coordinator-cycle",
      kind: "coordinator-cycle",
      priority: "mandatory",
      sourceRevision: input.coordinatorCycle.sourceRevision,
      text: input.coordinatorCycle.text,
      evictable: false,
    })
  } else if (input.assignment) {
    nodeMandatoryInputs.push({
      key: `assignment:${input.assignment.id}`,
      kind: "assignment",
      priority: "mandatory",
      sourceRevision: `assignment:${input.assignment.id}`,
      text: AdaptiveContextRender.assignment(input.assignment),
      evictable: false,
    })
    for (const ref of input.assignment.detailRefs.filter((value) => value.kind === "contracts")) {
      const value = detailByID.get(`${ref.key}@${ref.version}`)!
      nodeMandatoryInputs.push({
        key: `detail:${ref.key}@${ref.version}`,
        kind: "contract",
        priority: "mandatory",
        sourceRevision: value.contentHash,
        text: AdaptiveContextRender.detail(value),
        evictable: false,
      })
    }
  }
  const nodeMandatory = AdaptiveContextComponent.create(nodeMandatoryInputs)
  const required = [...global, ...nodeMandatory]
  const mandatoryTokens = request(
    input,
    required.map((component) => component.text),
    normalizedMessages.value,
    normalizedTools.value,
  )
  if (mandatoryTokens.estimatedTokens > inputBudget) {
    if (input.assignment)
      return {
        _tag: "ContextSplitRequired",
        mandatoryTokens: mandatoryTokens.estimatedTokens,
        inputBudget,
        nodeID: input.assignment.nodeID,
        assignmentID: input.assignment.id,
      }
    return {
      _tag: "ContextBudgetUnsatisfiable",
      mandatoryTokens: mandatoryTokens.estimatedTokens,
      inputBudget,
    }
  }

  const candidateInputs: AdaptiveContextComponent.Input[] = []
  const selectedDetailIDs = new Set(nodeMandatoryInputs.map((component) => component.key))
  const node = input.assignment
    ? input.roadmap.nodes.find((value) => value.id === input.assignment?.nodeID)
    : undefined
  for (const ref of node?.details ?? []) {
    const key = `detail:${ref.key}@${ref.version}`
    if (selectedDetailIDs.has(key)) continue
    const value = detailByID.get(`${ref.key}@${ref.version}`)!
    selectedDetailIDs.add(key)
    candidateInputs.push({
      key,
      kind: "detail",
      priority: "strong",
      sourceRevision: value.contentHash,
      text: AdaptiveContextRender.detail(value),
      evictable: true,
    })
  }
  for (const ref of input.openedDetails ?? []) {
    const key = `detail:${ref.key}@${ref.version}`
    if (selectedDetailIDs.has(key)) continue
    const value = detailByID.get(`${ref.key}@${ref.version}`)!
    selectedDetailIDs.add(key)
    candidateInputs.push({
      key,
      kind: "detail",
      priority: "requested",
      sourceRevision: value.contentHash,
      text: AdaptiveContextRender.detail(value),
      evictable: true,
    })
  }
  if (input.checkpoint) {
    candidateInputs.push({
      key: `checkpoint:${input.checkpoint.sequence}`,
      kind: "checkpoint",
      priority: "strong",
      sourceRevision: `checkpoint:${input.checkpoint.sequence}:${input.checkpoint.diffHash}`,
      text: AdaptiveContextRender.checkpoint(input.checkpoint),
      evictable: true,
    })
  }
  if (input.workspace && input.agentRole !== "coordinator") {
    candidateInputs.push({
      key: "workspace",
      kind: "workspace",
      priority: "strong",
      sourceRevision: input.workspace.sourceRevision,
      text: input.workspace.text,
      evictable: true,
    })
  }
  for (const validation of input.validations ?? []) {
    candidateInputs.push({
      key: `validation:${validation.key}`,
      kind: validation.status === "failed" ? "failed-validation" : "tool-event",
      priority: validation.status === "failed" ? "strong" : "ephemeral",
      sourceRevision: validation.sourceRevision,
      text: validation.text,
      evictable: true,
    })
  }
  for (const [index, risk] of [...(node?.risks ?? []), ...input.roadmap.risks].entries()) {
    candidateInputs.push({
      key: `risk:${index}`,
      kind: "risk",
      priority: "strong",
      sourceRevision: `roadmap:${input.roadmap.revision}:risk:${index}`,
      text: risk,
      evictable: true,
    })
  }
  if (input.repoMap) {
    candidateInputs.push({
      key: "repo-map",
      kind: "repo-map",
      priority: "ephemeral",
      sourceRevision: input.repoMap.sourceRevision,
      text: input.repoMap.text,
      evictable: true,
    })
  }
  if (input.localTail) {
    candidateInputs.push({
      key: "local-tail",
      kind: "local-tail",
      priority: "ephemeral",
      sourceRevision: input.localTail.sourceRevision,
      text: input.localTail.text,
      evictable: true,
    })
  }

  const cursor = input.checkpoint?.eventCursor ?? -1
  const seenEvents = new Set<string>()
  const events = (input.events ?? [])
    .filter((event) => event.sequence > cursor)
    .slice()
    .sort((left, right) => left.sequence - right.sequence || compareText(left.id, right.id))
    .filter((event) => {
      if (seenEvents.has(event.id)) return false
      seenEvents.add(event.id)
      return true
    })
  for (const event of events.slice(0, 256)) {
    candidateInputs.push({
      key: `event:${event.sequence}:${event.id}`,
      kind: "tool-event",
      priority: "ephemeral",
      sourceRevision: `event:${event.sequence}`,
      text: event.text,
      evictable: true,
    })
  }

  const selected = [...required]
  const omissions: Omission[] = []
  for (const component of AdaptiveContextComponent.create(candidateInputs).slice().sort(compareCandidate)) {
    const next = [...selected, component]
    const estimated = request(
      input,
      next.map((value) => value.text),
      normalizedMessages.value,
      normalizedTools.value,
    )
    if (estimated.estimatedTokens <= inputBudget) selected.push(component)
    else omissions.push({ key: component.key, kind: component.kind, tokens: component.estimatedTokens, reason: "budget" })
  }

  const system = selected.map((component) => component.text)
  const prepared = request(input, system, normalizedMessages.value, normalizedTools.value)
  const estimatedTokens = prepared.estimatedTokens
  const restartReason =
    events.length > 256
      ? "event_tail_limit"
      : (input.localTail?.turns ?? 0) >= 24
        ? "local_tail_limit"
        : estimatedTokens > inputBudget * 0.8
          ? "context_80_percent"
          : undefined
  return {
    _tag: "Ready",
    inputBudget,
    components: selected,
    omissions,
    system,
    messages: normalizedMessages.value,
    tools: normalizedTools.value,
    estimatedTokens,
    requestHash: prepared.requestHash,
    promptCacheKey: prepared.promptCacheKey,
    restartRequired: restartReason !== undefined,
    ...(restartReason ? { restartReason } : {}),
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* AdaptiveStore.Service
    const roadmaps = yield* AdaptiveRoadmapStore.Service
    const recovery = yield* AdaptiveRecoveryStore.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    const assembleOnce = Effect.fn("AdaptiveContextAssembler.assembleOnce")(function* (input: Input) {
      const taskEventSequence = yield* EventV2.latestSequence(db, input.taskID)
      const task = yield* store.getTask(input.taskID)
      const agent = yield* store.getAgent(input.agentID)
      const now = yield* Clock.currentTimeMillis
      if (
        agent.taskID !== input.taskID ||
        agent.generation !== input.generation ||
        agent.owner !== input.owner ||
        agent.leaseExpiresAt === undefined ||
        agent.leaseExpiresAt <= now ||
        !["starting", "running"].includes(agent.state)
      )
        return yield* new InvalidSourceError({
          taskID: input.taskID,
          reason: "Agent identity does not match the active Manifest invocation",
        })
      const roadmap = (yield* roadmaps.getCurrent(input.taskID)).roadmap
      const assignment = input.assignmentID
        ? Option.some((yield* recovery.getAssignment(input.assignmentID)).assignment)
        : Option.none<AdaptiveOperation.Assignment>()
      if (agent.assignmentID !== input.assignmentID)
        return yield* new InvalidSourceError({
          taskID: input.taskID,
          reason: "Agent Assignment does not match the Manifest invocation",
        })
      const node = Option.isSome(assignment)
        ? roadmap.nodes.find((value) => value.id === assignment.value.nodeID)
        : undefined
      const refs = new Map<string, AdaptiveRoadmap.DetailRef>()
      for (const ref of [
        ...(Option.isSome(assignment) ? assignment.value.detailRefs : []),
        ...(node?.details ?? []),
        ...(input.openedDetails ?? []),
      ]) {
        refs.set(`${ref.key}@${ref.version}`, ref)
      }
      const details = yield* Effect.forEach(refs.values(), (ref) =>
        roadmaps.getDetail(input.taskID, ref.key, ref.version),
      )
      const checkpoint = Option.isSome(assignment)
        ? yield* recovery.getLatestCheckpoint(input.agentID).pipe(
            Effect.map((record) => Option.some(record.checkpoint)),
            Effect.catchTag("AdaptiveRecoveryStore.CheckpointNotFound", () => Effect.succeed(Option.none())),
          )
        : Option.none<AdaptiveOperation.Checkpoint>()
      const eventPage = yield* EventV2.readAggregate(db, {
        aggregateID: input.taskID,
        after: Option.getOrUndefined(checkpoint)?.eventCursor ?? agent.eventCursor,
        limit: 257,
        manifest: AdaptiveDurable,
      })
      const expectedSource: AdaptiveStore.ManifestSource = {
        roadmapRevision: roadmap.revision,
        assignmentID: agent.assignmentID ?? null,
        checkpointSequence: agent.checkpointSequence ?? null,
        eventCursor: agent.eventCursor,
        taskEventSequence,
      }
      const planned = plan({
        ...invocationSource(input),
        agentRole: agent.role,
        roadmap,
        assignment: Option.getOrUndefined(assignment),
        ...(agent.role === "coordinator"
          ? { coordinatorCycle: cycle(roadmap, agent.eventCursor, eventPage.events) }
          : {}),
        details,
        checkpoint: Option.getOrUndefined(checkpoint),
        events: eventPage.events.map((event) => ({
          id: event.id,
          sequence: event.durable!.seq,
          text: JSON.stringify({ type: event.type, data: event.data }),
        })),
        modelPolicy: task.modelPolicy,
      })
      if (planned._tag === "InvalidSource") {
        return yield* new InvalidSourceError({ taskID: input.taskID, reason: planned.reason })
      }
      if (planned._tag === "ContextBudgetUnsatisfiable") {
        return yield* new ContextBudgetUnsatisfiableError({
          taskID: input.taskID,
          mandatoryTokens: planned.mandatoryTokens,
          inputBudget: planned.inputBudget,
        })
      }
      if (planned._tag === "ContextSplitRequired") {
        const timeCreated = yield* Clock.currentTimeMillis
        const sourceChanged = new AdaptiveStore.ManifestSourceChangedError({
          manifestID: input.id,
          taskID: input.taskID,
          agentID: input.agentID,
        })
        yield* events
          .publish(
            AdaptiveEvent.ContextSplitRequired,
            {
              taskID: input.taskID,
              timeCreated,
              agentID: input.agentID,
              generation: input.generation,
              nodeID: planned.nodeID,
              assignmentID: planned.assignmentID,
              reasonCode: "CONTEXT_SPLIT_REQUIRED",
              reason: "Current-node mandatory context exceeds the available input budget",
              mandatoryTokens: planned.mandatoryTokens,
              inputBudget: planned.inputBudget,
            },
            {
              commit: () =>
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis
                  const [matches, owns] = yield* Effect.all([
                    AdaptiveStore.sourceMatches(db, {
                      taskID: input.taskID,
                      agentID: input.agentID,
                      expected: expectedSource,
                    }),
                    AdaptiveStore.ownsActiveAgent(db, {
                      taskID: input.taskID,
                      agentID: input.agentID,
                      generation: input.generation,
                      owner: input.owner,
                      now,
                    }),
                    ])
                    if (!matches || !owns) return yield* Effect.die(sourceChanged)
                    return undefined
                  }),
            },
          )
          .pipe(
            Effect.catchDefect((defect) =>
              defect instanceof AdaptiveStore.ManifestSourceChangedError ? Effect.fail(defect) : Effect.die(defect),
            ),
          )
        return yield* new ContextSplitRequiredError({
          taskID: input.taskID,
          agentID: input.agentID,
          generation: input.generation,
          nodeID: planned.nodeID,
          mandatoryTokens: planned.mandatoryTokens,
          inputBudget: planned.inputBudget,
        })
      }
      const manifest = yield* store.putManifest({
        id: input.id,
        taskID: input.taskID,
        agentID: input.agentID,
        generation: input.generation,
        owner: input.owner,
        purpose: input.purpose,
        system: planned.system,
        messages: planned.messages,
        tools: planned.tools,
        components: planned.components,
        omissions: planned.omissions,
        roadmapRevision: roadmap.revision,
        turn: input.turn,
        restartReason: planned.restartReason,
        estimatedTokens: planned.estimatedTokens,
        requestHash: planned.requestHash,
        expectedSource,
      })
      return { ...planned, manifest }
    })

    const assemble: Interface["assemble"] = (input) =>
      assembleOnce(input).pipe(
        Effect.catchTag("AdaptiveStore.ManifestSourceChanged", () => assembleOnce(input)),
      )

    return Service.of({ assemble })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [AdaptiveStore.node, AdaptiveRoadmapStore.node, AdaptiveRecoveryStore.node, EventV2.node, Database.node],
})

function invocationSource(input: Input): Omit<SourceInput, "roadmap" | "assignment" | "details" | "checkpoint"> {
  return {
    id: input.id,
    taskID: input.taskID,
    agentID: input.agentID,
    generation: input.generation,
    owner: input.owner,
    purpose: input.purpose,
    turn: input.turn,
    roleInstructions: input.roleInstructions,
    workspace: input.workspace,
    validations: input.validations,
    openedDetails: input.openedDetails,
    repoMap: input.repoMap,
    localTail: input.localTail,
    messages: input.messages,
    tools: input.tools,
  }
}

function validateSource(input: PlanInput): InvalidSourcePlan | undefined {
  if (input.roadmap.taskID !== input.taskID) return { _tag: "InvalidSource", reason: "Roadmap belongs to another Task" }
  if (!Number.isSafeInteger(input.generation) || input.generation <= 0)
    return { _tag: "InvalidSource", reason: "Agent generation must be a positive integer" }
  if (!Number.isSafeInteger(input.turn) || input.turn < 0)
    return { _tag: "InvalidSource", reason: "Manifest turn must be a nonnegative integer" }
  if (input.owner.length === 0 || input.purpose.length === 0 || input.roleInstructions.length === 0)
    return { _tag: "InvalidSource", reason: "Owner, purpose, and role instructions must be non-empty" }
  if (input.agentRole === "implementation" && !input.assignment)
    return { _tag: "InvalidSource", reason: "Implementation Worker requires an Assignment" }
  if (input.agentRole === "coordinator" && (input.assignment || !input.coordinatorCycle))
    return { _tag: "InvalidSource", reason: "Coordinator requires a cycle input instead of an Assignment" }
  if (input.assignment) {
    if (
      input.assignment.taskID !== input.taskID ||
      input.assignment.workerID !== input.agentID ||
      input.assignment.generation > input.generation ||
      input.assignment.roadmapRevision !== input.roadmap.revision
    )
      return { _tag: "InvalidSource", reason: "Assignment identity does not match the Manifest invocation" }
    if (!input.roadmap.nodes.some((node) => node.id === input.assignment?.nodeID))
      return { _tag: "InvalidSource", reason: "Assignment node is absent from the Roadmap" }
  }
  if (
    input.checkpoint &&
    (!input.assignment ||
      input.checkpoint.assignmentID !== input.assignment.id ||
      input.checkpoint.workerID !== input.agentID ||
      input.checkpoint.generation > input.generation ||
      input.checkpoint.generation < input.assignment.generation ||
      input.checkpoint.roadmapRevision !== input.roadmap.revision ||
      input.checkpoint.nodeID !== input.assignment.nodeID)
  )
    return { _tag: "InvalidSource", reason: "Checkpoint identity does not match the current Assignment" }

  const currentNode = input.assignment
    ? input.roadmap.nodes.find((node) => node.id === input.assignment?.nodeID)
    : undefined
  for (const ref of input.assignment?.detailRefs ?? []) {
    const value = input.details.find((detail) => detail.ref.key === ref.key && detail.ref.version === ref.version)
    if (!value || value.ref.kind !== ref.kind || value.ref.status !== ref.status)
      return { _tag: "InvalidSource", reason: `Detail ${ref.key}@${ref.version} does not resolve exactly` }
    if (value.nodeID === input.assignment?.nodeID) continue
    const owner = input.roadmap.nodes.find((node) => node.id === value.nodeID)
    const indexed = owner?.details.some(
      (candidate) =>
        candidate.key === ref.key &&
        candidate.version === ref.version &&
        candidate.kind === ref.kind &&
        candidate.status === ref.status,
    )
    const dependency = currentNode?.dependencies.some(
      (candidate) => candidate.nodeID === value.nodeID && candidate.contractKey === ref.key,
    )
    if (ref.kind !== "contracts" || !indexed || !dependency)
      return { _tag: "InvalidSource", reason: `Detail ${ref.key}@${ref.version} is not a direct dependency contract` }
  }
  for (const ref of currentNode?.details ?? []) {
    const value = input.details.find((detail) => detail.ref.key === ref.key && detail.ref.version === ref.version)
    if (!value || value.ref.kind !== ref.kind || value.ref.status !== ref.status)
      return { _tag: "InvalidSource", reason: `Detail ${ref.key}@${ref.version} does not resolve exactly` }
    if (value.nodeID !== currentNode?.id)
      return { _tag: "InvalidSource", reason: `Detail ${ref.key}@${ref.version} belongs to another node` }
  }
  for (const ref of input.openedDetails ?? []) {
    const value = input.details.find((detail) => detail.ref.key === ref.key && detail.ref.version === ref.version)
    if (!value || value.ref.kind !== ref.kind || value.ref.status !== ref.status)
      return { _tag: "InvalidSource", reason: `Detail ${ref.key}@${ref.version} does not resolve exactly` }
    const indexed = input.roadmap.nodes.find((node) =>
      node.details.some(
        (candidate) =>
          candidate.key === ref.key &&
          candidate.version === ref.version &&
          candidate.kind === ref.kind &&
          candidate.status === ref.status,
      ),
    )
    if (!indexed || indexed.id !== value.nodeID)
      return { _tag: "InvalidSource", reason: `Detail ${ref.key}@${ref.version} is not indexed by its Roadmap node` }
  }
  return undefined
}

function cycle(
  roadmap: AdaptiveRoadmap.Info,
  cursor: number,
  events: readonly { readonly durable?: { readonly seq: number } }[],
): TextSource {
  const through = events.at(-1)?.durable?.seq ?? cursor
  return {
    sourceRevision: `coordinator:r${roadmap.revision}:${cursor}:${through}`,
    text: [
      "# Coordinator Cycle",
      `Roadmap Revision: r${roadmap.revision}`,
      `Event Cursor: ${cursor}`,
      `Pending Event Range: ${cursor + 1}..${through}`,
    ].join("\n"),
  }
}

type JsonResult =
  | { readonly ok: true; readonly value: AdaptiveStore.JsonValue }
  | { readonly ok: false }

function canonicalArray(input: readonly unknown[]) {
  const result = canonical(input, new Set())
  if (!result.ok || !Array.isArray(result.value)) return { ok: false } as const
  return { ok: true, value: result.value } as const
}

function canonical(input: unknown, ancestors: Set<object>): JsonResult {
  if (input === null || typeof input === "string" || typeof input === "boolean") return { ok: true, value: input }
  if (typeof input === "number") return Number.isFinite(input) ? { ok: true, value: input } : { ok: false }
  if (typeof input !== "object") return { ok: false }
  if (ancestors.has(input)) return { ok: false }
  ancestors.add(input)

  if (Array.isArray(input)) {
    const values: AdaptiveStore.JsonValue[] = []
    for (const item of input) {
      const result = canonical(item, ancestors)
      if (!result.ok) return { ok: false }
      values.push(result.value)
    }
    ancestors.delete(input)
    return { ok: true, value: values }
  }

  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
    return { ok: false }
  if (Object.getOwnPropertySymbols(input).length > 0) return { ok: false }
  const descriptors = Object.getOwnPropertyDescriptors(input)
  const output: Record<string, AdaptiveStore.JsonValue> = Object.create(null)
  for (const key of Object.keys(descriptors).sort(compareText)) {
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !("value" in descriptor)) return { ok: false }
    const result = canonical(descriptor.value, ancestors)
    if (!result.ok) return { ok: false }
    output[key] = result.value
  }
  ancestors.delete(input)
  return { ok: true, value: output }
}
