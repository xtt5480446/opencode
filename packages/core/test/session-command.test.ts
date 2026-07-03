import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { CommandV2 } from "@opencode-ai/core/command"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Job } from "@opencode-ai/core/job"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      Job.node,
      SessionProjector.node,
      SessionStore.node,
      SessionV2.node,
      LocationServiceMap.node,
    ]),
    [
      [ProjectV2.node, projects],
      [
        SessionExecution.node,
        Layer.succeed(
          SessionExecution.Service,
          SessionExecution.Service.of({
            active: Effect.succeed(new Set()),
            resume: () => Effect.never,
            wake: () => Effect.void,
            interrupt: () => Effect.void,
            awaitIdle: () => Effect.void,
          }),
        ),
      ],
    ],
  ),
)

const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.make("anthropic") })

function withTmp<A, E, R>(f: (location: Location.Ref) => Effect.Effect<A, E, R>) {
  return Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }))))
}

describe("SessionV2.command", () => {
  it.effect("runs subagent commands as background child sessions", () =>
    withTmp((location) =>
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const parent = yield* sessions.create({ location, model })
        const locations = yield* LocationServiceMap.Service
        const commands = yield* CommandV2.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* commands.transform((draft) => {
          draft.update("review", (command) => {
            command.template = "Review this"
            command.description = "review changes"
            command.agent = "reviewer"
            command.subagent = true
          })
        })

        const admitted = yield* sessions.command({ sessionID: parent.id, command: "review" })
        const children = yield* sessions.list({ parentID: parent.id })

        expect(children.data).toHaveLength(1)
        expect(children.data[0]).toMatchObject({
          parentID: parent.id,
          title: "review changes",
          agent: AgentV2.ID.make("reviewer"),
          model,
        })
        expect(admitted).toMatchObject({ sessionID: children.data[0]!.id, prompt: { text: "Review this" } })
        expect(yield* Job.Service.use((jobs) => jobs.get(children.data[0]!.id))).toMatchObject({
          id: children.data[0]!.id,
          type: "subagent",
          status: "running",
        })
        expect(yield* sessions.messages({ sessionID: parent.id })).toEqual([
          expect.objectContaining({ type: "synthetic", text: expect.stringContaining(children.data[0]!.id) }),
        ])
      }),
    ),
  )

  it.effect("defaults subagent commands without an agent to the general agent", () =>
    withTmp((location) =>
      Effect.gen(function* () {
        const sessions = yield* SessionV2.Service
        const parent = yield* sessions.create({ location })
        const locations = yield* LocationServiceMap.Service
        const commands = yield* CommandV2.Service.pipe(Effect.provide(locations.get(parent.location)))
        yield* commands.transform((draft) => {
          draft.update("research", (command) => {
            command.template = "Legacy task"
            command.subagent = true
          })
        })

        const admitted = yield* sessions.command({ sessionID: parent.id, command: "research" })
        const children = yield* sessions.list({ parentID: parent.id })

        expect(children.data).toHaveLength(1)
        expect(children.data[0]).toMatchObject({ agent: AgentV2.ID.make("general") })
        expect(admitted).toMatchObject({ sessionID: children.data[0]!.id, prompt: { text: "Legacy task" } })
      }),
    ),
  )
})
