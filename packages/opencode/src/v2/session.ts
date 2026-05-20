import { SessionID } from "@/session/schema"
import { WorkspaceID } from "@/control-plane/schema"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SessionMessage } from "@opencode-ai/core/session-message"
import type { Prompt } from "@opencode-ai/core/session-prompt"
import { ProjectID } from "@/project/schema"
import { SessionEvent } from "@opencode-ai/core/session-event"
import { V2Schema } from "@opencode-ai/core/v2-schema"
import { optionalOmitUndefined } from "@opencode-ai/core/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionStorage } from "./session/storage"
import { SessionStorageSql } from "./session/storage-sql"

export const Delivery = Schema.Literals(["immediate", "deferred"]).annotate({
  identifier: "Session.Delivery",
})
export type Delivery = Schema.Schema.Type<typeof Delivery>

export const DefaultDelivery = "immediate" satisfies Delivery

export class Info extends Schema.Class<Info>("Session.Info")({
  id: SessionID,
  parentID: optionalOmitUndefined(SessionID),
  projectID: ProjectID,
  workspaceID: optionalOmitUndefined(WorkspaceID),
  path: optionalOmitUndefined(Schema.String),
  agent: optionalOmitUndefined(Schema.String),
  model: ModelV2.Ref.pipe(optionalOmitUndefined),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  time: Schema.Struct({
    created: V2Schema.DateTimeUtcFromMillis,
    updated: V2Schema.DateTimeUtcFromMillis,
    archived: optionalOmitUndefined(V2Schema.DateTimeUtcFromMillis),
  }),
  title: Schema.String,
  /*
  slug: Schema.String,
  directory: Schema.String,
  path: optionalOmitUndefined(Schema.String),
  parentID: optionalOmitUndefined(SessionID),
  summary: optionalOmitUndefined(Summary),
  share: optionalOmitUndefined(Share),
  title: Schema.String,
  version: Schema.String,
  time: Time,
  permission: optionalOmitUndefined(Permission.Ruleset),
  revert: optionalOmitUndefined(Revert),
  */
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionID,
}) {}

export interface Interface {
  readonly create: (input?: {
    agent?: string
    model?: ModelV2.Ref
    parentID?: SessionID
    workspaceID?: WorkspaceID
  }) => Effect.Effect<Info>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info, NotFoundError>
  readonly list: (input: SessionStorage.SessionListInput) => Effect.Effect<Info[]>
  readonly messages: (input: SessionStorage.MessageListInput) => Effect.Effect<SessionMessage.Message[]>
  readonly context: (sessionID: SessionID) => Effect.Effect<SessionMessage.Message[]>
  readonly prompt: (input: {
    id?: EventV2.ID
    sessionID: SessionID
    prompt: Prompt
    delivery?: Delivery
  }) => Effect.Effect<SessionMessage.User>
  readonly shell: (input: { id?: EventV2.ID; sessionID: SessionID; command: string }) => Effect.Effect<void>
  readonly skill: (input: { id?: EventV2.ID; sessionID: SessionID; skill: string }) => Effect.Effect<void>
  readonly subagent: (input: {
    id?: EventV2.ID
    parentID: SessionID
    prompt: Prompt
    agent: string
    model?: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionID; agent: string }) => Effect.Effect<void>
  readonly switchModel: (input: { sessionID: SessionID; model: ModelV2.Ref }) => Effect.Effect<void>
  readonly compact: (sessionID: SessionID) => Effect.Effect<void>
  readonly wait: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const storage = yield* SessionStorage.Service

    const result = Service.of({
      create: Effect.fn("V2Session.create")(function* (_input) {
        return yield* Effect.die(new Error("V2Session.create is not implemented"))
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const row = yield* storage.get(sessionID).pipe(Effect.orDie)
        if (!row) return yield* new NotFoundError({ sessionID })
        return new Info(row)
      }),
      list: Effect.fn("V2Session.list")(function* (input) {
        return (yield* storage.list(input).pipe(Effect.orDie)).map((row) => new Info(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        return yield* storage.messages(input).pipe(Effect.orDie)
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        return yield* storage.context(sessionID).pipe(Effect.orDie)
      }),
      prompt: Effect.fn("V2Session.prompt")(function* (_input) {
        return yield* Effect.die(new Error("V2Session.prompt is not implemented"))
      }),
      shell: Effect.fn("V2Session.shell")(function* (_input) {}),
      skill: Effect.fn("V2Session.skill")(function* (_input) {}),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          model: input.model,
        })
      }),
      subagent: Effect.fn("V2Session.subagent")(function* (input) {
        const parent = yield* result.get(input.parentID)
        const child = yield* result.create({
          agent: input.agent,
          model: input.model,
          parentID: input.parentID,
          workspaceID: parent.workspaceID,
        })
        yield* result.prompt({
          prompt: input.prompt,
          sessionID: child.id,
        })
        yield* Effect.gen(function* () {
          yield* result.wait(child.id)
          const messages = yield* result.messages({ sessionID: child.id, order: "desc" })
          const assistant = messages.find((msg) => msg.type === "assistant")
          if (!assistant) return
          const text = assistant.content.findLast((part) => part.type === "text")
          if (!text) return
        }).pipe(Effect.forkChild())
      }),
      compact: Effect.fn("V2Session.compact")(function* (_sessionID) {}),
      wait: Effect.fn("V2Session.wait")(function* (_sessionID) {}),
    })

    return result
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(EventV2Bridge.defaultLayer, SessionStorageSql.defaultLayer)),
)

export * as SessionV2 from "./session"
