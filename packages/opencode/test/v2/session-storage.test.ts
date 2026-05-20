import { expect } from "bun:test"
import { ProjectID } from "@/project/schema"
import { ProjectTable } from "@/project/project.sql"
import { SessionID } from "@/session/schema"
import { SessionMessageTable, SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { SessionStorage } from "@/v2/session/storage"
import { SessionStorageMemory } from "@/v2/session/storage-memory"
import { SessionStorageSql } from "@/v2/session/storage-sql"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionMessage } from "@opencode-ai/core/session-message"
import { eq, or } from "@/storage/db"
import { DateTime, Effect, Layer, Schema } from "effect"
import { testEffect } from "../lib/effect"

const projectID = ProjectID.make("project-session-storage")
const sessionA = SessionID.make("ses_storage_a")
const sessionB = SessionID.make("ses_storage_b")
const sessionC = SessionID.make("ses_storage_c")
const encodeMessage = Schema.encodeSync(SessionMessage.Message)
const memoryState = SessionStorageMemory.makeState()

interface Seeds<R> {
  readonly reset: Effect.Effect<void, never, R>
  readonly project: Effect.Effect<void, never, R>
  readonly session: (input: {
    id: SessionID
    title: string
    directory?: string
    path: string
    updated: number
  }) => Effect.Effect<void, never, R>
  readonly userMessage: (input: { id: SessionMessage.ID; text: string; time: number }) => Effect.Effect<void, never, R>
  readonly compaction: (input: {
    id: SessionMessage.ID
    summary: string
    time: number
  }) => Effect.Effect<void, never, R>
}

function sessionStorageContract<R, E>(name: string, layer: Layer.Layer<SessionStorage.Service | R, E>, seed: Seeds<R>) {
  const it = testEffect(layer)

  const setup = Effect.gen(function* () {
    yield* seed.reset
    yield* Effect.addFinalizer(() => seed.reset)
    yield* seed.project
  })

  it.effect("gets and lists sessions with filters and cursors", () =>
    Effect.gen(function* () {
      yield* setup
      yield* seed.session({
        id: sessionA,
        title: "Alpha",
        directory: "/tmp/project-session-storage",
        path: "apps/api",
        updated: 1000,
      })
      yield* seed.session({
        id: sessionB,
        title: "Beta",
        directory: "/tmp/project-session-storage",
        path: "apps/web",
        updated: 2000,
      })
      yield* seed.session({
        id: sessionC,
        title: "Gamma",
        directory: "/tmp/other-project",
        path: "docs",
        updated: 3000,
      })

      const storage = yield* SessionStorage.Service
      const found = yield* storage.get(sessionB)
      expect(found?.title).toBe("Beta")
      expect(found ? DateTime.toEpochMillis(found.time.updated) : undefined).toBe(2000)

      expect((yield* storage.list({ path: "apps", order: "asc" })).map((row) => row.id)).toEqual([sessionA, sessionB])
      expect(
        (yield* storage.list({ directory: "/tmp/project-session-storage", order: "asc" })).map((row) => row.id),
      ).toEqual([sessionA, sessionB])
      expect(
        (yield* storage.list({ order: "asc", cursor: { id: sessionA, time: 1000, direction: "next" } })).map(
          (row) => row.id,
        ),
      ).toEqual([sessionB, sessionC])
      expect(
        (yield* storage.list({ order: "asc", cursor: { id: sessionC, time: 3000, direction: "previous" } })).map(
          (row) => row.id,
        ),
      ).toEqual([sessionA, sessionB])
    }),
  )

  it.effect("lists session messages with cursor direction", () =>
    Effect.gen(function* () {
      yield* setup
      yield* seed.session({ id: sessionA, title: "Alpha", path: "apps/api", updated: 1000 })
      yield* seed.userMessage({ id: EventV2.ID.make("evt_msg_1"), text: "one", time: 1000 })
      yield* seed.userMessage({ id: EventV2.ID.make("evt_msg_2"), text: "two", time: 2000 })
      yield* seed.userMessage({ id: EventV2.ID.make("evt_msg_3"), text: "three", time: 3000 })

      const storage = yield* SessionStorage.Service

      expect((yield* storage.messages({ sessionID: sessionA, order: "asc", limit: 2 })).map((row) => row.id)).toEqual([
        EventV2.ID.make("evt_msg_1"),
        EventV2.ID.make("evt_msg_2"),
      ])
      expect(
        (yield* storage.messages({
          sessionID: sessionA,
          order: "asc",
          cursor: { id: EventV2.ID.make("evt_msg_3"), time: 3000, direction: "previous" },
        })).map((row) => row.id),
      ).toEqual([EventV2.ID.make("evt_msg_1"), EventV2.ID.make("evt_msg_2")])
    }),
  )

  it.effect("returns context from the latest compaction boundary", () =>
    Effect.gen(function* () {
      yield* setup
      yield* seed.session({ id: sessionA, title: "Alpha", path: "apps/api", updated: 1000 })
      yield* seed.userMessage({ id: EventV2.ID.make("evt_context_1"), text: "before", time: 1000 })
      yield* seed.compaction({ id: EventV2.ID.make("evt_context_2"), summary: "compact", time: 2000 })
      yield* seed.userMessage({ id: EventV2.ID.make("evt_context_3"), text: "after", time: 3000 })

      const storage = yield* SessionStorage.Service
      const context = yield* storage.context(sessionA)

      expect(context.map((message) => message.id)).toEqual([
        EventV2.ID.make("evt_context_2"),
        EventV2.ID.make("evt_context_3"),
      ])
      expect(context.map((message) => message.type)).toEqual(["compaction", "user"])
    }),
  )
}

const sqlSeeds: Seeds<never> = {
  reset: Effect.sync(resetSqlSeeds),
  project: Effect.sync(seedProject),
  session: (input) => Effect.sync(() => seedSession(input)),
  userMessage: (input) => Effect.sync(() => seedUserMessage(input)),
  compaction: (input) => Effect.sync(() => seedCompaction(input)),
}

sessionStorageContract("SessionStorageSql", SessionStorageSql.defaultLayer, sqlSeeds)

const memorySeeds: Seeds<never> = {
  reset: Effect.sync(() => {
    memoryState.sessions.clear()
    memoryState.messages.clear()
  }),
  project: Effect.void,
  session: (input) =>
    Effect.sync(() => {
      memoryState.sessions.set(input.id, makeSessionRow(input))
    }),
  userMessage: (input) =>
    Effect.sync(() => {
      appendMemoryMessage(makeUserMessage(input))
    }),
  compaction: (input) =>
    Effect.sync(() => {
      appendMemoryMessage(makeCompaction(input))
    }),
}

sessionStorageContract("SessionStorageMemory", SessionStorageMemory.layer(memoryState), memorySeeds)

function seedProject() {
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({
        id: projectID,
        worktree: "/tmp/project-session-storage",
        time_created: 1,
        time_updated: 1,
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run(),
  )
}

function resetSqlSeeds() {
  Database.use((db) => {
    db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionA)).run()
    db.delete(SessionTable)
      .where(or(eq(SessionTable.id, sessionA), eq(SessionTable.id, sessionB), eq(SessionTable.id, sessionC)))
      .run()
    db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run()
  })
}

function seedSession(input: { id: SessionID; title: string; directory?: string; path: string; updated: number }) {
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id: input.id,
        project_id: projectID,
        slug: input.title.toLowerCase(),
        directory: input.directory ?? "/tmp/project-session-storage",
        path: input.path,
        title: input.title,
        version: "test",
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        time_created: input.updated,
        time_updated: input.updated,
      })
      .run(),
  )
}

function seedUserMessage(input: { id: SessionMessage.ID; text: string; time: number }) {
  const encoded = encodeMessage(makeUserMessage(input))
  const { id: _, type: __, ...data } = encoded
  seedMessage(input.id, "user", input.time, data)
}

function seedCompaction(input: { id: SessionMessage.ID; summary: string; time: number }) {
  const encoded = encodeMessage(makeCompaction(input))
  const { id: _, type: __, ...data } = encoded
  seedMessage(input.id, "compaction", input.time, data)
}

function makeSessionRow(input: { id: SessionID; title: string; directory?: string; path: string; updated: number }) {
  return new SessionStorage.SessionRow({
    id: input.id,
    projectID,
    title: input.title,
    directory: input.directory ?? "/tmp/project-session-storage",
    path: input.path,
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
    time: {
      created: DateTime.makeUnsafe(input.updated),
      updated: DateTime.makeUnsafe(input.updated),
    },
  })
}

function makeUserMessage(input: { id: SessionMessage.ID; text: string; time: number }) {
  return new SessionMessage.User({
    id: input.id,
    type: "user",
    text: input.text,
    files: [],
    agents: [],
    references: [],
    time: { created: DateTime.makeUnsafe(input.time) },
  })
}

function makeCompaction(input: { id: SessionMessage.ID; summary: string; time: number }) {
  return new SessionMessage.Compaction({
    id: input.id,
    type: "compaction",
    reason: "manual",
    summary: input.summary,
    time: { created: DateTime.makeUnsafe(input.time) },
  })
}

function seedMessage(
  id: SessionMessage.ID,
  type: SessionMessage.Type,
  time: number,
  data: typeof SessionMessageTable.$inferInsert.data,
) {
  Database.use((db) =>
    db
      .insert(SessionMessageTable)
      .values({
        id,
        session_id: sessionA,
        type,
        time_created: time,
        time_updated: time,
        data,
      })
      .run(),
  )
}

function appendMemoryMessage(message: SessionMessage.Message) {
  const current = memoryState.messages.get(sessionA) ?? []
  current.push(message)
  memoryState.messages.set(sessionA, current)
}
