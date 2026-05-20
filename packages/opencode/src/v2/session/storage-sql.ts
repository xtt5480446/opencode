import { SessionMessageTable, SessionTable } from "@/session/session.sql"
import { and, asc, Database, desc, eq, gt, gte, isNull, like, lt, or, type SQL } from "@/storage/db"
import { SessionMessage } from "@opencode-ai/core/session-message"
import { Effect, Layer, Schema } from "effect"
import { SessionStorage } from "./storage"

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const decodeSessionRow = Schema.decodeUnknownSync(SessionStorage.SessionRow)

export const layer = Layer.effect(
  SessionStorage.Service,
  Effect.gen(function* () {
    const get: SessionStorage.Interface["get"] = Effect.fn("SessionStorageSql.get")((sessionID) =>
      attempt(() =>
        Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()),
      ).pipe(Effect.map((row) => (row ? fromSessionRow(row) : undefined))),
    )

    const list: SessionStorage.Interface["list"] = Effect.fn("SessionStorageSql.list")((input) =>
      attempt(() => {
        const direction = input.cursor?.direction ?? "next"
        const order = SessionStorage.pageOrder(input.order ?? "desc", direction)
        const sortColumn = SessionTable.time_updated
        const conditions: SQL[] = []
        if (input.directory) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.path)
          conditions.push(or(eq(SessionTable.path, input.path), like(SessionTable.path, `${input.path}/%`))!)
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if (input.roots) conditions.push(isNull(SessionTable.parent_id))
        if (input.start) conditions.push(gte(sortColumn, input.start))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.cursor) conditions.push(sessionCursorBoundary(input.cursor, order))

        return Database.use((db) => {
          const query = db
            .select()
            .from(SessionTable)
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(
              order === "asc" ? asc(sortColumn) : desc(sortColumn),
              order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
            )
          const rows = input.limit === undefined ? query.all() : query.limit(input.limit).all()
          return direction === "previous" ? rows.toReversed() : rows
        })
      }).pipe(Effect.map((rows) => rows.map(fromSessionRow))),
    )

    const messages: SessionStorage.Interface["messages"] = Effect.fn("SessionStorageSql.messages")((input) =>
      attempt(() => {
        const direction = input.cursor?.direction ?? "next"
        const order = SessionStorage.pageOrder(input.order ?? "desc", direction)
        const boundary = input.cursor ? messageCursorBoundary(input.cursor, order) : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)

        return Database.use((db) => {
          const query = db
            .select()
            .from(SessionMessageTable)
            .where(where)
            .orderBy(
              order === "asc" ? asc(SessionMessageTable.time_created) : desc(SessionMessageTable.time_created),
              order === "asc" ? asc(SessionMessageTable.id) : desc(SessionMessageTable.id),
            )
          const rows = input.limit === undefined ? query.all() : query.limit(input.limit).all()
          return direction === "previous" ? rows.toReversed() : rows
        })
      }).pipe(Effect.map((rows) => rows.map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type })))),
    )

    const context: SessionStorage.Interface["context"] = Effect.fn("SessionStorageSql.context")((sessionID) =>
      attempt(() =>
        Database.use((db) => {
          const compaction = db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
            .orderBy(desc(SessionMessageTable.time_created), desc(SessionMessageTable.id))
            .limit(1)
            .get()

          return db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, sessionID),
                compaction
                  ? or(
                      gt(SessionMessageTable.time_created, compaction.time_created),
                      and(
                        eq(SessionMessageTable.time_created, compaction.time_created),
                        gte(SessionMessageTable.id, compaction.id),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(asc(SessionMessageTable.time_created), asc(SessionMessageTable.id))
            .all()
        }),
      ).pipe(Effect.map((rows) => rows.map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type })))),
    )

    return SessionStorage.Service.of({ get, list, messages, context })
  }),
)

export const defaultLayer = layer

function attempt<A>(body: () => A) {
  return Effect.try({
    try: body,
    catch: (cause) => new SessionStorage.StorageError({ message: "Session storage SQL operation failed", cause }),
  })
}

function sessionCursorBoundary(cursor: SessionStorage.SessionCursor, order: SessionStorage.SortOrder) {
  if (order === "asc")
    return or(
      gt(SessionTable.time_updated, cursor.time),
      and(eq(SessionTable.time_updated, cursor.time), gt(SessionTable.id, cursor.id)),
    )!
  return or(
    lt(SessionTable.time_updated, cursor.time),
    and(eq(SessionTable.time_updated, cursor.time), lt(SessionTable.id, cursor.id)),
  )!
}

function messageCursorBoundary(cursor: SessionStorage.MessageCursor, order: SessionStorage.SortOrder) {
  if (order === "asc")
    return or(
      gt(SessionMessageTable.time_created, cursor.time),
      and(eq(SessionMessageTable.time_created, cursor.time), gt(SessionMessageTable.id, cursor.id)),
    )!
  return or(
    lt(SessionMessageTable.time_created, cursor.time),
    and(eq(SessionMessageTable.time_created, cursor.time), lt(SessionMessageTable.id, cursor.id)),
  )!
}

function fromSessionRow(row: typeof SessionTable.$inferSelect) {
  return decodeSessionRow({
    id: row.id,
    parentID: row.parent_id ?? undefined,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    title: row.title,
    path: row.path ?? "",
    agent: row.agent ?? undefined,
    model: row.model ? { ...row.model, variant: row.model.variant ?? "default" } : undefined,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    time: {
      created: row.time_created,
      updated: row.time_updated,
      archived: row.time_archived ?? undefined,
    },
  })
}

export * as SessionStorageSql from "./storage-sql"
