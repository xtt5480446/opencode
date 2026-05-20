import { WorkspaceID } from "@/control-plane/schema"
import { ProjectID } from "@/project/schema"
import { SessionID } from "@/session/schema"
import { V2Schema } from "@opencode-ai/core/v2-schema"
import { SessionMessage } from "@opencode-ai/core/session-message"
import { ModelV2 } from "@opencode-ai/core/model"
import { Context, Effect, Schema } from "effect"

export const SortOrder = Schema.Literals(["asc", "desc"]).annotate({
  identifier: "SortOrder",
})
export type SortOrder = typeof SortOrder.Type

export const PageDirection = Schema.Literals(["previous", "next"]).annotate({
  identifier: "PageDirection",
})
export type PageDirection = typeof PageDirection.Type

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("StorageError", {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

export class SessionRow extends Schema.Class<SessionRow>("SessionRow")({
  id: SessionID,
  parentID: Schema.optional(SessionID),
  projectID: ProjectID,
  workspaceID: Schema.optional(WorkspaceID),
  directory: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(ModelV2.Ref),
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
    archived: Schema.optional(V2Schema.DateTimeUtcFromMillis),
  }),
  title: Schema.String,
}) {}

export const SessionCursor = Schema.Struct({
  id: SessionID,
  time: Schema.Finite,
  direction: PageDirection,
}).annotate({ identifier: "SessionCursor" })
export type SessionCursor = typeof SessionCursor.Type

export const SessionListInput = Schema.Struct({
  limit: Schema.optional(Schema.Finite),
  order: Schema.optional(SortOrder),
  directory: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  workspaceID: Schema.optional(WorkspaceID),
  roots: Schema.optional(Schema.Boolean),
  start: Schema.optional(Schema.Finite),
  search: Schema.optional(Schema.String),
  cursor: Schema.optional(SessionCursor),
}).annotate({ identifier: "SessionListInput" })
export type SessionListInput = typeof SessionListInput.Type

export const MessageCursor = Schema.Struct({
  id: SessionMessage.ID,
  time: Schema.Finite,
  direction: PageDirection,
}).annotate({ identifier: "MessageCursor" })
export type MessageCursor = typeof MessageCursor.Type

export const MessageListInput = Schema.Struct({
  sessionID: SessionID,
  limit: Schema.optional(Schema.Finite),
  order: Schema.optional(SortOrder),
  cursor: Schema.optional(MessageCursor),
}).annotate({ identifier: "MessageListInput" })
export type MessageListInput = typeof MessageListInput.Type

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<SessionRow | undefined, StorageError>
  readonly list: (input: SessionListInput) => Effect.Effect<SessionRow[], StorageError>
  readonly messages: (input: MessageListInput) => Effect.Effect<SessionMessage.Message[], StorageError>
  readonly context: (sessionID: SessionID) => Effect.Effect<SessionMessage.Message[], StorageError>
}

export function pageOrder(order: SortOrder, direction: PageDirection) {
  if (direction !== "previous") return order
  return order === "asc" ? "desc" : "asc"
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/session/Storage") {}

export * as SessionStorage from "./storage"
