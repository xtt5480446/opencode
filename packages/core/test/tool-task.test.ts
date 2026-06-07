import { describe, expect } from "bun:test"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { TaskTool } from "@opencode-ai/core/tool/task"
import { Tool } from "@opencode-ai/core/tool/tool"
import { DateTime, Deferred, Effect, Fiber, Layer } from "effect"
import { toolIdentity } from "./lib/tool"
import { testEffect } from "./lib/effect"

const parentID = SessionV2.ID.make("ses_task_parent")
const childID = SessionV2.ID.make("ses_task_child")
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const parent = new SessionV2.Info({
  id: parentID,
  projectID: ProjectV2.ID.make("project"),
  agent: AgentV2.ID.make("build"),
  model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  title: "Parent",
  location,
})
const child = new SessionV2.Info({
  id: childID,
  parentID,
  projectID: parent.projectID,
  agent: parent.agent,
  model: parent.model,
  cost: 0,
  tokens: parent.tokens,
  time: parent.time,
  title: "Child",
  location,
})
const assistant = new SessionMessage.Assistant({
  id: SessionMessage.ID.make("msg_task_assistant"),
  type: "assistant",
  agent: "explore",
  model: parent.model!,
  content: [new SessionMessage.AssistantText({ type: "text", id: "text", text: "Task output" })],
  time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
})
const input = {
  description: "Map auth",
  prompt: "Map the authentication flow",
  subagent_type: "explore",
}

describe("TaskTool", () => {
  const it = testEffect(Layer.empty)
  const resolveAgent = (): Effect.Effect<AgentV2.Info | undefined> =>
    Effect.succeed(AgentV2.Info.empty(AgentV2.ID.make("explore")))

  it.effect("runs a foreground child with an admit-only steer and explicit resume", () =>
    Effect.gen(function* () {
      const inputs: Parameters<SessionV2.Interface["prompt"]>[0][] = []
      let resumed = 0
      const sessions = mockSessions({
        prompt: (value) => {
          inputs.push(value)
          return Effect.succeed(admission(value))
        },
        resume: () => Effect.sync(() => resumed++),
      })
      const tool = yield* TaskTool.make(sessions, resolveAgent)

      const result = yield* execute(tool, { ...input, background: false }, "call_task")

      expect(result.structured).toEqual({ sessionID: childID, status: "completed", output: "Task output" })
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatchObject({ sessionID: childID, delivery: "steer", resume: false })
      expect(resumed).toBe(1)
    }),
  )

  it.effect("rejects an unknown subagent before creating a child", () =>
    Effect.gen(function* () {
      let created = false
      const sessions = mockSessions({
        create: () =>
          Effect.sync(() => {
            created = true
            return child
          }),
      })
      const tool = yield* TaskTool.make(sessions, () => Effect.succeed(undefined))

      const error = yield* execute(tool, { ...input, subagent_type: "missing" }, "call_task_unknown").pipe(Effect.flip)

      expect(error.message).toBe("Unknown subagent: missing")
      expect(created).toBe(false)
    }),
  )

  it.live("does not notify the parent when background work is interrupted", () =>
    Effect.gen(function* () {
      let notified = false
      const sessions = mockSessions({
        prompt: (value) => {
          if (value.sessionID === parentID) notified = true
          return Effect.succeed(admission(value))
        },
        resume: () => Effect.interrupt,
      })
      const tool = yield* TaskTool.make(sessions, resolveAgent)

      const result = yield* execute(tool, { ...input, background: true }, "call_task_background_interrupt")

      expect(result.structured).toEqual({ sessionID: childID, status: "running" })
      yield* Effect.yieldNow
      expect(notified).toBe(false)
    }),
  )

  it.live("interrupts the child when foreground waiting is interrupted", () =>
    Effect.gen(function* () {
      const resumed = yield* Deferred.make<void>()
      const interrupts: SessionV2.ID[] = []
      const sessions = mockSessions({
        resume: () => Deferred.succeed(resumed, undefined).pipe(Effect.andThen(Effect.never)),
        interrupt: (sessionID) => Effect.sync(() => interrupts.push(sessionID)),
      })
      const tool = yield* TaskTool.make(sessions, resolveAgent)
      const fiber = yield* execute(tool, input, "call_task_interrupt").pipe(Effect.forkChild)

      yield* Deferred.await(resumed)
      yield* Fiber.interrupt(fiber)
      expect(interrupts).toEqual([childID])
    }),
  )

  it.live("returns before background completion and steers the result into the parent", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const notified = yield* Deferred.make<Parameters<SessionV2.Interface["prompt"]>[0]>()
      const inputs: Parameters<SessionV2.Interface["prompt"]>[0][] = []
      const sessions = mockSessions({
        prompt: (value) => {
          inputs.push(value)
          return value.sessionID === parentID
            ? Deferred.succeed(notified, value).pipe(Effect.as(admission(value)))
            : Effect.succeed(admission(value))
        },
        resume: () => Deferred.await(gate),
      })
      const tool = yield* TaskTool.make(sessions, resolveAgent)

      const result = yield* execute(tool, { ...input, background: true }, "call_task_background")

      expect(result.structured).toEqual({ sessionID: childID, status: "running" })
      expect(inputs).toHaveLength(1)
      yield* Deferred.succeed(gate, undefined)
      const notification = yield* Deferred.await(notified)
      expect(notification).toMatchObject({ sessionID: parentID, delivery: "steer" })
      expect(notification.prompt.text).toContain("Background task completed: Map auth")
      expect(notification.prompt.text).toContain("Task output")
    }),
  )
})

function mockSessions(overrides: {
  create?: SessionV2.Interface["create"]
  interrupt?: SessionV2.Interface["interrupt"]
  prompt?: SessionV2.Interface["prompt"]
  resume?: SessionV2.Interface["resume"]
}): Pick<SessionV2.Interface, "create" | "get" | "interrupt" | "messages" | "prompt" | "resume"> {
  return {
    create: overrides.create ?? (() => Effect.succeed(child)),
    get: (id) => Effect.succeed(id === parentID ? parent : child),
    prompt: overrides.prompt ?? ((value) => Effect.succeed(admission(value))),
    resume: overrides.resume ?? (() => Effect.void),
    messages: () => Effect.succeed([assistant]),
    interrupt: overrides.interrupt ?? (() => Effect.void),
  }
}

function admission(input: Parameters<SessionV2.Interface["prompt"]>[0]) {
  return new SessionInput.Admitted({
    admittedSeq: 1,
    id: input.id ?? SessionMessage.ID.create(),
    sessionID: input.sessionID,
    prompt: input.prompt,
    delivery: input.delivery ?? "steer",
    timeCreated: DateTime.makeUnsafe(0),
  })
}

function execute(tool: Tool.AnyTool, input: unknown, toolCallID: string) {
  return Tool.settle(
    tool,
    { type: "tool-call", id: toolCallID, name: "task", input },
    {
      sessionID: parentID,
      ...toolIdentity,
      toolCallID,
    },
  )
}
