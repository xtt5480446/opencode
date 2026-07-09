import { HttpRecorder } from "@opencode-ai/http-recorder"
import {
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_HTTP_REQUEST_METHOD,
} from "@opencode-ai/core/observability/semconv"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Auth, LLMClient, RequestExecutor } from "@opencode-ai/llm/route"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Job } from "@opencode-ai/core/job"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionTitle } from "@opencode-ai/core/session/title"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Location } from "@opencode-ai/core/location"
import { InstructionBuiltIns } from "@opencode-ai/core/instructions/builtins"
import { InstructionDiscovery } from "@opencode-ai/core/instruction-discovery"
import { Instructions } from "@opencode-ai/core/instructions"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { McpGuidance } from "@opencode-ai/core/mcp/guidance"
import { SessionTelemetry } from "@opencode-ai/core/observability/session"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer, References, Tracer } from "effect"
import path from "node:path"
import { testEffect } from "./lib/effect"

const cassetteName = "session-runner/openai-chat-streams-text"
const cassetteDirectory = path.resolve(import.meta.dir, "fixtures/recordings")
if (process.env.RECORD === "true") {
  if (process.env.CI !== undefined) throw new Error("Unset CI before recording HTTP cassettes")
  HttpRecorder.removeCassetteSync(cassetteName, { directory: cassetteDirectory })
}
const cassette = HttpRecorder.layerFetch(cassetteName, { directory: cassetteDirectory })
const executor = RequestExecutor.layer.pipe(Layer.provide(cassette))
const client = LLMClient.layer.pipe(Layer.provide(executor))
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
const model = OpenAIChat.route
  .with({
    endpoint: { baseURL: "https://api.openai.com/v1" },
    auth: Auth.bearer(process.env.OPENAI_API_KEY ?? "fixture"),
    generation: { maxTokens: 20, temperature: 0 },
  })
  .model({ id: "gpt-4o-mini" })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(SessionRunnerModel.resolved(model)))
const systemContext = Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) })
const instructionContext = Layer.mock(InstructionDiscovery.Service, { load: () => Effect.succeed(Instructions.empty) })
const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(Instructions.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(Instructions.empty) })
const mcpGuidance = Layer.mock(McpGuidance.Service, { load: () => Effect.succeed(Instructions.empty) })
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const pluginSupervisor = Layer.succeed(PluginSupervisor.Service, PluginSupervisor.Service.of({ flush: Effect.void }))
const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [InstructionBuiltIns.node, systemContext],
  [InstructionDiscovery.node, instructionContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [McpGuidance.node, mcpGuidance],
  [Config.node, config],
  [PermissionV2.node, permission],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  [PluginSupervisor.node, pluginSupervisor],
])
const spans: Tracer.NativeSpan[] = []
const tracer = Tracer.make({
  span(options) {
    const span = new Tracer.NativeSpan(options)
    spans.push(span)
    return span
  },
})
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const telemetry = SessionTelemetry.makeExecution<SessionV2.ID>()
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => telemetry.drain(sessionID, sessionRunner.drain({ sessionID, force })),
      settled: (sessionID) => telemetry.settled(sessionID),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: (sessionID) => telemetry.resume(sessionID, coordinator.run(sessionID)),
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
      awaitIdle: coordinator.awaitIdle,
    })
  }),
).pipe(
  Layer.provide(runnerLayer),
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(Tracer.Tracer, tracer),
      Layer.succeed(References.TracerEnabled, false),
    ),
  ),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      AgentV2.node,
      ToolRegistry.node,
      SessionRunnerModel.node,
      InstructionBuiltIns.node,
      InstructionDiscovery.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [SessionRunnerModel.node, models],
      [InstructionBuiltIns.node, systemContext],
      [InstructionDiscovery.node, instructionContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Config.node, config],
      [Snapshot.node, Snapshot.noopLayer],
      [PluginSupervisor.node, pluginSupervisor],
      [SessionExecution.node, execution],
    ],
  ),
)
const sessionID = SessionV2.ID.make("ses_runner_recorded")

describe("SessionRunnerLLM recorded", () => {
  it.effect("executes one recorded V2 prompt through the recorded HTTP transport", () =>
    Effect.gen(function* () {
      spans.length = 0
      const agents = yield* AgentV2.Service
      yield* agents.transform((draft) =>
        draft.update(AgentV2.ID.make("build"), (agent) => {
          agent.mode = "primary"
        }),
      )
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      const prompt = yield* session.prompt({
        sessionID,
        text: "Say hello in one short sentence.",
        resume: false,
      })

      yield* session.resume(sessionID).pipe(Effect.provideService(SessionTelemetry.TraceParent, null))

      const messages = yield* session.context(sessionID)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ id: prompt.id, type: "user", text: "Say hello in one short sentence." })
      expect(messages[1]).toMatchObject({ type: "assistant", agent: "build", finish: "stop" })
      expect(messages[1]?.type === "assistant" ? messages[1].content : []).toMatchObject([
        { type: "text", text: "Hello!" },
      ])
      const agent = spans.find((span) => span.name === "invoke_agent build")
      const model = spans.find((span) => span.name === "chat gpt-4o-mini")
      const http = spans.find((span) => span.attributes.get(ATTR_HTTP_REQUEST_METHOD) === "POST")
      expect(agent?.parent._tag).toBe("None")
      expect(agent?.attributes.get(ATTR_GEN_AI_CONVERSATION_ID)).toBe(sessionID)
      expect(model?.parent._tag === "Some" ? model.parent.value.spanId : undefined).toBe(agent?.spanId)
      expect(http?.parent._tag === "Some" ? http.parent.value.spanId : undefined).toBe(model?.spanId)
      expect(model?.attributes.get(ATTR_GEN_AI_USAGE_INPUT_TOKENS)).toBeNumber()
      expect(model?.attributes.get(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS)).toBeNumber()
      expect(spans.filter((span) => span.name.startsWith("SessionRunner."))).toEqual([])
      expect(
        (yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .orderBy(EventTable.seq)
          .all()).map((event) => event.type),
      ).toEqual([
        "session.input.admitted.1",
        "session.input.promoted.1",
        "session.step.started.1",
        "session.text.started.1",
        "session.text.ended.1",
        "session.step.ended.1",
      ])
    }),
  )
})
