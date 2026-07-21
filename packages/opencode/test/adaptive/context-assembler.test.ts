import { describe, expect } from "bun:test"
import { AdaptiveModelPolicy } from "@opencode-ai/core/adaptive/model-policy"
import { AdaptiveRecoveryStore } from "@opencode-ai/core/adaptive/recovery-store"
import { AdaptiveRoadmapStore } from "@opencode-ai/core/adaptive/roadmap-store"
import { AdaptiveAgentProcessTable } from "@opencode-ai/core/adaptive/sql"
import { AdaptiveStore } from "@opencode-ai/core/adaptive/store"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Hash } from "@opencode-ai/core/util/hash"
import { AdaptiveEvent } from "@opencode-ai/schema/adaptive-event"
import { AdaptiveOperation } from "@opencode-ai/schema/adaptive-operation"
import { AdaptiveRoadmap } from "@opencode-ai/schema/adaptive-roadmap"
import { AdaptiveTask } from "@opencode-ai/schema/adaptive-task"
import { Message, ToolDefinition } from "@opencode-ai/llm"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { count, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AdaptiveContextAssembler } from "@/adaptive/context/assembler"
import { AdaptiveContextRequest } from "@/adaptive/context/request"
import { AdaptiveContextRender } from "@/adaptive/context/render"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      AdaptiveContextAssembler.node,
      AdaptiveRecoveryStore.node,
      AdaptiveRoadmapStore.node,
      AdaptiveStore.node,
      EventV2.node,
      Database.node,
    ]),
    [[Database.node, Database.layerFromPath(":memory:")]],
  ),
)

const digest = (value: string) => AdaptiveOperation.Hash.make(`sha256:${Hash.sha256(value)}`)

const policy = (inputBudget = 12_000) =>
  AdaptiveModelPolicy.create({
    providerID: Provider.ID.make("test-provider"),
    modelID: Model.ID.make("test-model"),
    effectiveContextLimit: inputBudget + 1_500,
    outputReserve: 1_000,
    safetyReserve: 500,
  })

const detail = (key: string, kind: AdaptiveRoadmap.DetailKind, version: number, body: string, nodeID = "retry-core") =>
  new AdaptiveEvent.DetailRecord({
    nodeID,
    ref: new AdaptiveRoadmap.DetailRef({ key, kind, version, status: "ready" }),
    body,
    contentHash: digest(body),
  })

function source(
  taskID: AdaptiveTask.ID,
  agentID: AdaptiveTask.AgentID,
  generation: number,
  input: {
    readonly manifestID?: AdaptiveTask.ContextManifestID
    readonly contractVersion?: number
    readonly contractBody?: string
    readonly extras?: Partial<AdaptiveContextAssembler.SourceInput>
  } = {},
): AdaptiveContextAssembler.SourceInput {
  const contract = detail(
    "contract:retry-api",
    "contracts",
    input.contractVersion ?? 2,
    input.contractBody ?? "retry<T>(operation, options): Promise<T>",
  )
  const optional = detail("retry-notes", "decisions", 1, "Prefer bounded exponential backoff.", "retry-notes")
  const roadmap = new AdaptiveRoadmap.Info({
    taskID,
    revision: 1,
    requirement: new AdaptiveRoadmap.RequirementBaseline({
      objective: "Implement bounded retry.",
      scope: ["src/retry.ts"],
      constraints: ["Keep the pinned model"],
      acceptance: ["bun test test/retry.test.ts"],
    }),
    nodes: [
      new AdaptiveRoadmap.Node({
        id: "retry-core",
        title: "Retry core",
        goal: "Implement bounded retry behavior.",
        status: "running",
        owner: agentID,
        interfaces: [
          new AdaptiveRoadmap.InterfaceRef({
            key: contract.ref.key,
            name: "retry",
            kind: "function",
            signature: "retry<T>(operation, options): Promise<T>",
            version: contract.ref.version,
            state: "ready",
          }),
        ],
        dependencies: [],
        details: [contract.ref],
        acceptance: ["bun test test/retry.test.ts"],
        risks: ["provider timeout"],
        unresolved: [],
      }),
      new AdaptiveRoadmap.Node({
        id: "retry-notes",
        title: "Retry notes",
        goal: "Preserve optional design context.",
        status: "ready",
        interfaces: [],
        dependencies: [],
        details: [optional.ref],
        acceptance: [],
        risks: [],
        unresolved: [],
      }),
    ],
    risks: [],
    unresolved: [],
  })
  const assignment = new AdaptiveOperation.Assignment({
    id: AdaptiveOperation.AssignmentID.create(),
    taskID,
    workerID: agentID,
    nodeID: "retry-core",
    roadmapRevision: 1,
    detailRefs: [contract.ref],
    permittedPaths: [AdaptiveOperation.RepositoryGlob.make("src/**")],
    baseCommit: "abc123",
    acceptanceCommands: ["bun test test/retry.test.ts"],
    generation,
    timeCreated: 1,
  })
  return {
    id: input.manifestID ?? AdaptiveTask.ContextManifestID.create(),
    taskID,
    agentID,
    generation,
    owner: "controller-a",
    purpose: "Implementation Worker turn",
    turn: 4,
    roleInstructions: "Implement only the current Assignment and report verifiable evidence.",
    roadmap,
    assignment,
    details: [contract, optional],
    messages: [],
    tools: [],
    ...input.extras,
  }
}

const invocation = (
  value: AdaptiveContextAssembler.SourceInput,
  overrides: Partial<AdaptiveContextAssembler.Input> = {},
): AdaptiveContextAssembler.Input => ({
  id: value.id,
  taskID: value.taskID,
  agentID: value.agentID,
  generation: value.generation,
  owner: value.owner,
  purpose: value.purpose,
  turn: value.turn,
  roleInstructions: value.roleInstructions,
  assignmentID: value.assignment?.id,
  workspace: value.workspace,
  validations: value.validations,
  openedDetails: value.openedDetails,
  repoMap: value.repoMap,
  localTail: value.localTail,
  messages: value.messages,
  tools: value.tools,
  ...overrides,
})

const setup = (
  inputBudget = 12_000,
  sourceInput: { readonly contractBody?: string; readonly contractVersion?: number } = {},
) =>
  Effect.gen(function* () {
    const store = yield* AdaptiveStore.Service
    const task = yield* store.createTask({
      id: AdaptiveTask.ID.create(),
      directory: "/workspace/project",
      mode: "normal",
      status: "running",
      requirement: "Implement bounded retry.",
      modelPolicy: policy(inputBudget),
      roadmapRevision: 0,
      baseSnapshotHash: "git:abc123",
    })
    const agent = yield* store.createAgent({
      id: AdaptiveTask.AgentID.create(),
      taskID: task.id,
      role: "implementation",
    })
    const claimed = yield* store.claimAgent({
      agentID: agent.id,
      expectedGeneration: 0,
      owner: "controller-a",
      pid: 101,
      leaseDurationMs: 60_000,
    })
    const snapshot = source(task.id, claimed.id, claimed.generation, sourceInput)
    yield* (yield* AdaptiveRoadmapStore.Service).commit({
      expectedRevision: 0,
      roadmap: snapshot.roadmap,
      details: snapshot.details,
      sourceAgentID: claimed.id,
      sourceGeneration: claimed.generation,
    })
    yield* (yield* AdaptiveRecoveryStore.Service).createAssignment(snapshot.assignment!)
    return { store, task, agent: claimed, snapshot }
  })

describe("AdaptiveContextAssembler", () => {
  it.effect("persists one exact Manifest with the global graph and direct contract", () =>
    Effect.gen(function* () {
      const state = yield* setup()
      const assembler = yield* AdaptiveContextAssembler.Service
      const input = invocation(state.snapshot)
      const result = yield* assembler.assemble(input)
      const stored = yield* state.store.getManifest(input.id)
      const keys = result.components.map((component) => component.key)

      expect(result.manifest).toEqual(stored)
      expect(stored.system.slice(0, 3)).toEqual([
        input.roleInstructions,
        AdaptiveContextRender.requirement(state.snapshot.roadmap.requirement),
        AdaptiveContextRender.roadmap(state.snapshot.roadmap),
      ])
      expect(keys).toContain("requirement")
      expect(keys).toContain("roadmap:r1")
      expect(keys).toContain(`assignment:${state.snapshot.assignment!.id}`)
      expect(keys).toContain("detail:contract:retry-api@2")
      expect(stored.roadmapRevision).toBe(1)
      expect(stored.turn).toBe(4)
      expect(stored.requestHash).toMatch(/^sha256:[0-9a-f]{64}$/)

      const retry = invocation(state.snapshot, { id: AdaptiveTask.ContextManifestID.create() })
      const repeated = yield* assembler.assemble(retry)
      expect(repeated.manifest.system).toEqual(stored.system)
      expect(repeated.manifest.messages).toEqual(stored.messages)
      expect(repeated.manifest.tools).toEqual(stored.tools)
      expect(repeated.manifest.components).toEqual(stored.components)
      expect(repeated.manifest.requestHash).toBe(stored.requestHash)
    }),
  )

  it.effect("rebuilds a replacement generation from its immutable Assignment and prior Checkpoint", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0)
      const state = yield* setup()
      const checkpoint = new AdaptiveOperation.Checkpoint({
        assignmentID: state.snapshot.assignment!.id,
        workerID: state.agent.id,
        generation: state.agent.generation,
        sequence: 1,
        eventCursor: 1,
        roadmapRevision: state.snapshot.assignment!.roadmapRevision,
        nodeID: state.snapshot.assignment!.nodeID,
        completed: ["Retry core inspected."],
        decisions: [],
        modifiedPaths: [],
        evidence: [],
        remaining: ["Implement bounded retry."],
        nextAction: "Write the retry loop.",
        worktreeHead: "abc123",
        diffHash: digest("checkpoint-diff"),
        timeCreated: 1,
      })
      yield* (yield* AdaptiveRecoveryStore.Service).saveCheckpoint({
        checkpoint,
        observedHead: checkpoint.worktreeHead,
        observedDiffHash: checkpoint.diffHash,
      })
      yield* TestClock.setTime(60_000)
      const replacement = yield* state.store.claimAgent({
        agentID: state.agent.id,
        expectedGeneration: state.agent.generation,
        owner: "replacement-controller",
        pid: 202,
        leaseDurationMs: 60_000,
      })
      const result = yield* (yield* AdaptiveContextAssembler.Service).assemble(
        invocation(state.snapshot, {
          id: AdaptiveTask.ContextManifestID.create(),
          generation: replacement.generation,
          owner: "replacement-controller",
        }),
      )

      expect(result.manifest.generation).toBe(replacement.generation)
      expect(result.components.map((component) => component.key)).toContain("checkpoint:1")
    }),
  )

  it.effect("reads only durable events after the Agent cursor before its first Checkpoint", () =>
    Effect.gen(function* () {
      const state = yield* setup(100_000)
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const payload = (index: number) => ({
        taskID: state.task.id,
        timeCreated: index,
        agentID: state.agent.id,
        generation: state.agent.generation,
        nodeID: state.snapshot.assignment!.nodeID,
        assignmentID: state.snapshot.assignment!.id,
        reasonCode: "CONTEXT_SPLIT_REQUIRED" as const,
        reason: `historical event ${index}`,
        mandatoryTokens: 1,
        inputBudget: 2,
      })
      const historical = yield* Effect.forEach(Array.from({ length: 260 }, (_, index) => index), (index) =>
        events.publish(AdaptiveEvent.ContextSplitRequired, payload(index)),
      )
      const cursor = historical.at(-1)?.durable?.seq
      if (cursor === undefined) throw new Error("Expected durable historical event")
      yield* db
        .update(AdaptiveAgentProcessTable)
        .set({ event_cursor: cursor })
        .where(eq(AdaptiveAgentProcessTable.id, state.agent.id))
        .run()
      const current = yield* Effect.forEach(Array.from({ length: 3 }, (_, index) => index + 260), (index) =>
        events.publish(AdaptiveEvent.ContextSplitRequired, payload(index)),
      )
      const result = yield* (yield* AdaptiveContextAssembler.Service).assemble(invocation(state.snapshot))

      expect(result.components.filter((component) => component.kind === "tool-event").map((component) => component.key)).toEqual(
        current.map((event) => `event:${event.durable!.seq}:${event.id}`),
      )
      expect(result.restartReason).toBeUndefined()
    }),
  )

  it.effect("evicts successful output, old tail, RepoMap, requested Detail, then strong context", () =>
    Effect.gen(function* () {
      const taskID = AdaptiveTask.ID.create()
      const agentID = AdaptiveTask.AgentID.create()
      const base = source(taskID, agentID, 1, {
        extras: {
          workspace: { sourceRevision: "workspace:a", text: `# Workspace\n${"strong ".repeat(80)}` },
          validations: [
            {
              key: "failed",
              status: "failed",
              sourceRevision: "validation:2",
              text: `# Failed validation\n${"failure ".repeat(80)}`,
            },
            {
              key: "success",
              status: "succeeded",
              sourceRevision: "validation:1",
              text: `# Successful output\n${"success ".repeat(80)}`,
            },
          ],
          openedDetails: [
            new AdaptiveRoadmap.DetailRef({ key: "retry-notes", kind: "decisions", version: 1, status: "ready" }),
          ],
          repoMap: { sourceRevision: "repo-map:a", text: `# RepoMap\n${"repo ".repeat(80)}` },
          localTail: { turns: 3, sourceRevision: "tail:a", text: `# Local tail\n${"tail ".repeat(80)}` },
        },
      })
      const full = AdaptiveContextAssembler.plan({ ...base, modelPolicy: policy(30_000) })
      if (full._tag !== "Ready") throw new Error(`Expected Ready, got ${full._tag}`)
      const order: string[] = []
      const seen = new Set<string>()

      for (let budget = full.estimatedTokens - 1; budget > 1; budget--) {
        const planned = AdaptiveContextAssembler.plan({ ...base, modelPolicy: policy(budget) })
        if (planned._tag !== "Ready") continue
        for (const omission of planned.omissions) {
          if (seen.has(omission.key)) continue
          seen.add(omission.key)
          order.push(omission.key)
        }
        if (order.length >= 5) break
      }

      expect(order.slice(0, 5)).toEqual([
        "validation:success",
        "local-tail",
        "repo-map",
        "detail:retry-notes@1",
        "workspace",
      ])
      const tight = AdaptiveContextAssembler.plan({ ...base, modelPolicy: policy(full.estimatedTokens - 1) })
      expect(tight._tag).toBe("Ready")
      if (tight._tag !== "Ready") return
      expect(tight.components.map((component) => component.key)).toContain("validation:failed")
      expect(tight.omissions.map((omission) => omission.key)).toContain("validation:success")
    }),
  )

  it.effect("rejects a global overflow and emits ContextSplitRequired for current-node overflow", () =>
    Effect.gen(function* () {
      const assembler = yield* AdaptiveContextAssembler.Service
      const global = yield* setup(40)
      const globalInput = invocation(global.snapshot)
      const globalFailure = yield* assembler.assemble(globalInput).pipe(Effect.flip)

      expect(globalFailure._tag).toBe("AdaptiveContextAssembler.ContextBudgetUnsatisfiable")
      expect((yield* global.store.getManifest(globalInput.id).pipe(Effect.flip))._tag).toBe(
        "AdaptiveStore.ManifestNotFound",
      )

      const split = yield* setup(1_000, {
        contractBody: "contract ".repeat(3_000),
      })
      const splitInput = invocation(split.snapshot)
      const { db } = yield* Database.Service
      const before = yield* db
        .select({ count: count() })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, split.task.id))
        .get()
      const splitFailure = yield* assembler.assemble(splitInput).pipe(Effect.flip)

      expect(splitFailure._tag).toBe("AdaptiveContextAssembler.ContextSplitRequired")
      expect((yield* split.store.getManifest(splitInput.id).pipe(Effect.flip))._tag).toBe(
        "AdaptiveStore.ManifestNotFound",
      )
      expect(
        yield* db
          .select({ count: count() })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, split.task.id))
          .get(),
      ).toEqual({ count: (before?.count ?? 0) + 1 })
    }),
  )

  it.effect("rolls back ContextSplitRequired when its durable source changes during publish", () =>
    Effect.gen(function* () {
      const state = yield* setup(1_000, { contractBody: "contract ".repeat(3_000) })
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const beforeEvents = yield* db
        .select({ count: count() })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, state.task.id))
        .get()
      const beforeAgent = yield* db
        .select({ eventCursor: AdaptiveAgentProcessTable.event_cursor })
        .from(AdaptiveAgentProcessTable)
        .where(eq(AdaptiveAgentProcessTable.id, state.agent.id))
        .get()
      if (!beforeAgent) throw new Error("Expected Agent row")
      yield* events.project(AdaptiveEvent.ContextSplitRequired, () =>
        db
          .update(AdaptiveAgentProcessTable)
          .set({ event_cursor: beforeAgent.eventCursor + 1 })
          .where(eq(AdaptiveAgentProcessTable.id, state.agent.id))
          .run()
          .pipe(Effect.orDie, Effect.asVoid),
      )

      const failure = yield* (yield* AdaptiveContextAssembler.Service)
        .assemble(invocation(state.snapshot))
        .pipe(Effect.flip)

      expect(failure._tag).toBe("AdaptiveStore.ManifestSourceChanged")
      expect(
        yield* db
          .select({ count: count() })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, state.task.id))
          .get(),
      ).toEqual(beforeEvents)
      expect(
        yield* db
          .select({ eventCursor: AdaptiveAgentProcessTable.event_cursor })
          .from(AdaptiveAgentProcessTable)
          .where(eq(AdaptiveAgentProcessTable.id, state.agent.id))
          .get(),
      ).toEqual(beforeAgent)
    }),
  )

  it.effect("does not publish ContextSplitRequired after the Agent lease expires", () =>
    Effect.gen(function* () {
      const state = yield* setup(1_000, { contractBody: "contract ".repeat(3_000) })
      const { db } = yield* Database.Service
      const before = yield* db
        .select({ count: count() })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, state.task.id))
        .get()
      yield* db
        .update(AdaptiveAgentProcessTable)
        .set({ lease_expires_at: 1 })
        .where(eq(AdaptiveAgentProcessTable.id, state.agent.id))
        .run()
      yield* TestClock.setTime(2)
      const failure = yield* (yield* AdaptiveContextAssembler.Service)
        .assemble(invocation(state.snapshot))
        .pipe(Effect.flip)

      expect(failure._tag).toBe("AdaptiveContextAssembler.InvalidSource")
      expect(
        yield* db
          .select({ count: count() })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, state.task.id))
          .get(),
      ).toEqual(before)
    }),
  )

  it.effect("changes the request hash when workspace or exact Detail version changes", () =>
    Effect.gen(function* () {
      const taskID = AdaptiveTask.ID.create()
      const agentID = AdaptiveTask.AgentID.create()
      const first = source(taskID, agentID, 1, {
        extras: { workspace: { sourceRevision: "workspace:a", text: "diff:a" } },
      })
      const changedWorkspace = source(taskID, agentID, 1, {
        extras: { workspace: { sourceRevision: "workspace:b", text: "diff:b" } },
      })
      const changedDetail = source(taskID, agentID, 1, {
        contractVersion: 3,
        contractBody: "retry<T>(operation, revisedOptions): Promise<T>",
        extras: { workspace: { sourceRevision: "workspace:a", text: "diff:a" } },
      })
      const plans = [first, changedWorkspace, changedDetail].map((input) =>
        AdaptiveContextAssembler.plan({ ...input, modelPolicy: policy() }),
      )

      expect(plans.every((plan) => plan._tag === "Ready")).toBe(true)
      if (!plans.every((plan) => plan._tag === "Ready")) return
      expect(plans[1].requestHash).not.toBe(plans[0].requestHash)
      expect(plans[2].requestHash).not.toBe(plans[0].requestHash)
      expect(plans[1].components.find((component) => component.key === "workspace")?.sourceRevision).toBe(
        "workspace:b",
      )
      expect(plans[2].components.map((component) => component.key)).toContain("detail:contract:retry-api@3")
    }),
  )

  it.effect("keeps request evidence stable after Gateway decodes canonical messages and tools", () =>
    Effect.gen(function* () {
      const taskID = AdaptiveTask.ID.create()
      const agentID = AdaptiveTask.AgentID.create()
      const planned = AdaptiveContextAssembler.plan({
        ...source(taskID, agentID, 1),
        messages: [{ role: "user", content: [{ type: "text", text: "Use the durable retry contract." }] }],
        tools: [
          {
            name: "detail.open",
            description: "Open one exact Detail version.",
            inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
          },
        ],
        modelPolicy: policy(),
      })

      expect(planned._tag).toBe("Ready")
      if (planned._tag !== "Ready") return
      const decoded = AdaptiveContextRequest.prepare({
        taskID,
        modelPolicy: policy(),
        roadmapRevision: 1,
        system: planned.system,
        messages: Schema.decodeUnknownSync(Schema.Array(Message))(planned.messages),
        tools: Schema.decodeUnknownSync(Schema.Array(ToolDefinition))(planned.tools),
      })
      expect(decoded.estimatedTokens).toBe(planned.estimatedTokens)
      expect(decoded.requestHash).toBe(planned.requestHash)
    }),
  )

  it.effect("allows an exact requested Detail indexed by another Roadmap node", () =>
    Effect.gen(function* () {
      const taskID = AdaptiveTask.ID.create()
      const agentID = AdaptiveTask.AgentID.create()
      const base = source(taskID, agentID, 1)
      const external = detail("contract:timer-api", "contracts", 4, "sleep(ms): Promise<void>", "timer-core")
      const roadmap = new AdaptiveRoadmap.Info({
        taskID: base.roadmap.taskID,
        revision: base.roadmap.revision,
        requirement: base.roadmap.requirement,
        nodes: [
          ...base.roadmap.nodes,
          new AdaptiveRoadmap.Node({
            id: "timer-core",
            title: "Timer core",
            goal: "Expose timer behavior.",
            status: "ready",
            interfaces: [],
            dependencies: [],
            details: [external.ref],
            acceptance: ["bun test test/timer.test.ts"],
            risks: [],
            unresolved: [],
          }),
        ],
        risks: base.roadmap.risks,
        unresolved: base.roadmap.unresolved,
      })
      const planned = AdaptiveContextAssembler.plan({
        ...base,
        roadmap,
        details: [...base.details, external],
        openedDetails: [external.ref],
        modelPolicy: policy(),
      })

      expect(planned._tag).toBe("Ready")
      if (planned._tag !== "Ready") return
      expect(planned.components.map((component) => component.key)).toContain("detail:contract:timer-api@4")
    }),
  )

  it.effect("keeps an Assignment dependency contract from its owning Roadmap node", () =>
    Effect.gen(function* () {
      const taskID = AdaptiveTask.ID.create()
      const agentID = AdaptiveTask.AgentID.create()
      const base = source(taskID, agentID, 1)
      const dependencyContract = detail(
        "contract:timer-api",
        "contracts",
        4,
        "sleep(ms): Promise<void>",
        "timer-core",
      )
      const dependencyNode = new AdaptiveRoadmap.Node({
        id: "timer-core",
        title: "Timer core",
        goal: "Expose timer behavior.",
        status: "ready",
        interfaces: [
          new AdaptiveRoadmap.InterfaceRef({
            key: dependencyContract.ref.key,
            name: "sleep",
            kind: "function",
            signature: "sleep(ms): Promise<void>",
            version: dependencyContract.ref.version,
            state: "ready",
          }),
        ],
        dependencies: [],
        details: [dependencyContract.ref],
        acceptance: [],
        risks: [],
        unresolved: [],
      })
      const originalNode = base.roadmap.nodes[0]
      const currentNode = new AdaptiveRoadmap.Node({
        id: originalNode.id,
        title: originalNode.title,
        goal: originalNode.goal,
        status: originalNode.status,
        owner: originalNode.owner,
        interfaces: originalNode.interfaces,
        dependencies: [
          new AdaptiveRoadmap.Dependency({
            nodeID: dependencyNode.id,
            kind: "contract",
            contractKey: dependencyContract.ref.key,
            reason: "Retry scheduling waits through the timer contract.",
          }),
        ],
        details: originalNode.details,
        acceptance: originalNode.acceptance,
        risks: originalNode.risks,
        unresolved: originalNode.unresolved,
      })
      const roadmap = new AdaptiveRoadmap.Info({
        taskID: base.roadmap.taskID,
        revision: base.roadmap.revision,
        requirement: base.roadmap.requirement,
        nodes: [currentNode, dependencyNode, base.roadmap.nodes[1]],
        risks: base.roadmap.risks,
        unresolved: base.roadmap.unresolved,
      })
      const originalAssignment = base.assignment!
      const assignment = new AdaptiveOperation.Assignment({
        id: originalAssignment.id,
        taskID: originalAssignment.taskID,
        workerID: originalAssignment.workerID,
        nodeID: originalAssignment.nodeID,
        roadmapRevision: originalAssignment.roadmapRevision,
        detailRefs: [originalAssignment.detailRefs[0], dependencyContract.ref],
        permittedPaths: originalAssignment.permittedPaths,
        baseCommit: originalAssignment.baseCommit,
        acceptanceCommands: originalAssignment.acceptanceCommands,
        generation: originalAssignment.generation,
        timeCreated: originalAssignment.timeCreated,
      })
      const planned = AdaptiveContextAssembler.plan({
        ...base,
        roadmap,
        assignment,
        details: [...base.details, dependencyContract],
        modelPolicy: policy(),
      })

      expect(planned._tag).toBe("Ready")
      if (planned._tag !== "Ready") return
      expect(planned.components.find((component) => component.key === "detail:contract:timer-api@4")).toMatchObject({
        kind: "contract",
        priority: "mandatory",
        evictable: false,
      })
    }),
  )

  it.effect("uses a mandatory Coordinator cycle and excludes unreferenced implementation workspace", () =>
    Effect.gen(function* () {
      const taskID = AdaptiveTask.ID.create()
      const agentID = AdaptiveTask.AgentID.create()
      const base = source(taskID, agentID, 1)
      const planned = AdaptiveContextAssembler.plan({
        ...base,
        assignment: undefined,
        agentRole: "coordinator",
        coordinatorCycle: {
          sourceRevision: "coordinator:r1:10..12",
          text: "# Coordinator Cycle\nProcess durable events 11 through 12.",
        },
        workspace: { sourceRevision: "workspace:implementation", text: "unreferenced implementation diff" },
        modelPolicy: policy(),
      } as AdaptiveContextAssembler.PlanInput)

      expect(planned._tag).toBe("Ready")
      if (planned._tag !== "Ready") return
      expect(planned.components.find((component) => component.key === "coordinator-cycle")).toMatchObject({
        kind: "coordinator-cycle",
        priority: "mandatory",
        evictable: false,
      })
      expect(planned.components.map((component) => component.key)).not.toContain("workspace")
    }),
  )

  it.effect("fails closed when a mandatory Coordinator cycle exceeds the input budget", () =>
    Effect.gen(function* () {
      const taskID = AdaptiveTask.ID.create()
      const agentID = AdaptiveTask.AgentID.create()
      const planned = AdaptiveContextAssembler.plan({
        ...source(taskID, agentID, 1),
        assignment: undefined,
        agentRole: "coordinator",
        coordinatorCycle: {
          sourceRevision: "coordinator:r1:10..12",
          text: "cycle ".repeat(5_000),
        },
        modelPolicy: policy(1_000),
      } as AdaptiveContextAssembler.PlanInput)

      expect(planned._tag).toBe("ContextBudgetUnsatisfiable")
      if (planned._tag !== "ContextBudgetUnsatisfiable") return
      expect(planned.mandatoryTokens).toBeGreaterThan(planned.inputBudget)
    }),
  )

  it.effect("derives the Coordinator cycle from the authoritative Agent cursor", () =>
    Effect.gen(function* () {
      const store = yield* AdaptiveStore.Service
      const task = yield* store.createTask({
        id: AdaptiveTask.ID.create(),
        directory: "/workspace/project",
        mode: "normal",
        status: "running",
        requirement: "Implement bounded retry.",
        modelPolicy: policy(),
        roadmapRevision: 0,
        baseSnapshotHash: "git:abc123",
      })
      const agent = yield* store.createAgent({
        id: AdaptiveTask.AgentID.create(),
        taskID: task.id,
        role: "coordinator",
      })
      const claimed = yield* store.claimAgent({
        agentID: agent.id,
        expectedGeneration: 0,
        owner: "controller-a",
        pid: 102,
        leaseDurationMs: 60_000,
      })
      const snapshot = source(task.id, claimed.id, claimed.generation)
      yield* (yield* AdaptiveRoadmapStore.Service).commit({
        expectedRevision: 0,
        roadmap: snapshot.roadmap,
        details: snapshot.details,
        sourceAgentID: claimed.id,
        sourceGeneration: claimed.generation,
      })
      const result = yield* (yield* AdaptiveContextAssembler.Service).assemble(
        invocation(snapshot, {
          assignmentID: undefined,
          purpose: "Coordinator bootstrap cycle",
          workspace: { sourceRevision: "workspace:implementation", text: "unreferenced implementation diff" },
        }),
      )

      expect(result.components.find((component) => component.key === "coordinator-cycle")).toMatchObject({
        sourceRevision: "coordinator:r1:0:0",
        priority: "mandatory",
      })
      expect(result.components.map((component) => component.key)).not.toContain("workspace")
    }),
  )

  it.effect("selects only unique events after the Checkpoint cursor in sequence order", () =>
    Effect.gen(function* () {
      const taskID = AdaptiveTask.ID.create()
      const agentID = AdaptiveTask.AgentID.create()
      const base = source(taskID, agentID, 1)
      const checkpoint = new AdaptiveOperation.Checkpoint({
        assignmentID: base.assignment!.id,
        workerID: agentID,
        generation: 1,
        sequence: 2,
        eventCursor: 10,
        roadmapRevision: 1,
        nodeID: "retry-core",
        completed: [],
        decisions: [],
        modifiedPaths: [],
        evidence: [],
        remaining: ["finish"],
        nextAction: "Continue.",
        worktreeHead: "abc123",
        diffHash: digest("diff"),
        timeCreated: 2,
      })
      const planned = AdaptiveContextAssembler.plan({
        ...base,
        checkpoint,
        events: [
          { id: "old", sequence: 9, text: "old" },
          { id: "cursor", sequence: 10, text: "cursor" },
          { id: "b", sequence: 12, text: "second" },
          { id: "a", sequence: 11, text: "first" },
          { id: "a", sequence: 13, text: "duplicate" },
        ],
        modelPolicy: policy(),
      })

      expect(planned._tag).toBe("Ready")
      if (planned._tag !== "Ready") return
      expect(
        planned.components.filter((component) => component.kind === "tool-event").map((component) => component.key),
      ).toEqual(["event:11:a", "event:12:b"])
    }),
  )

  it.effect("keeps event chronology numeric across decimal key boundaries", () =>
    Effect.gen(function* () {
      const taskID = AdaptiveTask.ID.create()
      const agentID = AdaptiveTask.AgentID.create()
      const planned = AdaptiveContextAssembler.plan({
        ...source(taskID, agentID, 1),
        events: [
          { id: "ten", sequence: 10, text: "tenth" },
          { id: "nine", sequence: 9, text: "ninth" },
        ],
        modelPolicy: policy(),
      })

      expect(planned._tag).toBe("Ready")
      if (planned._tag !== "Ready") return
      expect(
        planned.components.filter((component) => component.key.startsWith("event:")).map((component) => component.key),
      ).toEqual(["event:9:nine", "event:10:ten"])
    }),
  )

  it.effect("signals a soft restart at the token, local-turn, and event-tail boundaries", () =>
    Effect.gen(function* () {
      const taskID = AdaptiveTask.ID.create()
      const agentID = AdaptiveTask.AgentID.create()
      const base = source(taskID, agentID, 1)
      const ordinary = AdaptiveContextAssembler.plan({ ...base, modelPolicy: policy() })
      if (ordinary._tag !== "Ready") throw new Error(`Expected Ready, got ${ordinary._tag}`)
      const tokenBudget = Math.max(ordinary.estimatedTokens, Math.floor(ordinary.estimatedTokens / 0.81))
      const token = AdaptiveContextAssembler.plan({ ...base, modelPolicy: policy(tokenBudget) })
      const turns = AdaptiveContextAssembler.plan({
        ...base,
        localTail: { turns: 24, sourceRevision: "tail:24", text: "tail" },
        modelPolicy: policy(),
      })
      const events = AdaptiveContextAssembler.plan({
        ...base,
        events: Array.from({ length: 257 }, (_, index) => ({
          id: `event-${index}`,
          sequence: index + 1,
          text: `event ${index}`,
        })),
        modelPolicy: policy(100_000),
      })

      expect(token._tag).toBe("Ready")
      expect(turns._tag).toBe("Ready")
      expect(events._tag).toBe("Ready")
      if (token._tag !== "Ready" || turns._tag !== "Ready" || events._tag !== "Ready") return
      expect(token.restartReason).toBe("context_80_percent")
      expect(turns.restartReason).toBe("local_tail_limit")
      expect(events.restartReason).toBe("event_tail_limit")
      expect(events.components.filter((component) => component.kind === "tool-event")).toHaveLength(256)
    }),
  )
})
