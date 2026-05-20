import { DateTime, Effect, Layer } from "effect"
import { SessionMessage } from "@opencode-ai/core/session-message"
import { SessionStorage } from "./storage"

export interface State {
  readonly sessions: Map<string, SessionStorage.SessionRow>
  readonly messages: Map<string, SessionMessage.Message[]>
}

export const makeState = (): State => ({
  sessions: new Map(),
  messages: new Map(),
})

export const layer = (state: State = makeState()) =>
  Layer.succeed(
    SessionStorage.Service,
    SessionStorage.Service.of({
      get: (sessionID) => Effect.sync(() => state.sessions.get(sessionID)),
      list: (input) =>
        Effect.sync(() => {
          const direction = input.cursor?.direction ?? "next"
          const order = SessionStorage.pageOrder(input.order ?? "desc", direction)
          const rows = Array.from(state.sessions.values())
            .filter((row) => {
              if (input.directory && row.directory !== input.directory) return false
              if (input.path && row.path !== input.path && !row.path?.startsWith(`${input.path}/`)) return false
              if (input.workspaceID && row.workspaceID !== input.workspaceID) return false
              if (input.roots && row.parentID) return false
              if (input.start && DateTime.toEpochMillis(row.time.updated) < input.start) return false
              if (input.search && !row.title.includes(input.search)) return false
              if (!input.cursor) return true
              return compareCursor(row.id, DateTime.toEpochMillis(row.time.updated), input.cursor, order)
            })
            .toSorted((a, b) =>
              compareRows(
                a.id,
                DateTime.toEpochMillis(a.time.updated),
                b.id,
                DateTime.toEpochMillis(b.time.updated),
                order,
              ),
            )
          const limited = input.limit === undefined ? rows : rows.slice(0, input.limit)
          return direction === "previous" ? limited.toReversed() : limited
        }),
      messages: (input) =>
        Effect.sync(() => {
          const direction = input.cursor?.direction ?? "next"
          const order = SessionStorage.pageOrder(input.order ?? "desc", direction)
          const rows = (state.messages.get(input.sessionID) ?? [])
            .filter((message) => {
              if (!input.cursor) return true
              return compareCursor(message.id, DateTime.toEpochMillis(message.time.created), input.cursor, order)
            })
            .toSorted((a, b) =>
              compareRows(
                a.id,
                DateTime.toEpochMillis(a.time.created),
                b.id,
                DateTime.toEpochMillis(b.time.created),
                order,
              ),
            )
          const limited = input.limit === undefined ? rows : rows.slice(0, input.limit)
          return direction === "previous" ? limited.toReversed() : limited
        }),
      context: (sessionID) =>
        Effect.sync(() => {
          const messages = (state.messages.get(sessionID) ?? []).toSorted((a, b) =>
            compareRows(
              a.id,
              DateTime.toEpochMillis(a.time.created),
              b.id,
              DateTime.toEpochMillis(b.time.created),
              "asc",
            ),
          )
          const index = messages.findLastIndex((message) => message.type === "compaction")
          return index === -1 ? messages : messages.slice(index)
        }),
    }),
  )

export const defaultLayer = layer()

function compareCursor(
  id: string,
  time: number,
  cursor: { readonly id: string; readonly time: number },
  order: SessionStorage.SortOrder,
) {
  if (order === "asc") return time > cursor.time || (time === cursor.time && id > cursor.id)
  return time < cursor.time || (time === cursor.time && id < cursor.id)
}

function compareRows(aID: string, aTime: number, bID: string, bTime: number, order: SessionStorage.SortOrder) {
  const result = aTime === bTime ? aID.localeCompare(bID) : aTime - bTime
  return order === "asc" ? result : -result
}

export * as SessionStorageMemory from "./storage-memory"
