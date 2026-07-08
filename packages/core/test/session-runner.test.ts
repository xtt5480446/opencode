import { describe, expect, test } from "bun:test"
import {
  LLMError,
  LLMEvent,
  Model,
  ToolFailure,
  TransportReason,
  InvalidRequestReason,
  RateLimitReason,
  type LLMClientService,
  type LLMRequest,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Form } from "@opencode-ai/core/form"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionRunnerSystemPrompt } from "@opencode-ai/core/session/runner/system-prompt"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { QuestionTool } from "@opencode-ai/core/tool/question"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigCompaction } from "@opencode-ai/core/config/compaction"
import { Tool } from "@opencode-ai/core/tool/tool"
import {
  InstructionCheckpointTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { InstructionEntry } from "@opencode-ai/core/session/instruction-entry"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Instructions } from "@opencode-ai/core/instructions"
import { InstructionBuiltIns } from "@opencode-ai/core/instructions/builtins"
import { InstructionDiscovery } from "@opencode-ai/core/instruction-discovery"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { McpGuidance } from "@opencode-ai/core/mcp/guidance"
import { ModelV2 } from "@opencode-ai/core/model"
import { Location } from "@opencode-ai/core/location"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import type { Scope } from "effect/Scope"
import { TestClock } from "effect/testing"
import { asc, eq } from "drizzle-orm"
import { it as effectIt } from "./lib/effect"
import { RunnerScenario } from "./lib/runner-scenario"

let toolExecutionGate: Deferred.Deferred<void> | undefined
let toolExecutionsStarted: Deferred.Deferred<void> | undefined
let toolExecutionsReady = 5
let activeToolExecutions = 0
let maxActiveToolExecutions = 0
const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const defaultSystem = SessionRunnerSystemPrompt.provider(model)
const replacementModel = Model.make({ id: "replacement", provider: "fake", route: OpenAIChat.route })
const compactModel = Model.make({
  id: "compact",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 4_000, output: 50 } }),
})
const recoveryModel = Model.make({
  id: "recovery",
  provider: "fake",
  route: OpenAIChat.route.with({ limits: { context: 20_000, output: 1_000 } }),
})

test("calculates step cost using the matching context tier", () => {
  expect(
    SessionRunnerLLM.calculateCost(
      [
        { input: 1, output: 2, cache: { read: 0.1, write: 0.5 } },
        { tier: { type: "context", size: 100 }, input: 3, output: 4, cache: { read: 0.2, write: 0.6 } },
      ],
      { input: 80, output: 10, reasoning: 2, cache: { read: 20, write: 1 } },
    ),
  ).toBeCloseTo(0.0002926)
})

test("does not apply an ineligible tier without base pricing", () => {
  expect(
    SessionRunnerLLM.calculateCost(
      [{ tier: { type: "context", size: 100 }, input: 3, output: 4, cache: { read: 0.2, write: 0.6 } }],
      { input: 80, output: 10, reasoning: 2, cache: { read: 20, write: 0 } },
    ),
  ).toBe(0)
})

const authorizations: Tool.Context[] = []
const executions: string[] = []
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const echo = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      echo: Tool.make({
        description: "Echo text",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }, context) =>
          Effect.gen(function* () {
            authorizations.push(context)
            executions.push(text)
            activeToolExecutions++
            maxActiveToolExecutions = Math.max(maxActiveToolExecutions, activeToolExecutions)
            if (activeToolExecutions === toolExecutionsReady && toolExecutionsStarted) {
              yield* Deferred.succeed(toolExecutionsStarted, undefined)
            }
            if (toolExecutionGate) yield* Deferred.await(toolExecutionGate)
            return { text }
          }).pipe(Effect.ensuring(Effect.sync(() => activeToolExecutions--))),
      }),
      defect: Tool.make({
        description: "Fail unexpectedly",
        input: Schema.Struct({}),
        output: Schema.Struct({}),
        execute: () =>
          (toolExecutionGate ? Deferred.await(toolExecutionGate) : Effect.void).pipe(
            Effect.andThen(Effect.die("unexpected tool defect")),
          ),
      }),
      // BigInt output with no model content forces ToolOutputStore.bound onto its
      // JSON.stringify encode path, which fails with a typed StorageError.
      storefail: Tool.make({
        description: "Produce output that cannot be persisted",
        input: Schema.Struct({}),
        output: Schema.Any,
        execute: () => Effect.succeed({ big: 1n }),
      }),
    }),
  ),
)
const echoNode = makeLocationNode({ name: "test/session-runner-tools", layer: echo, deps: [ToolRegistry.node] })
let modelResolveHook = Effect.void
let currentModel = model
const models = SessionRunnerModel.layerWith((session) =>
  modelResolveHook.pipe(
    Effect.as(
      SessionRunnerModel.resolved(
        session.model?.id === "replacement" ? replacementModel : currentModel,
        session.model?.variant,
      ),
    ),
  ),
)
const systemContextKey = Instructions.Key.make("test/context")
let systemBaseline = "Initial context"
let systemRemoved = false
let systemUnavailable = false
let systemLoadHook = Effect.void
const skillBaselines = new Map<AgentV2.ID, string>()
const systemContext = Layer.mock(InstructionBuiltIns.Service, {
  load: () =>
    Effect.sync(() =>
      Instructions.combine(
        systemRemoved
          ? []
          : [
              Instructions.make({
                key: systemContextKey,
                codec: Schema.toCodecJson(Schema.String),
                load: systemLoadHook.pipe(
                  Effect.andThen(Effect.sync(() => (systemUnavailable ? Instructions.unavailable : systemBaseline))),
                ),
                baseline: String,
                update: (_previous, current) => current,
                removed: () => "System context source removed: test/context",
              }),
            ],
      ),
    ),
})
const instructionContext = Layer.mock(InstructionDiscovery.Service, { load: () => Effect.succeed(Instructions.empty) })
const skillGuidance = Layer.mock(SkillGuidance.Service, {
  load: (agent) =>
    Effect.succeed(
      skillBaselines.has(agent.id)
        ? Instructions.make({
            key: Instructions.Key.make("test/skill-guidance"),
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed(skillBaselines.get(agent.id)!),
            baseline: String,
            update: (_previous, current) => current,
            removed: () => "Skill guidance removed",
          })
        : Instructions.empty,
    ),
})
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(Instructions.empty) })
const mcpGuidance = Layer.mock(McpGuidance.Service, { load: () => Effect.succeed(Instructions.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({
            compaction: new ConfigCompaction.Info({
              buffer: 3_000,
              keep: new ConfigCompaction.Keep({ tokens: 1_000 }),
            }),
          }),
        }),
      ]),
  }),
)
const runnerLayerWith = (clientLayer: Layer.Layer<LLMClientService>) =>
  AppNodeBuilder.build(SessionRunnerLLM.node, [
    [Snapshot.node, Snapshot.noopLayer],
    [LayerNodePlatform.llmClient, clientLayer],
    [SessionRunnerModel.node, models],
    [InstructionBuiltIns.node, systemContext],
    [InstructionDiscovery.node, instructionContext],
    [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
    [SkillGuidance.node, skillGuidance],
    [ReferenceGuidance.node, referenceGuidance],
    [PermissionV2.node, permission],
    [Config.node, config],
    [McpGuidance.node, mcpGuidance],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ])
const executionWith = (runnerLayer: ReturnType<typeof runnerLayerWith>) =>
  Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const sessionRunner = yield* SessionRunner.Service
      const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
        drain: (sessionID, force) => sessionRunner.drain({ sessionID, force }),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        resume: coordinator.run,
        wake: coordinator.wake,
        interrupt: coordinator.interrupt,
        awaitIdle: coordinator.awaitIdle,
      })
    }),
  ).pipe(Layer.provide(runnerLayer))
const testLayerWith = (clientLayer: Layer.Layer<LLMClientService>) => {
  const runnerLayer = runnerLayerWith(clientLayer)
  const execution = executionWith(runnerLayer)
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      Form.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      echoNode,
      SessionRunnerModel.node,
      InstructionBuiltIns.node,
      InstructionDiscovery.node,
      InstructionEntry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, clientLayer],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [InstructionBuiltIns.node, systemContext],
      [InstructionDiscovery.node, instructionContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  )
}
const sessionID = SessionV2.ID.make("ses_runner_test")
const otherSessionID = SessionV2.ID.make("ses_runner_other")
const makeSessionScenario = () =>
  RunnerScenario.make(() => SessionV2.Service.use((session) => session.resume(sessionID)))
type SessionScenario = Effect.Success<ReturnType<typeof makeSessionScenario>>
type TestServices = Layer.Success<ReturnType<typeof testLayerWith>>
const scenarioIt = <A, E>(
  name: string,
  body: (scenario: SessionScenario) => Effect.Effect<A, E, TestServices | Scope>,
) =>
  effectIt.effect(name, () =>
    Effect.gen(function* () {
      const scenario = yield* makeSessionScenario()
      return yield* body(scenario).pipe(Effect.provide(testLayerWith(scenario.llm.layer)))
    }),
  )

const insertSession = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  systemBaseline = "Initial context"
  systemRemoved = false
  systemUnavailable = false
  systemLoadHook = Effect.void
  modelResolveHook = Effect.void
  currentModel = model
  skillBaselines.clear()
  toolExecutionGate = undefined
  toolExecutionsStarted = undefined
  toolExecutionsReady = 5
  activeToolExecutions = 0
  maxActiveToolExecutions = 0
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* insertSession(sessionID)
})

const providerUnavailable = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "Provider unavailable" }),
  })

const invalidRequest = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new InvalidRequestReason({ message: "Invalid request" }),
  })

const rateLimited = (retryAfterMs?: number) =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new RateLimitReason({ message: "Rate limited", retryAfterMs }),
  })

const setupOverflowRecovery = (scenario: SessionScenario) =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    yield* session.prompt({
      sessionID,
      prompt: PromptInput.Prompt.make({ text: "Earlier question ".repeat(700) }),
      resume: false,
    })
    yield* scenario.run(function* () {
      yield* (yield* scenario.llm.next()).respond.text("Earlier answer", { id: "text-earlier" })
    })
    currentModel = recoveryModel
    return session
  })

const messageTexts = (request: LLMRequest, role: "user" | "system") =>
  request.messages.flatMap((message) =>
    message.role === role ? message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])) : [],
  )
const userTexts = (request: LLMRequest) => messageTexts(request, "user")
const systemTexts = (request: LLMRequest) => messageTexts(request, "system")

const recordedEventTypes = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((row) => row.type)),
      )
  })

const recordedStepSettlementEvents = (id: SessionV2.ID, assistantMessageID: SessionMessage.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const settlementTypes = new Set([
      "session.step.started.1",
      "session.tool.called.1",
      "session.tool.success.1",
      "session.tool.failed.1",
      "session.step.ended.1",
      "session.step.failed.1",
    ])
    return (yield* db
      .select({ type: EventTable.type, data: EventTable.data })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)).filter(
      (event) => settlementTypes.has(event.type) && event.data.assistantMessageID === assistantMessageID,
    )
  })

const requireAssistant = (messages: readonly SessionMessage.Message[]) => {
  const assistant = messages.find((message) => message.type === "assistant")
  if (!assistant) throw new Error("Assistant message missing")
  return assistant
}

const replaySessionProjection = (id: SessionV2.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)

    yield* events.remove(id)
    yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, id)).run().pipe(Effect.orDie)
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* events.replayAll(
      recorded.map((event) => ({
        id: event.id,
        created: DateTime.makeUnsafe(event.created),
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
    )
  })

type FragmentKind = "text" | "reasoning" | "tool input"

type FragmentFixture = {
  readonly delta: EventV2.Definition
  readonly completeEvents: LLMEvent[]
  readonly partialEvents: LLMEvent[]
  readonly expectedAssistant: unknown
  readonly expectedContent: unknown
}

const fragmentKinds: readonly FragmentKind[] = ["text", "reasoning", "tool input"]

const fragmentID = (kind: FragmentKind, suffix: string) => `${kind === "tool input" ? "call" : kind}-${suffix}`

const fragmentFixture = (kind: FragmentKind, id: string, chunks: readonly string[]): FragmentFixture => {
  const text = chunks.join("")
  switch (kind) {
    case "text": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id }),
        ...chunks.map((text) => LLMEvent.textDelta({ id, text })),
      ]
      const expectedContent = { type: "text", text }
      return {
        delta: SessionEvent.Text.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.textEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "reasoning": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.reasoningStart({ id }),
        ...chunks.map((text) => LLMEvent.reasoningDelta({ id, text })),
      ]
      const expectedContent = { type: "reasoning", text }
      return {
        delta: SessionEvent.Reasoning.Delta,
        partialEvents,
        completeEvents: [
          ...partialEvents,
          LLMEvent.reasoningEnd({ id }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        expectedAssistant: { type: "assistant", finish: "stop", content: [expectedContent] },
        expectedContent,
      }
    }
    case "tool input": {
      const partialEvents = [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id, name: "echo" }),
        ...chunks.map((text) => LLMEvent.toolInputDelta({ id, name: "echo", text })),
      ]
      const expectedContent = { type: "tool", id, state: { status: "pending", input: text } }
      return {
        delta: SessionEvent.Tool.Input.Delta,
        partialEvents,
        completeEvents: [...partialEvents, LLMEvent.toolInputEnd({ id, name: "echo" })],
        expectedAssistant: { type: "assistant", content: [expectedContent] },
        expectedContent,
      }
    }
  }
}

describe("SessionRunnerLLM", () => {
  scenarioIt("advertises and executes a location registered tool", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const registry = yield* ToolRegistry.Service
      const session = yield* SessionV2.Service
      const contexts: Tool.Context[] = []
      yield* registry.register({
        location_context: Tool.make({
          description: "Read application context",
          input: Schema.Struct({ query: Schema.String }),
          output: Schema.Struct({ answer: Schema.String }),
          execute: ({ query }, context) =>
            Effect.sync(() => {
              contexts.push(context)
              return { answer: query.toUpperCase() }
            }),
        }),
      })
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Use application context" }),
        resume: false,
      })
      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.tools.map((tool) => tool.name)).toContain("location_context")
        yield* call.respond.toolCall("location_context", { query: "hello" }, { id: "call-location" })
        yield* (yield* scenario.llm.next()).respond.events()
      })
      expect(contexts).toEqual([
        {
          sessionID,
          agent: AgentV2.ID.make("build"),
          assistantMessageID: expect.stringMatching(/^msg_/),
          toolCallID: "call-location",
        },
      ])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use application context" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-location",
              state: { status: "completed", structured: { answer: "HELLO" } },
            },
          ],
        },
      ])
    }),
  )

  scenarioIt("starts a real runner turn after default prompt recording", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service

      const message = yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Run automatically" }),
      })
      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events()
      })

      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.messages({ sessionID })).toMatchObject([
        { id: message.id, type: "user", text: "Run automatically" },
      ])
    }),
  )

  scenarioIt("streams one request with registry definitions from chronological V2 user history", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Second" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.model).toBe(model)
        expect(call.request.tools.map((tool) => tool.name)).toEqual(["echo", "defect", "storefail"])
        expect(call.request.messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
          { role: "user", content: [{ type: "text", text: "First" }] },
          { role: "user", content: [{ type: "text", text: "Second" }] },
        ])
        yield* call.respond.events()
      })

      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.messages({ sessionID })).toHaveLength(2)
    }),
  )

  scenarioIt("retries the first provider turn after system context becomes available", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const messageID = SessionMessage.ID.create()
      systemUnavailable = true
      yield* session.prompt({
        id: messageID,
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "First" }),
        resume: false,
      })

      const exit = yield* scenario
        .run(function* () {
          yield* scenario.llm.next()
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(Instructions.InitializationBlocked)
      expect(yield* scenario.llm.requests).toHaveLength(0)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
      expect(
        yield* db
          .select()
          .from(InstructionCheckpointTable)
          .where(eq(InstructionCheckpointTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      systemUnavailable = false
      yield* session.prompt({ id: messageID, sessionID, prompt: PromptInput.Prompt.make({ text: "First" }) })
      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.messages.map((message) => message.role)).toEqual(["user"])
        yield* call.respond.events()
      })

      expect(yield* scenario.llm.requests).toHaveLength(1)
    }),
  )

  scenarioIt("interrupts a source Location runner after a Session moves", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events()
      })

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
      })
      expect(
        yield* db
          .select()
          .from(InstructionCheckpointTable)
          .where(eq(InstructionCheckpointTable.session_id, sessionID))
          .get(),
      ).toBeUndefined()

      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Second" }), resume: false })
      const exit = yield* scenario
        .run(function* () {
          yield* scenario.llm.next()
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)
    }),
  )

  scenarioIt("copies the context checkpoint to a fork", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })
      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events()
      })

      const forked = yield* session.fork({ sessionID })

      const parent = yield* db
        .select()
        .from(InstructionCheckpointTable)
        .where(eq(InstructionCheckpointTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(parent).toBeDefined()
      expect(
        yield* db
          .select()
          .from(InstructionCheckpointTable)
          .where(eq(InstructionCheckpointTable.session_id, forked.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({ ...parent!, session_id: forked.id })
    }),
  )

  scenarioIt("heals an undecodable stored applied record by re-announcing context", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })
      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events()
      })
      yield* db
        .update(InstructionCheckpointTable)
        .set({ snapshot: { invalid: { value: "bad" } } })
        .where(eq(InstructionCheckpointTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Second" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        // Comparison state was lost, so every source re-announces as new.
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
        expect(call.request.messages.map((message) => message.role)).toEqual(["user", "system", "user"])
        expect(call.request.messages.at(1)?.content).toEqual([{ type: "text", text: "Initial context" }])
        yield* call.respond.events()
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
      const healed = yield* db
        .select({ snapshot: InstructionCheckpointTable.snapshot })
        .from(InstructionCheckpointTable)
        .where(eq(InstructionCheckpointTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      expect(healed?.snapshot).toEqual({ "test/context": { value: "Initial context", removed: expect.any(String) } })
    }),
  )

  scenarioIt("reuses one durable baseline after the context producer changes", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
        yield* call.respond.events()
      })
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Second" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
        expect(call.request.messages.map((message) => message.role)).toEqual(["user", "system", "user"])
        expect(call.request.messages.at(1)?.content).toEqual([{ type: "text", text: "Changed context" }])
        yield* call.respond.events()
      })

      expect(yield* session.messages({ sessionID })).toHaveLength(3)
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.instructions.updated.1"))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  scenarioIt("uses the selected model family prompt when the agent does not override it", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      currentModel = Model.make({ id: "gpt-5", provider: "openai", route: OpenAIChat.route })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([
          expect.stringContaining("You are OpenCode, You and the user share the same workspace"),
          "Initial context",
        ])
        yield* call.respond.text("Done", { id: "text-provider-prompt" })
      })
    }),
  )

  scenarioIt("uses the selected model family prompt when the agent system override is empty", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      currentModel = Model.make({ id: "gpt-5", provider: "openai", route: OpenAIChat.route })
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = ""
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([
          expect.stringContaining("You are OpenCode, You and the user share the same workspace"),
          "Initial context",
        ])
        yield* call.respond.text("Done", { id: "text-empty-agent-system" })
      })
    }),
  )

  scenarioIt("includes the effective default agent system before durable context", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual(["Build agent instructions", "Initial context"])
        yield* call.respond.text("Done", { id: "text-build" })
      })
    }),
  )

  scenarioIt("uses the configured default agent system for omitted-agent sessions", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) => {
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        })
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        })
        editor.default(AgentV2.ID.make("reviewer"))
      })
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context"])
        yield* call.respond.text("Done", { id: "text-reviewer" })
      })

      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  scenarioIt("uses only the agent prompt and durable baseline as system parts", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.system = "Build agent instructions"
          agent.mode = "primary"
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual(["Build agent instructions", "Initial context"])
        yield* call.respond.text("Done", { id: "text-no-system" })
      })
    }),
  )

  scenarioIt("uses an explicitly selected non-build agent system", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const agent = yield* AgentV2.Service
      yield* agent.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.system = "Reviewer instructions"
          agent.mode = "primary"
        }),
      )
      yield* db
        .update(SessionTable)
        .set({ agent: "reviewer" })
        .where(eq(SessionTable.id, sessionID))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual(["Reviewer instructions", "Initial context"])
        yield* call.respond.text("Done", { id: "text-selected" })
      })

      expect((yield* session.messages({ sessionID }))[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
    }),
  )

  scenarioIt("updates selected-agent skill guidance after an agent switch", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context\n\nBuild skills"])
        yield* call.respond.events()
      })
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      yield* events.publish(SessionEvent.AgentSelected, {
        sessionID,
        agent: "reviewer",
      })
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Second" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context\n\nBuild skills"])
        expect(systemTexts(call.request)).toContainEqual(expect.stringContaining("Reviewer skills"))
        yield* call.respond.events()
      })
    }),
  )

  scenarioIt("keeps the sampled agent when selection changes during observation", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      skillBaselines.set(AgentV2.ID.make("build"), "Build skills")
      skillBaselines.set(AgentV2.ID.make("reviewer"), "Reviewer skills")
      let switched = false
      systemLoadHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.AgentSelected, {
            sessionID,
            agent: "reviewer",
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context\n\nBuild skills"])
        yield* call.respond.events()
      })
    }),
  )

  scenarioIt("keeps the sampled model when selection changes during model resolution", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      let switched = false
      modelResolveHook = Effect.suspend(() => {
        if (switched) return Effect.void
        switched = true
        return events
          .publish(SessionEvent.ModelSelected, {
            sessionID,
            model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
          })
          .pipe(Effect.asVoid)
      })
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.model).toBe(model)
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
        yield* call.respond.events()
      })
    }),
  )

  scenarioIt("admits removed context as a chronological System message", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events()
      })
      systemRemoved = true
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Second" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.messages.map((message) => message.role)).toEqual(["user", "system", "user"])
        expect(call.request.messages.at(1)?.content).toEqual([
          { type: "text", text: "System context source removed: test/context" },
        ])
        yield* call.respond.events()
      })

      expect(yield* session.messages({ sessionID })).toHaveLength(3)
    }),
  )

  scenarioIt("renders API context entries through the belief lifecycle", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const contextEntries = yield* InstructionEntry.Service
      yield* contextEntries.put({ sessionID, key: "deploy-target", value: "production" })
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        // String values render verbatim inside the tagged block at baseline.
        expect(call.request.system.map((part) => part.text)).toEqual([
          defaultSystem,
          ["Initial context", "", '<context key="deploy-target">', "production", "</context>"].join("\n"),
        ])
        yield* call.respond.events()
      })

      // Non-string JSON pretty-prints; the change narrates as a System update.
      yield* contextEntries.put({ sessionID, key: "deploy-target", value: { region: "us-east-1" } })
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Second" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.messages.map((message) => message.role)).toEqual(["user", "system", "user"])
        expect(call.request.messages.at(1)?.content).toEqual([
          {
            type: "text",
            text: [
              'The context under "deploy-target" changed and supersedes the previous value:',
              '<context key="deploy-target">',
              "{",
              '  "region": "us-east-1"',
              "}",
              "</context>",
            ].join("\n"),
          },
        ])
        yield* call.respond.events()
      })
      expect(yield* contextEntries.list(sessionID)).toEqual([{ key: "deploy-target", value: { region: "us-east-1" } }])

      // Deleting the row announces removal through the stored removal text.
      yield* contextEntries.remove({ sessionID, key: "deploy-target" })
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Third" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.messages.map((message) => message.role)).toEqual([
          "user",
          "system",
          "user",
          "system",
          "user",
        ])
        expect(call.request.messages.at(-2)?.content).toEqual([
          { type: "text", text: 'The context under "deploy-target" no longer applies. Disregard it.' },
        ])
        yield* call.respond.events()
      })

      expect(yield* contextEntries.list(sessionID)).toEqual([])
    }),
  )

  scenarioIt("keeps the baseline and chronological System updates after a model switch", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
        yield* call.respond.events()
      })
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Second" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
        expect(call.request.messages.map((message) => message.role)).toEqual(["user", "system", "user"])
        yield* call.respond.events()
      })
      yield* events.publish(SessionEvent.ModelSelected, {
        sessionID,
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Third" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
        expect(call.request.messages.filter((message) => message.role === "system")).toHaveLength(2)
        yield* call.respond.events()
      })
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "system",
        "user",
        "model-switched",
        "system",
        "user",
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.messages({ sessionID })).toHaveLength(6)
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Fourth" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events()
      })
    }),
  )

  scenarioIt("preserves the baseline while context is temporarily unavailable", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
        yield* call.respond.events()
      })
      yield* events.publish(SessionEvent.ModelSelected, {
        sessionID,
        model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Second" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
        yield* call.respond.events()
      })
      systemUnavailable = false
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Third" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
        yield* call.respond.events()
      })
    }),
  )

  scenarioIt("rebuilds the baseline directly after completed compaction", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
        yield* call.respond.events()
      })
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemBaseline = "Replacement context"
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Second" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Replacement context"])
        yield* call.respond.events()
      })
      yield* replaySessionProjection(sessionID)
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Third" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events()
      })
    }),
  )

  scenarioIt("runs one durable compaction barrier before later steer and queued prompts", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      currentModel = recoveryModel
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Active work" }), resume: false })

      yield* scenario.run(function* () {
        const active = yield* scenario.llm.next()
        const first = yield* session.compact({ sessionID })
        const second = yield* session.compact({ sessionID })
        expect(second.id).toBe(first.id)
        expect(yield* SessionInput.pendingCompaction((yield* Database.Service).db, sessionID)).toMatchObject({
          id: first.id,
        })
        expect((yield* session.messages({ sessionID })).find((message) => message.id === first.id)).toMatchObject({
          type: "compaction",
          status: "queued",
        })

        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Steer after compaction" }),
          resume: false,
        })
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Queue after compaction" }),
          delivery: "queue",
          resume: false,
        })
        expect(yield* SessionInput.hasPending((yield* Database.Service).db, sessionID, "steer")).toBe(false)
        yield* active.respond.text("Active complete", { id: "text-active" })

        const compaction = yield* scenario.llm.next()
        expect(userTexts(compaction.request)[0]).toContain("Create a new anchored summary")
        yield* compaction.respond.events(LLMEvent.textDelta({ id: "summary", text: "durable summary" }))

        const steer = yield* scenario.llm.next()
        expect(userTexts(steer.request)).toContain("Steer after compaction")
        yield* steer.respond.text("Steer complete", { id: "text-steer" })

        const queue = yield* scenario.llm.next()
        expect(userTexts(queue.request)).toContain("Queue after compaction")
        yield* queue.respond.text("Queue complete", { id: "text-queue" })

        expect(yield* SessionInput.pendingCompaction((yield* Database.Service).db, sessionID)).toBeUndefined()
        expect((yield* session.messages({ sessionID })).find((message) => message.id === first.id)).toMatchObject({
          type: "compaction",
          status: "completed",
          summary: "durable summary",
        })
      })

      expect(yield* scenario.llm.requests).toHaveLength(4)
    }),
  )

  scenarioIt("releases queued prompts when durable compaction fails", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      currentModel = recoveryModel
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Active work" }), resume: false })

      yield* scenario.run(function* () {
        const active = yield* scenario.llm.next()
        const compaction = yield* session.compact({ sessionID })
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Continue after failure" }),
          delivery: "queue",
          resume: false,
        })
        yield* active.respond.text("Active complete", { id: "text-active-failure" })

        yield* (yield* scenario.llm.next()).respond.events()
        const continued = yield* scenario.llm.next()
        expect(userTexts(continued.request)).toContain("Continue after failure")
        yield* continued.respond.text("Continued", { id: "text-after-failure" })

        expect(yield* SessionInput.pendingCompaction((yield* Database.Service).db, sessionID)).toBeUndefined()
        expect((yield* session.messages({ sessionID })).find((message) => message.id === compaction.id)).toMatchObject({
          type: "compaction",
          status: "failed",
        })
      })

      expect(yield* scenario.llm.requests).toHaveLength(3)
    }),
  )

  scenarioIt("automatically compacts into a completed summary and retained recent turn", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Earlier question ".repeat(180) }),
        resume: false,
      })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.text("Earlier answer", { id: "text-first" })
      })
      currentModel = compactModel
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Recent exact request ".repeat(180) }),
        resume: false,
      })

      yield* scenario.run(function* () {
        const summary = yield* scenario.llm.next()
        expect(userTexts(summary.request)[0]).toContain("## Objective")
        yield* summary.respond.text("## Objective\n- Preserve the task", { id: "text-summary" })

        const continued = yield* scenario.llm.next()
        expect(userTexts(continued.request)).toHaveLength(1)
        expect(userTexts(continued.request)[0]).toContain("<summary>\n## Objective\n- Preserve the task\n</summary>")
        expect(userTexts(continued.request)[0]).toContain(`[User]: ${"Recent exact request ".repeat(180)}`)
        yield* continued.respond.text("Continued", { id: "text-final" })
      })
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Newest exact request ".repeat(180) }),
        resume: false,
      })

      yield* scenario.run(function* () {
        const updatedSummary = yield* scenario.llm.next()
        expect(userTexts(updatedSummary.request)[0]).toContain(
          "<previous-summary>\n## Objective\n- Preserve the task\n</previous-summary>",
        )
        expect(userTexts(updatedSummary.request)[0]).toContain("Recent exact request")
        yield* updatedSummary.respond.text("## Objective\n- Preserve the updated task", { id: "text-summary-2" })

        yield* (yield* scenario.llm.next()).respond.text("Continued again", { id: "text-final-2" })
        expect((yield* (yield* SessionStore.Service).context(sessionID))[0]).toMatchObject({
          type: "compaction",
          summary: "## Objective\n- Preserve the updated task",
        })
      })

      expect(yield* scenario.llm.requests).toHaveLength(5)
    }),
  )

  scenarioIt("forces one compaction and retries after provider context overflow", (scenario) =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery(scenario)
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Continue" }), resume: false })
      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        )

        const summary = yield* scenario.llm.next()
        expect(userTexts(summary.request)[0]).toContain("## Objective")
        yield* summary.respond.text("## Objective\n- Recover overflow", { id: "text-summary" })

        const recovered = yield* scenario.llm.next()
        expect(userTexts(recovered.request)[0]).toContain("<summary>\n## Objective\n- Recover overflow\n</summary>")
        yield* recovered.respond.text("Recovered", { id: "text-final" })
      })

      expect(yield* scenario.llm.requests).toHaveLength(4)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Objective\n- Recover overflow" },
        { type: "assistant", finish: "stop" },
      ])
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  scenarioIt("persists a second context overflow after one recovery", (scenario) =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery(scenario)
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Continue" }), resume: false })
      const overflow = () => [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ]
      expect(
        (yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.events(...overflow())
            yield* (yield* scenario.llm.next()).respond.text("## Objective\n- Recover once", {
              id: "text-summary",
            })
            yield* (yield* scenario.llm.next()).respond.events(...overflow())
          })
          .pipe(Effect.flip)).message,
      ).toBe("prompt too long")

      expect(yield* scenario.llm.requests).toHaveLength(4)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  scenarioIt("recovers once from a raw context overflow failure", (scenario) =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery(scenario)
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Continue" }), resume: false })
      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.fail(
          new LLMError({
            module: "test",
            method: "stream",
            reason: new InvalidRequestReason({
              message: "prompt too long",
              classification: "context-overflow",
            }),
          }),
        )
        yield* (yield* scenario.llm.next()).respond.text("## Objective\n- Recover raw overflow", {
          id: "text-summary",
        })
        yield* (yield* scenario.llm.next()).respond.text("Recovered", { id: "text-final" })
      })

      expect(yield* scenario.llm.requests).toHaveLength(4)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "compaction", summary: "## Objective\n- Recover raw overflow" },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  scenarioIt("publishes the original overflow when recovery summarization fails", (scenario) =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery(scenario)
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Continue" }), resume: false })
      expect(
        (yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.events(
              LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
            )
            yield* (yield* scenario.llm.next()).respond.events(
              LLMEvent.providerError({ message: "summary unavailable" }),
            )
          })
          .pipe(Effect.flip)).message,
      ).toBe("prompt too long")

      expect(yield* scenario.llm.requests).toHaveLength(3)
      const context = yield* session.context(sessionID)
      expect(context.some((message) => message.type === "compaction")).toBe(false)
      expect(context.slice(-2)).toMatchObject([
        { type: "user", text: "Continue" },
        { type: "assistant", finish: "error", error: { message: "prompt too long" } },
      ])
    }),
  )

  scenarioIt("interrupts overflow recovery while the summary provider is running", (scenario) =>
    Effect.gen(function* () {
      const session = yield* setupOverflowRecovery(scenario)
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Continue" }), resume: false })
      const exit = yield* scenario
        .run(function* () {
          yield* (yield* scenario.llm.next()).respond.events(
            LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
          )
          yield* (yield* scenario.llm.next()).respond.stream(Stream.never)
          yield* session.interrupt(sessionID)
        })
        .pipe(Effect.exit)

      expect(exit).toMatchObject({ _tag: "Failure" })
      expect(yield* scenario.llm.requests).toHaveLength(3)
      expect((yield* session.context(sessionID)).some((message) => message.type === "compaction")).toBe(false)
    }),
  )

  scenarioIt("rebaselines after compaction from the last-applied belief while unobservable", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events()
      })
      systemBaseline = "Changed context"
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Second" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events()
      })
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        reason: "manual",
        text: "summary",
        recent: "",
      })
      systemUnavailable = true
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Third" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        // The rebaseline proceeds while the source is unobservable, restating the model's belief.
        expect(call.request.system.map((part) => part.text)).toEqual([defaultSystem, "Changed context"])
        expect(systemTexts(call.request)).not.toContain("Changed context")
        yield* call.respond.events()
      })
    }),
  )

  scenarioIt("projects reasoning and tool events without executing or continuing tools", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Use tools" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.tools.map((tool) => tool.name)).toEqual(["echo", "defect", "storefail"])
        yield* call.respond.events(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-1" }),
          LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
          LLMEvent.reasoningEnd({ id: "reasoning-1" }),
          LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
          LLMEvent.toolInputDelta({ id: "call-error", name: "write", text: '{"path":"README.md"}' }),
          LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
          LLMEvent.toolCall({ id: "call-error", name: "write", input: { path: "README.md" }, providerExecuted: true }),
          LLMEvent.toolError({ id: "call-error", name: "write", message: "Denied" }),
          LLMEvent.toolResult({ id: "call-error", name: "write", result: { type: "error", value: "Denied" } }),
          LLMEvent.toolCall({
            id: "call-provider",
            name: "web_search",
            input: { query: "hello" },
            providerExecuted: true,
            providerMetadata: { fake: { source: "provider" } },
          }),
          LLMEvent.toolResult({
            id: "call-provider",
            name: "web_search",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Hello" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" },
              ],
            },
            providerExecuted: true,
            providerMetadata: { fake: { source: "provider" } },
          }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: {
              inputTokens: 10,
              nonCachedInputTokens: 8,
              outputTokens: 4,
              reasoningTokens: 1,
              cacheReadInputTokens: 2,
            },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        )
      })

      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Use tools" },
        {
          type: "assistant",
          finish: "tool-calls",
          cost: 0,
          tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
          content: [
            { type: "reasoning", text: "Think" },
            {
              type: "tool",
              id: "call-error",
              name: "write",
              state: {
                status: "error",
                input: { path: "README.md" },
                error: { type: "tool.execution", message: "Denied" },
              },
            },
            {
              type: "tool",
              id: "call-provider",
              name: "web_search",
              executed: true,
              providerState: { source: "provider" },
              providerResultState: { source: "provider" },
              state: {
                status: "completed",
                input: { query: "hello" },
                structured: {},
                content: [
                  { type: "text", text: "Hello" },
                  { type: "file", mime: "image/png", uri: "data:image/png;base64,aGVsbG8=", name: "hello.png" },
                ],
              },
            },
          ],
        },
      ])
    }),
  )

  scenarioIt("continues with reloaded history after durably settling one local tool call", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Echo this" }), resume: false })

      authorizations.length = 0
      executions.length = 0
      yield* scenario.run(function* () {
        const first = yield* scenario.llm.next()
        yield* first.respond.toolCall("echo", { text: "hello" }, { id: "call-echo" })

        const second = yield* scenario.llm.next()
        expect(second.request.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
        yield* second.respond.text("Done", { id: "text-final" })
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
      expect(authorizations).toMatchObject([{ sessionID, toolCallID: "call-echo" }])
      expect(executions).toEqual(["hello"])
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Echo this" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-echo",
              name: "echo",
              state: {
                status: "completed",
                input: { text: "hello" },
                structured: { text: "hello" },
                content: [{ type: "text", text: "hello" }],
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Done" }] },
      ])
      const assistant = requireAssistant(context)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.success.1",
        "session.step.ended.1",
      ])
    }),
  )

  scenarioIt("reloads a model switch before a tool-driven continuation turn", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Echo this" }), resume: false })

      const executionGate = yield* Deferred.make<void>()
      const executionsStarted = yield* Deferred.make<void>()
      toolExecutionGate = executionGate
      toolExecutionsStarted = executionsStarted
      toolExecutionsReady = 1
      yield* scenario.run(function* () {
        const first = yield* scenario.llm.next()
        yield* first.respond.toolCall("echo", { text: "hello" }, { id: "call-echo" })
        yield* Deferred.await(executionsStarted)
        yield* events.publish(SessionEvent.ModelSelected, {
          sessionID,
          model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("fake") },
        })
        systemBaseline = "Replacement context"
        yield* Deferred.succeed(executionGate, undefined)

        const second = yield* scenario.llm.next()
        expect(second.request.model).toBe(replacementModel)
        expect(second.request.system.map((part) => part.text)).toEqual([defaultSystem, "Initial context"])
        expect(systemTexts(second.request)).toContain("Replacement context")
        yield* second.respond.events(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      })

      const requests = yield* scenario.llm.requests
      expect(requests.map((request) => request.model)).toEqual([model, replacementModel])
      expect(requests.map((request) => request.system.map((part) => part.text))).toEqual([
        [defaultSystem, "Initial context"],
        [defaultSystem, "Initial context"],
      ])
      expect(systemTexts(requests[1]!)).toContain("Replacement context")
    }),
  )

  scenarioIt("restores durable reasoning provider metadata in a second-turn request", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Think first" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
          LLMEvent.reasoningDelta({ id: "reasoning-anthropic", text: "Signed thought" }),
          LLMEvent.reasoningEnd({
            id: "reasoning-anthropic",
            providerMetadata: { fake: { signature: "sig_1" }, anthropic: { ignored: true } },
          }),
          LLMEvent.reasoningStart({
            id: "reasoning-openai",
            providerMetadata: {
              fake: { itemId: "rs_1", reasoningEncryptedContent: null },
              openai: { ignored: true },
            },
          }),
          LLMEvent.reasoningDelta({ id: "reasoning-openai", text: "Encrypted thought" }),
          LLMEvent.reasoningEnd({
            id: "reasoning-openai",
            providerMetadata: {
              fake: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" },
              openai: { ignored: true },
            },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      })
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Think first" },
        {
          type: "assistant",
          content: [
            { type: "reasoning", text: "Signed thought", state: { signature: "sig_1" } },
            {
              type: "reasoning",
              text: "Encrypted thought",
              state: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" },
            },
          ],
        },
      ])

      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Continue" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.messages[1]?.content).toEqual([
          { type: "reasoning", text: "Signed thought", providerMetadata: { fake: { signature: "sig_1" } } },
          {
            type: "reasoning",
            text: "Encrypted thought",
            providerMetadata: { fake: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
          },
        ])
        yield* call.respond.events()
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
    }),
  )

  scenarioIt("replays durable provider-executed tool results inline in a second-turn request", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Search first" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "hosted-search",
            name: "web_search",
            input: { query: "Effect" },
            providerExecuted: true,
            providerMetadata: { fake: { itemId: "hosted-search" }, openai: { ignored: true } },
          }),
          LLMEvent.toolResult({
            id: "hosted-search",
            name: "web_search",
            result: { type: "json", value: [{ title: "Effect" }] },
            providerExecuted: true,
            providerMetadata: { fake: { blockType: "web_search_tool_result" }, anthropic: { ignored: true } },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      })
      yield* replaySessionProjection(sessionID)

      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Continue" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
        expect(call.request.messages[1]?.content).toMatchObject([
          {
            type: "tool-call",
            id: "hosted-search",
            name: "web_search",
            input: { query: "Effect" },
            providerExecuted: true,
            providerMetadata: { fake: { itemId: "hosted-search" } },
          },
          {
            type: "tool-result",
            id: "hosted-search",
            name: "web_search",
            result: { type: "json", value: [{ title: "Effect" }] },
            providerExecuted: true,
            providerMetadata: { fake: { blockType: "web_search_tool_result" } },
          },
        ])
        yield* call.respond.events()
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
    }),
  )

  scenarioIt("starts recorded local tools eagerly and awaits settlement before continuing", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Echo five times" }), resume: false })

      executions.length = 0
      const executionGate = yield* Deferred.make<void>()
      const executionsStarted = yield* Deferred.make<void>()
      toolExecutionGate = executionGate
      toolExecutionsStarted = executionsStarted
      const providerGate = yield* Deferred.make<void>()
      const initial = Stream.fromIterable([
        LLMEvent.stepStart({ index: 0 }),
        ...Array.from({ length: 5 }, (_, index) =>
          LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
        ),
      ])
      const final = Stream.fromIterable([
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ])

      yield* scenario.run(function* () {
        const first = yield* scenario.llm.next()
        yield* first.respond.stream(
          Stream.concat(initial, Stream.unwrap(Deferred.await(providerGate).pipe(Effect.as(final)))),
        )
        yield* Deferred.await(executionsStarted)

        expect(executions).toHaveLength(5)
        expect(maxActiveToolExecutions).toBe(5)
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "user", text: "Echo five times" },
          {
            type: "assistant",
            content: Array.from({ length: 5 }, (_, index) => ({
              type: "tool",
              id: `call-echo-${index}`,
              state: { status: "running", input: { text: `${index}` } },
            })),
          },
        ])

        yield* Deferred.succeed(providerGate, undefined)
        yield* Effect.yieldNow
        expect(yield* scenario.llm.requests).toHaveLength(1)

        yield* Deferred.succeed(executionGate, undefined)
        yield* (yield* scenario.llm.next()).respond.events()
      })
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(executions).toHaveLength(5)
      expect(maxActiveToolExecutions).toBe(5)
      expect(yield* scenario.llm.requests).toHaveLength(2)
    }),
  )

  scenarioIt("settles repeated provider-local tool call IDs against their owning assistant messages", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Echo twice" }), resume: false })

      executions.length = 0
      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.toolCall("echo", { text: "first" }, { id: "tool_0" })
        yield* (yield* scenario.llm.next()).respond.toolCall("echo", { text: "second" }, { id: "tool_0" })
        yield* (yield* scenario.llm.next()).respond.events()
      })

      expect(executions).toEqual(["first", "second"])
      expect(yield* scenario.llm.requests).toHaveLength(3)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Echo twice" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
            },
          ],
        },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "tool_0",
              state: {
                status: "completed",
                structured: { text: "second" },
                content: [{ type: "text", text: "second" }],
              },
            },
          ],
        },
      ])
    }),
  )

  scenarioIt("joins concurrent resume calls into one active provider run", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Run once" }), resume: false })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(yield* scenario.llm.requests).toHaveLength(1)
        yield* call.respond.text("Once", { id: "text-once" })
        yield* Fiber.join(second)
      })

      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Run once" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Once" }] },
      ])
    }),
  )

  scenarioIt("steers an active provider turn with newly recorded prompts", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Start working" }), resume: false })

      yield* scenario.run(function* () {
        const first = yield* scenario.llm.next()
        expect(userTexts(first.request)).toEqual(["Start working"])
        yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Change direction" }) })
        yield* first.respond.stop()

        const second = yield* scenario.llm.next()
        expect(userTexts(second.request)).toEqual(["Start working", "Change direction"])
        yield* second.respond.stop()
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
      expect((yield* session.context(sessionID)).map((message) => message.type)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ])
    }),
  )

  scenarioIt("promotes queued input after continuation ends", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Start working" }), resume: false })

      yield* scenario.run(function* () {
        const first = yield* scenario.llm.next()
        expect(userTexts(first.request)).toEqual(["Start working"])
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Wait until continuation ends" }),
          delivery: "queue",
        })
        yield* first.respond.toolCall("echo", { text: "hello" }, { id: "call-echo" })

        const second = yield* scenario.llm.next()
        expect(userTexts(second.request)).toEqual(["Start working"])
        yield* second.respond.stop()

        const third = yield* scenario.llm.next()
        expect(userTexts(third.request)).toEqual(["Start working", "Wait until continuation ends"])
        yield* third.respond.stop()
      })

      expect(yield* scenario.llm.requests).toHaveLength(3)
    }),
  )

  effectIt.effect("preserves durable queued input for a later wake after interruption", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<Exit.Exit<void, SessionRunner.RunError | SessionV2.NotFoundError>>()
      const retry = yield* Deferred.make<void>()
      const scenario = yield* RunnerScenario.make(() =>
        SessionV2.Service.use((session) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(interrupted, yield* session.resume(sessionID).pipe(Effect.exit))
            yield* Deferred.await(retry)
            yield* session.resume(sessionID)
          }),
        ),
      )
      yield* Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const { db } = yield* Database.Service
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Interrupt current work" }),
          resume: false,
        })

        yield* scenario.run(function* () {
          const first = yield* scenario.llm.next()
          expect(userTexts(first.request)).toEqual(["Interrupt current work"])
          yield* session.prompt({
            sessionID,
            prompt: PromptInput.Prompt.make({ text: "Run after interrupt" }),
            delivery: "queue",
          })
          yield* session.interrupt(sessionID)
          expect(yield* Deferred.await(interrupted)).toMatchObject({ _tag: "Failure" })
          expect(yield* SessionInput.hasPending(db, sessionID, "queue")).toBe(true)

          yield* Deferred.succeed(retry, undefined)
          const second = yield* scenario.llm.next()
          expect(userTexts(second.request)).toEqual(["Interrupt current work", "Run after interrupt"])
          yield* second.respond.stop()
        })

        expect(yield* scenario.llm.requests).toHaveLength(2)
      }).pipe(Effect.provide(testLayerWith(scenario.llm.layer)))
    }),
  )

  effectIt.effect("preserves durable steering input for a later resume after interruption", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<Exit.Exit<void, SessionRunner.RunError | SessionV2.NotFoundError>>()
      const retry = yield* Deferred.make<void>()
      const scenario = yield* RunnerScenario.make(() =>
        SessionV2.Service.use((session) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(interrupted, yield* session.resume(sessionID).pipe(Effect.exit))
            yield* Deferred.await(retry)
            yield* session.resume(sessionID)
          }),
        ),
      )
      yield* Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const { db } = yield* Database.Service
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Interrupt current work" }),
          resume: false,
        })

        yield* scenario.run(function* () {
          const first = yield* scenario.llm.next()
          expect(userTexts(first.request)).toEqual(["Interrupt current work"])
          yield* session.prompt({
            sessionID,
            prompt: PromptInput.Prompt.make({ text: "Steer after interrupt" }),
          })
          yield* session.interrupt(sessionID)
          expect(yield* Deferred.await(interrupted)).toMatchObject({ _tag: "Failure" })
          expect(yield* SessionInput.hasPending(db, sessionID, "steer")).toBe(true)

          yield* Deferred.succeed(retry, undefined)
          const second = yield* scenario.llm.next()
          expect(userTexts(second.request)).toEqual(["Interrupt current work", "Steer after interrupt"])
          yield* second.respond.stop()
        })

        expect(yield* scenario.llm.requests).toHaveLength(2)
      }).pipe(Effect.provide(testLayerWith(scenario.llm.layer)))
    }),
  )

  scenarioIt("promotes queued inputs one at a time in FIFO order", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Start working" }), resume: false })

      yield* scenario.run(function* () {
        const first = yield* scenario.llm.next()
        expect(userTexts(first.request)).toEqual(["Start working"])
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Queue first" }),
          delivery: "queue",
        })
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Queue second" }),
          delivery: "queue",
        })
        yield* first.respond.stop()

        const second = yield* scenario.llm.next()
        expect(userTexts(second.request)).toEqual(["Start working", "Queue first"])
        yield* second.respond.stop()

        const third = yield* scenario.llm.next()
        expect(userTexts(third.request)).toEqual(["Start working", "Queue first", "Queue second"])
        yield* third.respond.stop()
      })

      expect(yield* scenario.llm.requests).toHaveLength(3)
    }),
  )

  scenarioIt("promotes queued input after steering continuation ends", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Start steering" }), resume: false })
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Queue for later" }),
        delivery: "queue",
        resume: false,
      })

      yield* scenario.run(function* () {
        const first = yield* scenario.llm.next()
        expect(userTexts(first.request)).toEqual(["Start steering"])
        yield* first.respond.stop()

        const second = yield* scenario.llm.next()
        expect(userTexts(second.request)).toEqual(["Start steering", "Queue for later"])
        yield* second.respond.stop()
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
    }),
  )

  scenarioIt("promotes steers before the next queued input", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Start working" }), resume: false })

      yield* scenario.run(function* () {
        const first = yield* scenario.llm.next()
        expect(userTexts(first.request)).toEqual(["Start working"])
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Queue first" }),
          delivery: "queue",
        })
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Queue second" }),
          delivery: "queue",
        })
        yield* first.respond.stop()

        const second = yield* scenario.llm.next()
        expect(userTexts(second.request)).toEqual(["Start working", "Queue first"])
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Steer before next queued input" }),
        })
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Also steer before next queued input" }),
        })
        yield* second.respond.stop()

        const third = yield* scenario.llm.next()
        expect(userTexts(third.request)).toEqual([
          "Start working",
          "Queue first",
          "Steer before next queued input",
          "Also steer before next queued input",
        ])
        yield* third.respond.stop()

        const fourth = yield* scenario.llm.next()
        expect(userTexts(fourth.request)).toEqual([
          "Start working",
          "Queue first",
          "Steer before next queued input",
          "Also steer before next queued input",
          "Queue second",
        ])
        yield* fourth.respond.stop()
      })

      expect(yield* scenario.llm.requests).toHaveLength(4)
    }),
  )

  scenarioIt("coalesces multiple active steering prompts into one continuation turn", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Start working" }), resume: false })

      yield* scenario.run(function* () {
        const first = yield* scenario.llm.next()
        yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "First steer" }) })
        yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Second steer" }) })
        yield* first.respond.stop()

        const second = yield* scenario.llm.next()
        expect(userTexts(second.request)).toEqual(["Start working", "First steer", "Second steer"])
        yield* second.respond.stop()
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
      yield* (yield* SessionExecution.Service).wake(sessionID)
      yield* session.wait(sessionID)
      expect(yield* scenario.llm.requests).toHaveLength(2)
    }),
  )

  effectIt.effect("runs steering input accepted while the active provider turn fails", () =>
    Effect.gen(function* () {
      const failed = yield* Deferred.make<Exit.Exit<void, SessionRunner.RunError | SessionV2.NotFoundError>>()
      const scenario = yield* RunnerScenario.make(() =>
        SessionV2.Service.use((session) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(failed, yield* session.resume(sessionID).pipe(Effect.exit))
            yield* session.wait(sessionID)
          }),
        ),
      )
      yield* Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Start working" }), resume: false })
        const failure = invalidRequest()

        yield* scenario.run(function* () {
          const first = yield* scenario.llm.next()
          yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Recover with this" }) })
          yield* first.respond.fail(failure)
          const exit = yield* Deferred.await(failed)
          expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)

          const second = yield* scenario.llm.next()
          expect(userTexts(second.request)).toEqual(["Start working", "Recover with this"])
          yield* second.respond.stop()
        })

        expect(yield* scenario.llm.requests).toHaveLength(2)
      }).pipe(Effect.provide(testLayerWith(scenario.llm.layer)))
    }),
  )

  scenarioIt("durably fails local tools left running by a prior process before continuing", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Recover interrupted tool" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        callID: "call-interrupted",
        name: "echo",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID,
        callID: "call-interrupted",
        text: '{"text":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        callID: "call-interrupted",
        input: { text: "stale" },
        executed: false,
      })
      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
        yield* call.respond.events()
      })

      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-interrupted",
              state: {
                status: "error",
                error: { type: "tool.stale", message: "Tool execution interrupted: echo" },
              },
            },
          ],
        },
      ])
    }),
  )

  scenarioIt("durably fails hosted tools left running by a prior process before continuing inline", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Recover interrupted hosted tool" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        name: "web_search",
      })
      yield* events.publish(SessionEvent.Tool.Input.Ended, {
        sessionID,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        text: '{"query":"stale"}',
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        callID: "call-hosted-interrupted",
        input: { query: "stale" },
        executed: true,
        state: { itemId: "call-hosted-interrupted" },
      })
      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.messages.map((message) => message.role)).toEqual(["user", "assistant"])
        expect(call.request.messages[1]?.content).toMatchObject([
          {
            type: "tool-call",
            id: "call-hosted-interrupted",
            providerExecuted: true,
            providerMetadata: { fake: { itemId: "call-hosted-interrupted" } },
          },
          { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
        ])
        yield* call.respond.events()
      })

      expect(yield* scenario.llm.requests).toHaveLength(1)
    }),
  )

  scenarioIt("durably fails pending tool input left by a prior process before continuing", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Recover interrupted tool input" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers((yield* Database.Service).db, events, sessionID)
      const assistantMessageID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        agent: "build",
        model: { id: ModelV2.ID.make("fake-model"), providerID: ProviderV2.ID.make("fake") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        callID: "call-pending-interrupted",
        name: "echo",
      })
      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
        yield* call.respond.events()
      })

      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Recover interrupted tool input" },
        { type: "assistant", content: [{ type: "tool", id: "call-pending-interrupted", state: { status: "error" } }] },
      ])
    }),
  )

  effectIt.effect("promotes the first queued input when woken while idle", () =>
    Effect.gen(function* () {
      const scenario = yield* RunnerScenario.make(() =>
        Effect.gen(function* () {
          const execution = yield* SessionExecution.Service
          yield* execution.wake(sessionID)
          yield* execution.awaitIdle(sessionID)
        }),
      )
      yield* Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Wait in queue" }),
          delivery: "queue",
          resume: false,
        })

        yield* scenario.run(function* () {
          const call = yield* scenario.llm.next()
          expect(userTexts(call.request)).toEqual(["Wait in queue"])
          yield* call.respond.events()
        })

        expect(yield* scenario.llm.requests).toHaveLength(1)
      }).pipe(Effect.provide(testLayerWith(scenario.llm.layer)))
    }),
  )

  effectIt.effect("retries inbox input after prompt projection rolls back", () =>
    Effect.gen(function* () {
      const defect = new Error("fail after prompt promotion")
      let fail = true
      const rolledBack = yield* Deferred.make<unknown>()
      const retry = yield* Deferred.make<void>()
      const scenario = yield* RunnerScenario.make(() =>
        Effect.gen(function* () {
          const session = yield* SessionV2.Service
          yield* Deferred.succeed(rolledBack, yield* session.resume(sessionID).pipe(Effect.catchDefect(Effect.succeed)))
          yield* Deferred.await(retry)
          const execution = yield* SessionExecution.Service
          yield* execution.wake(sessionID)
          yield* execution.awaitIdle(sessionID)
        }),
      )
      yield* Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        yield* events.project(SessionEvent.PromptPromoted, () => (fail ? Effect.die(defect) : Effect.void))
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Recover promoted input" }),
          resume: false,
        })

        yield* scenario.run(function* () {
          expect(yield* Deferred.await(rolledBack)).toBe(defect)
          fail = false
          yield* Deferred.succeed(retry, undefined)
          const call = yield* scenario.llm.next()
          expect(userTexts(call.request)).toEqual(["Recover promoted input"])
          yield* call.respond.stop()
        })
      }).pipe(Effect.provide(testLayerWith(scenario.llm.layer)))
    }),
  )

  scenarioIt("does not strand a committed promotion when a post-commit listener defects", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      yield* events.listen((event) =>
        event.type === SessionEvent.PromptPromoted.type
          ? Effect.die("fail after prompt promotion commits")
          : Effect.void,
      )
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Run committed promotion" }),
        resume: false,
      })

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(userTexts(call.request)).toEqual(["Run committed promotion"])
        yield* call.respond.events()
      })

      expect(yield* scenario.llm.requests).toHaveLength(1)
    }),
  )

  effectIt.effect("runs different sessions concurrently", () =>
    Effect.gen(function* () {
      const scenario = yield* RunnerScenario.make(() =>
        SessionV2.Service.use((session) =>
          Effect.all([session.resume(sessionID), session.resume(otherSessionID)], {
            concurrency: "unbounded",
            discard: true,
          }),
        ),
      )
      yield* Effect.gen(function* () {
        yield* setup
        yield* insertSession(otherSessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Run first" }), resume: false })
        yield* session.prompt({
          sessionID: otherSessionID,
          prompt: PromptInput.Prompt.make({ text: "Run second" }),
          resume: false,
        })

        yield* scenario.run(function* () {
          const first = yield* scenario.llm.next()
          const second = yield* scenario.llm.next()
          expect(
            [first, second].map((call) => call.request.providerOptions?.openai?.promptCacheKey).toSorted(),
          ).toEqual([sessionID, otherSessionID].toSorted())
          yield* first.respond.events()
          yield* second.respond.events()
        })

        expect(yield* scenario.llm.requests).toHaveLength(2)
      }).pipe(Effect.provide(testLayerWith(scenario.llm.layer)))
    }),
  )

  effectIt.effect("bounds 64-character session prompt cache keys", () =>
    Effect.gen(function* () {
      const longSessionID = SessionV2.ID.make(`ses_${"a".repeat(64)}`)
      const otherLongSessionID = SessionV2.ID.make(`ses_${"b".repeat(64)}`)
      const scenario = yield* RunnerScenario.make(() =>
        SessionV2.Service.use((session) =>
          session.resume(longSessionID).pipe(Effect.andThen(session.resume(otherLongSessionID))),
        ),
      )
      yield* Effect.gen(function* () {
        yield* setup
        yield* insertSession(longSessionID)
        yield* insertSession(otherLongSessionID)
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: longSessionID,
          prompt: PromptInput.Prompt.make({ text: "Run long session" }),
          resume: false,
        })
        yield* session.prompt({
          sessionID: otherLongSessionID,
          prompt: PromptInput.Prompt.make({ text: "Run other long session" }),
          resume: false,
        })

        yield* scenario.run(function* () {
          yield* (yield* scenario.llm.next()).respond.events()
          yield* (yield* scenario.llm.next()).respond.events()
        })

        const keys = (yield* scenario.llm.requests).map((request) => request.providerOptions?.openai?.promptCacheKey)
        expect(keys).toEqual([longSessionID.slice(4), otherLongSessionID.slice(4)])
        expect(keys.every((key) => typeof key === "string" && key.length === 64)).toBe(true)
        expect(keys[0]).not.toBe(keys[1])
      }).pipe(Effect.provide(testLayerWith(scenario.llm.layer)))
    }),
  )

  effectIt.effect("fans out one failed run and allows a later retry", () =>
    Effect.gen(function* () {
      const join = yield* Deferred.make<void>()
      const joined =
        yield* Deferred.make<
          readonly [
            Exit.Exit<void, SessionRunner.RunError | SessionV2.NotFoundError>,
            Exit.Exit<void, SessionRunner.RunError | SessionV2.NotFoundError>,
          ]
        >()
      const scenario = yield* RunnerScenario.make(() =>
        SessionV2.Service.use((session) =>
          Effect.gen(function* () {
            const first = yield* session.resume(sessionID).pipe(Effect.forkChild)
            yield* Deferred.await(join)
            const second = yield* session.resume(sessionID).pipe(Effect.forkChild)
            yield* Deferred.succeed(joined, yield* Effect.all([Fiber.await(first), Fiber.await(second)]))
          }),
        ),
      )
      yield* Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Retry after failure" }),
          resume: false,
        })
        const failure = invalidRequest()

        yield* scenario.run(function* () {
          const first = yield* scenario.llm.next()
          yield* Deferred.succeed(join, undefined)
          yield* Effect.yieldNow
          expect(yield* scenario.llm.requests).toHaveLength(1)
          yield* first.respond.fail(failure)
          const [firstExit, secondExit] = yield* Deferred.await(joined)
          expect(secondExit).toEqual(firstExit)
        })

        yield* scenario.run(function* () {
          yield* (yield* scenario.llm.next()).respond.events()
        })

        expect(yield* scenario.llm.requests).toHaveLength(2)
      }).pipe(Effect.provide(testLayerWith(scenario.llm.layer)))
    }),
  )

  scenarioIt("durably rejects tools unavailable for the request", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Call missing" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.toolCall("missing", {}, { id: "call-missing" })
      })

      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call missing" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-missing",
              state: { status: "error", error: { message: "Tool is not available for this request: missing" } },
            },
          ],
        },
      ])
    }),
  )

  scenarioIt("returns unexpected local tool defects to the model and continues", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Call defect" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.toolCall("defect", {}, { id: "call-defect" })
        const second = yield* scenario.llm.next()
        expect(second.request.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
        yield* second.respond.text("Recovered", { id: "text-after-defect" })
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Call defect" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-defect",
              state: {
                status: "error",
                error: { type: "unknown", message: "unexpected tool defect" },
              },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
      const assistant = requireAssistant(context)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.ended.1",
      ])
    }),
  )

  scenarioIt("returns policy-blocked tools to the model and continues", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        blocked: Tool.make({
          description: "Fail because policy blocked execution",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.BlockedError({ rules: [], permission: "blocked", resources: ["*"] })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Permission blocked" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Call blocked" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.toolCall("blocked", {}, { id: "call-blocked" })
        yield* (yield* scenario.llm.next()).respond.stop()
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call blocked" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-blocked", state: { status: "error", error: { message: "Permission blocked" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  scenarioIt("interrupts runner continuation when permission approval is declined", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        declined: Tool.make({
          description: "Fail because the user declined approval",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die(new PermissionV2.DeclinedError()),
        }),
      })
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Call declined" }), resume: false })

      const exit = yield* scenario
        .run(function* () {
          yield* (yield* scenario.llm.next()).respond.toolCall("declined", {}, { id: "call-declined" })
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call declined" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-declined",
              state: { status: "error", error: { message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  scenarioIt("returns permission corrections to the model and continues", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        corrected: Tool.make({
          description: "Fail with user correction feedback",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            Effect.fail(new PermissionV2.CorrectedError({ feedback: "Use another tool" })).pipe(
              Effect.mapError(() => new Tool.Failure({ message: "Use another tool" })),
            ),
        }),
      })
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Call corrected" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.toolCall("corrected", {}, { id: "call-corrected" })
        yield* (yield* scenario.llm.next()).respond.stop()
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call corrected" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-corrected", state: { status: "error", error: { message: "Use another tool" } } },
          ],
        },
        { type: "assistant", finish: "stop" },
      ])
    }),
  )

  scenarioIt("fails the drain when tool output persistence fails", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Call storefail" }), resume: false })

      const exit = yield* scenario
        .run(function* () {
          yield* (yield* scenario.llm.next()).respond.toolCall("storefail", {}, { id: "call-storefail" })
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call storefail" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-storefail",
              state: {
                status: "error",
                error: {
                  type: "unknown",
                  message: expect.stringContaining("Failed to encode tool output"),
                },
              },
            },
          ],
          finish: "error",
          error: { type: "unknown", message: expect.stringContaining("Failed to encode tool output") },
        },
      ])
    }),
  )

  scenarioIt("preserves permission rejection and stops before continuation", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        permissionfail: Tool.make({
          description: "Reject a permission",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () =>
            new ToolFailure({
              message: "Permission denied: edit",
              error: new PermissionV2.BlockedError({
                rules: [],
                permission: "edit",
                resources: ["src/index.ts"],
              }),
            }),
        }),
      })
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Reject permission" }),
        resume: false,
      })
      const exit = yield* scenario
        .run(function* () {
          yield* (yield* scenario.llm.next()).respond.toolCall("permissionfail", {}, { id: "call-permission" })
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "error",
          error: {
            type: "permission.rejected",
            message: "Permission denied: edit",
          },
          content: [
            {
              type: "tool",
              id: "call-permission",
              state: {
                status: "error",
                error: {
                  type: "permission.rejected",
                  message: "Permission denied: edit",
                },
              },
            },
          ],
        },
      ])
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.step.ended.1")
    }),
  )

  scenarioIt("interrupts runner continuation when a question is cancelled", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      const registry = yield* ToolRegistry.Service
      yield* registry.register({
        question: Tool.make({
          description: "Ask the user",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die(new QuestionTool.CancelledError()),
        }),
      })
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Ask then stop" }), resume: false })

      const exit = yield* scenario
        .run(function* () {
          yield* (yield* scenario.llm.next()).respond.toolCall("question", {}, { id: "call-question" })
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Ask then stop" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-question",
              state: { status: "error", error: { type: "aborted", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
    }),
  )

  scenarioIt("awaits started local tools before surfacing provider stream failure", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Settle before failing" }),
        resume: false,
      })
      const failure = providerUnavailable()
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const executionGate = toolExecutionGate
      const executionsStarted = toolExecutionsStarted

      expect(
        yield* scenario
          .run(function* () {
            const call = yield* scenario.llm.next()
            yield* call.respond.stream(
              Stream.concat(
                Stream.fromIterable([
                  LLMEvent.stepStart({ index: 0 }),
                  LLMEvent.toolCall({ id: "call-before-failure", name: "echo", input: { text: "settle" } }),
                ]),
                Stream.fail(failure),
              ),
            )
            yield* Deferred.await(executionsStarted)
            yield* Deferred.succeed(executionGate, undefined)
          })
          .pipe(Effect.flip),
      ).toBe(failure)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Settle before failing" },
        {
          type: "assistant",
          content: [
            { type: "tool", id: "call-before-failure", state: { status: "completed", structured: { text: "settle" } } },
          ],
        },
      ])
      const assistant = requireAssistant(context)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.success.1",
        "session.step.failed.1",
      ])
    }),
  )

  scenarioIt("durably fails blocked local tools when a provider turn is interrupted", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Interrupt blocked tool" }),
        resume: false,
      })
      executions.length = 0
      toolExecutionGate = yield* Deferred.make<void>()
      toolExecutionsStarted = yield* Deferred.make<void>()
      toolExecutionsReady = 1
      const executionsStarted = toolExecutionsStarted

      const exit = yield* scenario
        .run(function* () {
          const call = yield* scenario.llm.next()
          yield* call.respond.stream(
            Stream.concat(
              Stream.fromIterable([
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.toolCall({ id: "call-before-interrupt", name: "echo", input: { text: "blocked" } }),
              ]),
              Stream.never,
            ),
          )
          yield* Deferred.await(executionsStarted)
          yield* session.interrupt(sessionID)
        })
        .pipe(Effect.exit)
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(exit).toMatchObject({ _tag: "Failure" })
      yield* session.interrupt(sessionID)
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        {
          type: "assistant",
          content: [
            {
              type: "tool",
              id: "call-before-interrupt",
              state: { status: "error", error: { type: "aborted", message: "Tool execution interrupted" } },
            },
          ],
        },
      ])
      const assistant = requireAssistant(context)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.failed.1",
      ])

      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt blocked tool" },
        { type: "assistant", content: [{ type: "tool", id: "call-before-interrupt", state: { status: "error" } }] },
      ])

      yield* scenario.run(function* () {
        const call = yield* scenario.llm.next()
        expect(call.request.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
        yield* call.respond.events()
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
    }),
  )

  scenarioIt("interrupts a blocked provider turn without local tool execution", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Interrupt provider" }),
        resume: false,
      })

      const exit = yield* scenario
        .run(function* () {
          yield* (yield* scenario.llm.next()).respond.stream(Stream.never)
          yield* session.interrupt(sessionID)
        })
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBeTrue()
      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Interrupt provider" },
        { type: "assistant", finish: "error", error: { type: "aborted", message: "Step interrupted" } },
      ])
      expect(yield* recordedEventTypes(sessionID)).toContain("session.step.failed.1")
      yield* session.interrupt(sessionID)
    }),
  )

  effectIt.effect("durably fails blocked local tools when interrupted while awaiting settlement", () =>
    Effect.gen(function* () {
      const scenario = yield* RunnerScenario.make(() =>
        SessionRunner.Service.use((runner) => runner.drain({ sessionID, force: true })),
      )
      yield* Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID,
          prompt: PromptInput.Prompt.make({ text: "Interrupt tool settlement" }),
          resume: false,
        })
        executions.length = 0
        const executionGate = yield* Deferred.make<void>()
        const executionsStarted = yield* Deferred.make<void>()
        toolExecutionGate = executionGate
        toolExecutionsStarted = executionsStarted
        toolExecutionsReady = 1

        const run = yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.toolCall(
              "echo",
              { text: "blocked" },
              { id: "call-await-interrupt" },
            )
            yield* Effect.never
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(executionsStarted)
        yield* Fiber.interrupt(run)
        toolExecutionGate = undefined
        toolExecutionsStarted = undefined

        expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "user", text: "Interrupt tool settlement" },
          {
            type: "assistant",
            finish: "error",
            error: { type: "aborted", message: "Step interrupted" },
            content: [
              {
                type: "tool",
                id: "call-await-interrupt",
                state: { status: "error", error: { type: "aborted", message: "Tool execution interrupted" } },
              },
            ],
          },
        ])
        const eventTypes = yield* recordedEventTypes(sessionID)
        expect(eventTypes).toContain("session.step.failed.1")
        expect(eventTypes).not.toContain("session.step.ended.1")
      }).pipe(Effect.provide(testLayerWith(scenario.llm.layer)))
    }),
  )

  scenarioIt("forces a text response on an agent's configured final step", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Finish at the limit" }),
        resume: false,
      })

      executions.length = 0
      yield* scenario.run(function* () {
        const first = yield* scenario.llm.next()
        expect(first.request.toolChoice).toBeUndefined()
        yield* first.respond.toolCall("echo", { text: "done" }, { id: "call-terminal" })

        const second = yield* scenario.llm.next()
        expect(second.request.toolChoice).toMatchObject({ type: "none" })
        expect(second.request.tools).toEqual([])
        expect(second.request.messages.at(-1)).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
        })
        yield* second.respond.toolCall("echo", { text: "forbidden" }, { id: "call-forbidden" })
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
      expect(executions).toEqual(["done"])
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Finish at the limit" },
        { type: "assistant", content: [{ type: "tool", id: "call-terminal", state: { status: "completed" } }] },
        { type: "assistant", content: [{ type: "tool", id: "call-forbidden", state: { status: "error" } }] },
      ])
    }),
  )

  scenarioIt("resets the configured step allowance when steering input promotes", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Start work" }), resume: false })

      executions.length = 0
      yield* scenario.run(function* () {
        const first = yield* scenario.llm.next()
        yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Change direction" }) })
        yield* first.respond.toolCall("echo", { text: "before" }, { id: "call-before-steer" })

        const second = yield* scenario.llm.next()
        expect(second.request.toolChoice).toBeUndefined()
        expect(second.request.tools).not.toEqual([])
        yield* second.respond.toolCall("echo", { text: "after" }, { id: "call-after-steer" })

        const third = yield* scenario.llm.next()
        expect(third.request.toolChoice).toMatchObject({ type: "none" })
        yield* third.respond.stop()
      })

      expect(yield* scenario.llm.requests).toHaveLength(3)
      expect(executions).toEqual(["before", "after"])
    }),
  )

  scenarioIt("projects provider errors as terminal assistant step failures", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Fail durably" }), resume: false })

      expect(
        (yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.events(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.providerError({ message: "Provider unavailable" }),
            )
          })
          .pipe(Effect.flip)).message,
      ).toBe("Provider unavailable")

      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail durably" },
        { type: "assistant", finish: "error", error: { type: "provider.unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  scenarioIt("projects provider errors emitted before assistant step start", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Fail before step" }), resume: false })

      expect(
        (yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.events(
              LLMEvent.providerError({ message: "Provider unavailable" }),
            )
          })
          .pipe(Effect.flip)).message,
      ).toBe("Provider unavailable")

      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail before step" },
        { type: "assistant", finish: "error", error: { type: "provider.unknown", message: "Provider unavailable" } },
      ])
    }),
  )

  scenarioIt("projects content-filter finishes as visible terminal failures", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Blocked response" }), resume: false })
      expect(
        (
          yield* scenario
            .run(function* () {
              yield* (yield* scenario.llm.next()).respond.events(
                LLMEvent.stepStart({ index: 0 }),
                LLMEvent.textStart({ id: "partial" }),
                LLMEvent.textDelta({ id: "partial", text: "Partial" }),
                LLMEvent.stepFinish({
                  index: 0,
                  reason: "content-filter",
                  usage: { nonCachedInputTokens: 8, outputTokens: 3, reasoningTokens: 1 },
                }),
                LLMEvent.finish({ reason: "content-filter" }),
              )
            })
            .pipe(Effect.flip)
        ).message,
      ).toBe("Provider blocked the response")
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "provider.content-filter" },
          cost: 0,
          tokens: { input: 8, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
      expect(yield* session.get(sessionID)).toMatchObject({
        cost: 0,
        tokens: { input: 8, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
      })
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.step.ended.1")
    }),
  )

  scenarioIt("settles a local tool before one content-filter step failure", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Tool before blocked response" }),
        resume: false,
      })
      const gate = (toolExecutionGate = yield* Deferred.make<void>())
      const started = (toolExecutionsStarted = yield* Deferred.make<void>())
      toolExecutionsReady = 1
      expect(
        (yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.events(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolCall({ id: "call-before-content-filter", name: "echo", input: { text: "settled" } }),
              LLMEvent.stepFinish({ index: 0, reason: "content-filter" }),
              LLMEvent.finish({ reason: "content-filter" }),
            )
            yield* Deferred.await(started)
            yield* Deferred.succeed(gate, undefined)
          })
          .pipe(Effect.flip)).message,
      ).toBe("Provider blocked the response")
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      const assistant = requireAssistant(yield* session.context(sessionID))
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.success.1",
        "session.step.failed.1",
      ])
      expect(
        events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
      ).toHaveLength(1)
    }),
  )

  scenarioIt("does not recover context overflow after durable assistant output", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Fail after output" }),
        resume: false,
      })

      expect(
        (yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.events(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.textStart({ id: "text-partial" }),
              LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
              LLMEvent.textEnd({ id: "text-partial" }),
              LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
            )
          })
          .pipe(Effect.flip)).message,
      ).toBe("prompt too long")

      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail after output" },
        {
          type: "assistant",
          finish: "error",
          error: { message: "prompt too long" },
          content: [{ type: "text", text: "Partial" }],
        },
      ])
    }),
  )

  scenarioIt("projects raw provider stream failures as terminal assistant step failures", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Fail raw stream durably" }),
        resume: false,
      })
      const failure = invalidRequest()

      expect(
        yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.fail(failure)
          })
          .pipe(Effect.flip),
      ).toBe(failure)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail raw stream durably" },
        { type: "assistant", finish: "error", error: { type: "provider.invalid-request", message: "Invalid request" } },
      ])
    }),
  )

  scenarioIt("retries eligible pre-output failures after exponential backoff", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Retry transport" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.fail(providerUnavailable())
        yield* TestClock.adjust("1999 millis")
        expect(yield* scenario.llm.requests).toHaveLength(1)
        yield* TestClock.adjust("1 millis")
        yield* (yield* scenario.llm.next()).respond.events(
          ...fragmentFixture("text", "retry-success", ["Recovered"]).completeEvents,
        )
      })

      expect(yield* scenario.llm.requests).toHaveLength(2)
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes).toContain("session.retry.scheduled.1")
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(2)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user" },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
      ])
      yield* replaySessionProjection(sessionID)
      expect((yield* session.context(sessionID)).filter((message) => message.type === "assistant")).toHaveLength(1)
    }),
  )

  scenarioIt("uses a larger provider retry-after delay", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Retry rate limit" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.fail(rateLimited(5_000))
        yield* TestClock.adjust("4999 millis")
        expect(yield* scenario.llm.requests).toHaveLength(1)
        yield* TestClock.adjust("1 millis")
        yield* (yield* scenario.llm.next()).respond.events(
          ...fragmentFixture("text", "retry-after-success", ["Recovered"]).completeEvents,
        )
      })
      expect(yield* scenario.llm.requests).toHaveLength(2)
    }),
  )

  scenarioIt("stops after five total retry attempts", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Exhaust retries" }), resume: false })
      const failure = providerUnavailable()

      expect(
        yield* scenario
          .run(function* () {
            for (const delay of [2_000, 4_000, 8_000, 16_000]) {
              yield* (yield* scenario.llm.next()).respond.fail(failure)
              yield* TestClock.adjust(delay)
            }
            yield* (yield* scenario.llm.next()).respond.fail(failure)
          })
          .pipe(Effect.flip),
      ).toBe(failure)
      expect(yield* scenario.llm.requests).toHaveLength(5)

      const database = (yield* Database.Service).db
      const retries = yield* database
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, "session.retry.scheduled.1"))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(retries.map((event) => event.data)).toMatchObject([
        { attempt: 2, at: 2_000 },
        { attempt: 3, at: 6_000 },
        { attempt: 4, at: 14_000 },
        { attempt: 5, at: 30_000 },
      ])
      expect((yield* recordedEventTypes(sessionID)).filter((type) => type === "session.step.started.1")).toHaveLength(5)
      expect((yield* session.context(sessionID)).filter((message) => message.type === "assistant")).toHaveLength(1)
    }),
  )

  scenarioIt("counts retry attempts against the agent step allowance", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.steps = 2
        }),
      )
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Bound retries by steps" }),
        resume: false,
      })
      const failure = providerUnavailable()

      expect(
        yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.fail(failure)
            yield* TestClock.adjust("2 seconds")
            yield* (yield* scenario.llm.next()).respond.fail(failure)
          })
          .pipe(Effect.flip),
      ).toBe(failure)

      expect(yield* scenario.llm.requests).toHaveLength(2)
      const eventTypes = yield* recordedEventTypes(sessionID)
      expect(eventTypes.filter((type) => type === "session.step.started.1")).toHaveLength(2)
      expect(eventTypes.filter((type) => type === "session.retry.scheduled.1")).toHaveLength(1)
      expect((yield* session.context(sessionID)).filter((message) => message.type === "assistant")).toHaveLength(1)
    }),
  )

  scenarioIt("does not retry non-eligible provider failures", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Do not retry" }), resume: false })
      const failure = invalidRequest()

      expect(
        yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.fail(failure)
          })
          .pipe(Effect.flip),
      ).toBe(failure)
      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(yield* recordedEventTypes(sessionID)).not.toContain("session.retry.scheduled.1")
    }),
  )

  scenarioIt("does not continue automatically after a provider error follows a local tool call", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Do not continue failed provider" }),
        resume: false,
      })

      const executionCount = executions.length
      const gate = (toolExecutionGate = yield* Deferred.make<void>())
      const started = (toolExecutionsStarted = yield* Deferred.make<void>())
      toolExecutionsReady = 1
      expect(
        (yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.events(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolCall({ id: "call-before-provider-error", name: "echo", input: { text: "settled" } }),
              LLMEvent.providerError({ message: "Provider unavailable" }),
            )
            yield* Deferred.await(started)
            yield* Deferred.succeed(gate, undefined)
          })
          .pipe(Effect.flip)).message,
      ).toBe("Provider unavailable")
      toolExecutionGate = undefined
      toolExecutionsStarted = undefined

      expect(yield* scenario.llm.requests).toHaveLength(1)
      expect(executions.slice(executionCount)).toEqual(["settled"])
      const context = yield* session.context(sessionID)
      const assistant = requireAssistant(context)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.success.1",
        "session.step.failed.1",
      ])
    }),
  )

  scenarioIt("durably fails a hosted tool when its provider errors before returning a result", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Fail hosted tool durably" }),
        resume: false,
      })

      expect(
        (yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.events(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolCall({
                id: "call-hosted-provider-error",
                name: "web_search",
                input: { query: "effect" },
                providerExecuted: true,
              }),
              LLMEvent.providerError({ message: "Provider unavailable" }),
            )
          })
          .pipe(Effect.flip)).message,
      ).toBe("Provider unavailable")

      expect(yield* scenario.llm.requests).toHaveLength(1)
      const context = yield* session.context(sessionID)
      expect(context).toMatchObject([
        { type: "user", text: "Fail hosted tool durably" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-hosted-provider-error", state: { status: "error" } }],
        },
      ])
      const assistant = requireAssistant(context)
      expect((yield* recordedStepSettlementEvents(sessionID, assistant.id)).map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.failed.1",
      ])
    }),
  )

  scenarioIt("preserves a tool defect before provider failure settlement", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Defect while provider fails" }),
        resume: false,
      })

      expect(
        (yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.events(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolCall({ id: "call-defect-provider-error", name: "defect", input: {} }),
              LLMEvent.providerError({ message: "Provider unavailable" }),
            )
          })
          .pipe(Effect.flip)).message,
      ).toBe("Provider unavailable")

      const context = yield* session.context(sessionID)
      const assistant = requireAssistant(context)
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.failed.1",
      ])
      expect(events[2]?.data.error).toMatchObject({ type: "unknown", message: "unexpected tool defect" })
    }),
  )

  scenarioIt("durably fails a hosted tool left unresolved at normal provider EOF", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Fail hosted tool at EOF" }),
        resume: false,
      })

      expect(
        (yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.events(
              LLMEvent.stepStart({ index: 0 }),
              LLMEvent.toolCall({
                id: "call-hosted-eof",
                name: "web_search",
                input: { query: "effect" },
                providerExecuted: true,
              }),
            )
          })
          .pipe(Effect.flip)).message,
      ).toBe("Provider did not return a tool result")
      const assistant = requireAssistant(yield* session.context(sessionID))
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.failed.1",
      ])
      expect(
        events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool at EOF" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "tool.result-missing" },
          content: [{ type: "tool", id: "call-hosted-eof", state: { status: "error" } }],
        },
      ])
    }),
  )

  scenarioIt("fails an unresolved hosted tool before one clean step end", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Settle hosted tool before ending" }),
        resume: false,
      })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "call-hosted-clean-end",
            name: "web_search",
            input: { query: "effect" },
            providerExecuted: true,
          }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      })

      const assistant = requireAssistant(yield* session.context(sessionID))
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.ended.1",
      ])
      expect(
        events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
      ).toHaveLength(1)
    }),
  )

  scenarioIt("settles unresolved local and hosted tools before one raw provider failure", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Fail unresolved tools" }),
        resume: false,
      })
      const failure = invalidRequest()
      const providerFailed = yield* Deferred.make<void>()
      const gate = (toolExecutionGate = yield* Deferred.make<void>())

      expect(
        yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.stream(
              Stream.concat(
                Stream.fromIterable([
                  LLMEvent.stepStart({ index: 0 }),
                  LLMEvent.toolCall({ id: "call-local-raw-failure", name: "defect", input: {} }),
                  LLMEvent.toolCall({
                    id: "call-hosted-raw-failure-pair",
                    name: "web_search",
                    input: { query: "effect" },
                    providerExecuted: true,
                  }),
                ]),
                Stream.fromEffect(Deferred.succeed(providerFailed, undefined)).pipe(
                  Stream.flatMap(() => Stream.fail(failure)),
                ),
              ),
            )
            yield* Deferred.await(providerFailed)
            yield* Deferred.succeed(gate, undefined)
          })
          .pipe(Effect.flip),
      ).toBe(failure)
      toolExecutionGate = undefined

      const assistant = requireAssistant(yield* session.context(sessionID))
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.map((event) => ({ type: event.type, callID: event.data.callID }))).toEqual([
        { type: "session.step.started.1", callID: undefined },
        { type: "session.tool.called.1", callID: "call-local-raw-failure" },
        { type: "session.tool.called.1", callID: "call-hosted-raw-failure-pair" },
        { type: "session.tool.failed.1", callID: "call-local-raw-failure" },
        { type: "session.tool.failed.1", callID: "call-hosted-raw-failure-pair" },
        { type: "session.step.failed.1", callID: undefined },
      ])
      expect(
        events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
      ).toHaveLength(1)
    }),
  )

  scenarioIt("durably fails a hosted tool left unresolved by a raw provider stream failure", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Fail hosted tool on raw failure" }),
        resume: false,
      })
      const failure = providerUnavailable()

      expect(
        yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.stream(
              Stream.concat(
                Stream.fromIterable([
                  LLMEvent.stepStart({ index: 0 }),
                  LLMEvent.toolCall({
                    id: "call-hosted-raw-failure",
                    name: "web_search",
                    input: { query: "effect" },
                    providerExecuted: true,
                  }),
                ]),
                Stream.fail(failure),
              ),
            )
          })
          .pipe(Effect.flip),
      ).toBe(failure)
      expect(yield* scenario.llm.requests).toHaveLength(1)
      const assistant = requireAssistant(yield* session.context(sessionID))
      const events = yield* recordedStepSettlementEvents(sessionID, assistant.id)
      expect(events.map((event) => event.type)).toEqual([
        "session.step.started.1",
        "session.tool.called.1",
        "session.tool.failed.1",
        "session.step.failed.1",
      ])
      expect(
        events.filter((event) => event.type.startsWith("session.step.") && event.type !== "session.step.started.1"),
      ).toHaveLength(1)
      yield* replaySessionProjection(sessionID)
      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Fail hosted tool on raw failure" },
        {
          type: "assistant",
          finish: "error",
          error: { type: "provider.transport", message: "Provider unavailable" },
          content: [{ type: "tool", id: "call-hosted-raw-failure", state: { status: "error" } }],
        },
      ])
    }),
  )

  scenarioIt("rejects a second text start before the open fragment ends", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Two blocks" }), resume: false })

      const defect = yield* scenario
        .run(function* () {
          yield* (yield* scenario.llm.next()).respond.events(
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "text-1" }),
            LLMEvent.textStart({ id: "text-2" }),
          )
        })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(defect).toBeInstanceOf(Error)
      if (!(defect instanceof Error)) return
      expect(defect.message).toBe("text start before end: text-2")
    }),
  )

  scenarioIt("projects sequential text fragments as separate content parts", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: "Two blocks" }), resume: false })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-1" }),
          LLMEvent.textDelta({ id: "text-1", text: "First" }),
          LLMEvent.textEnd({ id: "text-1" }),
          LLMEvent.textStart({ id: "text-2" }),
          LLMEvent.textDelta({ id: "text-2", text: "Second" }),
          LLMEvent.textEnd({ id: "text-2" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      })

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Two blocks" },
        {
          type: "assistant",
          content: [
            { type: "text", text: "First" },
            { type: "text", text: "Second" },
          ],
        },
      ])
    }),
  )

  for (const kind of fragmentKinds) {
    scenarioIt(`broadcasts provider ${kind} deltas without storing projection rewrites`, (scenario) =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const prompt = `Stream ${kind}`
        const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
        const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
        const expectedContext = [{ type: "user", text: prompt }, fixture.expectedAssistant]
        yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: prompt }), resume: false })
        const events = yield* EventV2.Service
        const live = yield* events.subscribe(fixture.delta).pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
        yield* Effect.yieldNow

        yield* scenario.run(function* () {
          yield* (yield* scenario.llm.next()).respond.events(...fixture.completeEvents)
        })

        const { db } = yield* Database.Service
        const deltas = yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(fixture.delta.type, 1)))
          .all()
          .pipe(Effect.orDie)
        expect(Array.from(yield* Fiber.join(live))).toHaveLength(32)
        expect(deltas).toHaveLength(0)
        expect(yield* session.context(sessionID)).toMatchObject(expectedContext)

        yield* replaySessionProjection(sessionID)

        expect(yield* session.context(sessionID)).toMatchObject(expectedContext)
      }),
    )

    scenarioIt(`durably closes partial ${kind} when the provider stream fails`, (scenario) =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const prompt = `Fail after ${kind}`
        const fixture = fragmentFixture(kind, fragmentID(kind, "partial"), ["Partial"])
        const failure = providerUnavailable()
        yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: prompt }), resume: false })

        expect(
          yield* scenario
            .run(function* () {
              yield* (yield* scenario.llm.next()).respond.stream(
                Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure)),
              )
            })
            .pipe(Effect.flip),
        ).toBe(failure)
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "user", text: prompt },
          {
            type: "assistant",
            finish: "error",
            error: { type: "provider.transport", message: "Provider unavailable" },
            content: [fixture.expectedContent],
          },
        ])
        expect(yield* scenario.llm.requests).toHaveLength(1)
      }),
    )

    scenarioIt(`durably closes partial ${kind} when the provider stream is interrupted`, (scenario) =>
      Effect.gen(function* () {
        yield* setup
        const session = yield* SessionV2.Service
        const prompt = `Interrupt after ${kind}`
        const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
        const streamed = yield* Deferred.make<void>()
        yield* session.prompt({ sessionID, prompt: PromptInput.Prompt.make({ text: prompt }), resume: false })

        yield* scenario
          .run(function* () {
            yield* (yield* scenario.llm.next()).respond.stream(
              Stream.concat(
                Stream.fromIterable(fixture.partialEvents),
                Stream.fromEffect(Deferred.succeed(streamed, undefined)).pipe(Stream.flatMap(() => Stream.never)),
              ),
            )
            yield* Deferred.await(streamed)
            yield* session.interrupt(sessionID)
          })
          .pipe(Effect.exit)
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "user", text: prompt },
          {
            type: "assistant",
            finish: "error",
            error: { type: "aborted", message: "Step interrupted" },
            content: [
              kind === "tool input"
                ? { type: "tool", id: fragmentID(kind, "interrupted"), state: { status: "error" } }
                : fixture.expectedContent,
            ],
          },
        ])
      }),
    )
  }

  scenarioIt("rejects duplicate streamed text starts", (scenario) =>
    Effect.gen(function* () {
      yield* setup

      const defect = yield* scenario
        .run(function* () {
          yield* (yield* scenario.llm.next()).respond.events(
            LLMEvent.textStart({ id: "text-1" }),
            LLMEvent.textStart({ id: "text-1" }),
          )
        })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(defect).toBeInstanceOf(Error)
      if (!(defect instanceof Error)) return
      expect(defect.message).toBe("Duplicate text start: text-1")
    }),
  )

  scenarioIt("transitions streamed raw tool input to parsed called input", (scenario) =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID,
        prompt: PromptInput.Prompt.make({ text: "Call provider tool" }),
        resume: false,
      })

      yield* scenario.run(function* () {
        yield* (yield* scenario.llm.next()).respond.events(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
          LLMEvent.toolInputDelta({ id: "call-parsed", name: "web_search", text: '{"query":"hello"}' }),
          LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
          LLMEvent.toolCall({
            id: "call-parsed",
            name: "web_search",
            input: { query: "hello" },
            providerExecuted: true,
          }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        )
      })

      expect(yield* session.context(sessionID)).toMatchObject([
        { type: "user", text: "Call provider tool" },
        {
          type: "assistant",
          content: [{ type: "tool", id: "call-parsed", state: { status: "error", input: { query: "hello" } } }],
        },
      ])
    }),
  )

  scenarioIt("rejects malformed streamed tool input ordering", (scenario) =>
    Effect.gen(function* () {
      yield* setup

      const defect = yield* scenario
        .run(function* () {
          yield* (yield* scenario.llm.next()).respond.events(
            LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" }),
          )
        })
        .pipe(Effect.catchDefect(Effect.succeed))
      expect(defect).toBeInstanceOf(Error)
      if (!(defect instanceof Error)) return
      expect(defect.message).toBe("Tool input delta before start: call-1")
    }),
  )
})
