export * as SessionV2 from "./session"
export * from "./session/schema"

import { DateTime, Effect, Exit, Layer, Schema, Context, Stream, Scope } from "effect"
import { ListAnchor } from "@opencode-ai/schema/session"
import { and, asc, desc, eq, gt, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fileURLToPath } from "url"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { Snapshot } from "./snapshot"
import { SessionCompaction } from "./session/compaction"
import { SessionRevert } from "./session/revert"
import { Revert } from "@opencode-ai/schema/revert"
import { FSUtil } from "./fs-util"
import { FileSystem } from "./filesystem"
import { SessionDurable } from "@opencode-ai/schema/durable-event-manifest"
import { SkillV2 } from "./skill"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateBaseInput = {
  id?: SessionSchema.ID
  title?: string
  agent?: AgentV2.ID
  model?: ModelV2.Ref
}
type CreateInput = CreateBaseInput &
  ({ location: Location.Ref; parentID?: never } | { parentID: SessionSchema.ID; location?: never })

type CompactInput = {
  sessionID: SessionSchema.ID
}

type ForkInput = {
  sessionID: SessionSchema.ID
  messageID?: SessionMessage.ID
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "compact"]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export class BusyError extends Schema.TaggedErrorClass<BusyError>()("Session.BusyError", {
  sessionID: SessionSchema.ID,
}) {}
export class SkillNotFoundError extends Schema.TaggedErrorClass<SkillNotFoundError>()("Session.SkillNotFoundError", {
  skill: Schema.String,
}) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error =
  | NotFoundError
  | MessageDecodeError
  | OperationUnavailableError
  | PromptConflictError
  | BusyError
  | SkillNotFoundError
  | MessageNotFoundError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly fork: (input: ForkInput) => Effect.Effect<SessionSchema.Info, NotFoundError | MessageNotFoundError>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: string }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError>
  readonly rename: (input: { sessionID: SessionSchema.ID; title: string }) => Effect.Effect<void, NotFoundError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError>
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly skill: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, NotFoundError | SkillNotFoundError>
  readonly compact: (
    input: CompactInput,
  ) => Effect.Effect<void, NotFoundError | BusyError | MessageDecodeError | OperationUnavailableError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly synthetic: (input: { sessionID: SessionSchema.ID; text: string }) => Effect.Effect<void, NotFoundError>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Revert.State, NotFoundError | MessageNotFoundError | BusyError | Snapshot.Error>
    readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError | Snapshot.Error>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const scope = yield* Scope.Scope
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const result = Service.of({
      create: Effect.fn("V2Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const parent = input.parentID ? yield* store.get(input.parentID) : undefined
        if (input.parentID && parent === undefined) return yield* new NotFoundError({ sessionID: input.parentID })
        const location = parent?.location ?? input.location
        if (location === undefined)
          return yield* Effect.die(new Error("V2Session.create requires either location or an existing parentID"))
        const project = yield* projects.resolve(location.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const info = SessionV1.SessionInfo.make({
          id: sessionID,
          slug: Slug.create(),
          version: InstallationVersion,
          projectID: project.id,
          parentID: input.parentID,
          directory: location.directory,
          path: path.relative(project.directory, location.directory).replaceAll("\\", "/"),
          workspaceID: location.workspaceID ? WorkspaceV2.ID.make(location.workspaceID) : undefined,
          title: input.title ?? `New session - ${new Date(now).toISOString()}`,
          agent: input.agent,
          model: input.model
            ? {
                id: ModelV2.ID.make(input.model.id),
                providerID: input.model.providerID,
                variant: input.model.variant,
              }
            : undefined,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: now, updated: now },
        })
        const projected = yield* events.publish(SessionV1.Event.Created, { sessionID, info }, { location }).pipe(
          Effect.as({ type: "created" } as const),
          Effect.catchDefect((defect) => {
            if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
              return Effect.die(defect)
            }
            // Concurrent creation lost the projection race. The existing Session identity wins.
            return store
              .get(sessionID)
              .pipe(
                Effect.flatMap((session) =>
                  session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                ),
              )
          }),
        )
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      fork: Effect.fn("V2Session.fork")(function* (input) {
        const parent = yield* result.get(input.sessionID)
        const boundary = input.messageID
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.messageID && !boundary)
          return yield* new MessageNotFoundError({ sessionID: input.sessionID, messageID: input.messageID })
        const sessionID = SessionSchema.ID.create()
        yield* events.publish(SessionEvent.Forked, {
          sessionID,
          parentID: parent.id,
          messageID: input.messageID,
          timestamp: yield* DateTime.now,
        })
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.durable({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event))),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* EventV2.readAggregate(db, {
          ...input,
          aggregateID: input.sessionID,
          manifest: SessionDurable,
        })
      }),
      prompt: Effect.fn("V2Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* result.get(input.sessionID)
            // A staged revert must be committed before admitting new input so the prompt
            // continues from the reverted boundary rather than stale post-boundary history.
            if (session.revert)
              yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
            const hasFileURL = input.prompt.files?.some(
              (file) => URL.canParse(file.uri) && new URL(file.uri).protocol === "file:",
            )
            const prompt = !input.prompt.files?.length
              ? Prompt.make({ text: input.prompt.text, agents: input.prompt.agents })
              : hasFileURL
                ? yield* resolvePrompt(input.prompt).pipe(Effect.provide(locations.get(session.location)))
                : resolveInlinePrompt(input.prompt)
            const messageID = input.id ?? SessionMessage.ID.create()
            const delivery = input.delivery ?? "steer"
            const expected = { sessionID: input.sessionID, messageID, prompt, delivery }
            const admitted = yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              prompt,
              delivery,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionInput.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (!SessionInput.equivalent(admitted, expected))
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            if (input.resume !== false) yield* execution.wake(admitted.sessionID)
            return admitted
          }),
        ),
      ),
      shell: Effect.fn("V2Session.shell")(function* () {
        return yield* new OperationUnavailableError({ operation: "shell" })
      }),
      skill: Effect.fn("V2Session.skill")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const skills = yield* SkillV2.Service.pipe(Effect.provide(locations.get(session.location)))
        const skill = (yield* skills.list()).find((item) => item.name === input.skill)
        if (!skill) return yield* new SkillNotFoundError({ skill: input.skill })
        yield* events.publish(SessionEvent.Skill.Activated, {
          sessionID: input.sessionID,
          messageID: input.id ?? SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          name: skill.name,
          text: skill.content,
        })
        if (input.resume !== false)
          yield* execution
            .resume(input.sessionID)
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          agent: input.agent,
        })
      }),
      switchModel: Effect.fn("V2Session.switchModel")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (
          session.model?.providerID === input.model.providerID &&
          session.model.id === input.model.id &&
          (session.model.variant ?? "default") === (input.model.variant ?? "default")
        )
          return
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          model: input.model,
        })
      }),
      rename: Effect.fn("V2Session.rename")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.Renamed, {
          sessionID: input.sessionID,
          timestamp: yield* DateTime.now,
          title: input.title,
        })
      }),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        const session = yield* result.get(input.sessionID)
        // TODO: admit manual compaction as durable pending work, like prompt input, instead of rejecting active sessions.
        if ((yield* execution.active).has(input.sessionID)) return yield* new BusyError({ sessionID: input.sessionID })
        const context = yield* store.context(input.sessionID)
        const compacted = yield* Effect.gen(function* () {
          const compaction = yield* SessionCompaction.Service
          return yield* compaction.compactManual({ session, messages: context })
        }).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.catch(() => Effect.succeed(false)),
        )
        if (!compacted) return yield* new OperationUnavailableError({ operation: "compact" })
        return undefined
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.awaitIdle(sessionID)
      }),
      active: execution.active,
      resume: Effect.fn("V2Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
      synthetic: Effect.fn("V2Session.synthetic")(function* (input) {
        yield* result.get(input.sessionID)
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID: input.sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          text: input.text,
        })
        yield* execution
          .resume(input.sessionID)
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)
      }),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(execution.interrupt(sessionID)),
      ),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")(function* (input) {
          const session = yield* result.get(input.sessionID)
          if ((yield* execution.active).has(input.sessionID))
            return yield* new BusyError({ sessionID: input.sessionID })
          return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        clear: Effect.fn("V2Session.revert.clear")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          if ((yield* execution.active).has(sessionID)) return yield* new BusyError({ sessionID })
          return yield* SessionRevert.clear(session).pipe(
            Effect.provideService(EventV2.Service, events),
            Effect.provide(locations.get(session.location)),
          )
        }),
        commit: Effect.fn("V2Session.revert.commit")(function* (sessionID) {
          const session = yield* result.get(sessionID)
          if ((yield* execution.active).has(sessionID)) return yield* new BusyError({ sessionID })
          return yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
        }),
      },
    })

    return result
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(SessionStore.defaultLayer),
  Layer.provide(SessionProjector.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.orDie,
)

const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024
const MAX_DIRECTORY_ENTRIES = 200

const textMime = (mime: string) =>
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime === "application/xml" ||
  mime === "application/yaml" ||
  mime === "application/x-yaml" ||
  mime === "application/toml" ||
  mime === "application/x-toml" ||
  mime.endsWith("+json") ||
  mime.endsWith("+xml")

const mediaMime = (mime: string) => mime.startsWith("image/") || mime === "application/pdf"

const textExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
])

const textFile = (filepath: string, mime: string) => textMime(mime) || textExtensions.has(path.extname(filepath))

const dataMime = (uri: string) => uri.match(/^data:([^;,]+)[;,]/i)?.[1]?.toLowerCase()

function decodeDataText(uri: string) {
  const comma = uri.indexOf(",")
  if (comma === -1) return ""
  const header = uri.slice(0, comma).toLowerCase()
  const data = uri.slice(comma + 1)
  if (header.endsWith(";base64")) return Buffer.from(data, "base64").toString("utf8")
  return decodeURIComponent(data)
}

function formatAttachmentText(input: { name?: string; uri: string; text: string; truncated?: boolean }) {
  const title = input.name ?? input.uri
  const suffix = input.truncated ? "\n[Attachment truncated]" : ""
  return `<attachment name="${title}">\n${input.text}${suffix}\n</attachment>`
}

function selectedLines(text: string, url: URL) {
  const start = url.searchParams.get("start")
  if (start === null) return { text, truncated: text.length > MAX_TEXT_ATTACHMENT_BYTES }
  const startLine = Math.max(parseInt(start), 1)
  const end = url.searchParams.get("end")
  const endLine = end === null ? startLine : Math.max(parseInt(end), startLine)
  return {
    text: text
      .split("\n")
      .slice(startLine - 1, endLine)
      .join("\n"),
    truncated: false,
  }
}

function truncateAttachmentText(text: string, truncated: boolean) {
  if (text.length <= MAX_TEXT_ATTACHMENT_BYTES) return { text, truncated }
  return { text: text.slice(0, MAX_TEXT_ATTACHMENT_BYTES), truncated: true }
}

function attachmentError(input: { name?: string; uri: string; message: string }) {
  return formatAttachmentText({
    name: input.name,
    uri: input.uri,
    text: `[Unable to read attachment: ${input.message}]`,
  })
}

function resolveInlineFileAttachment(file: PromptInput.FileAttachment) {
  const mime = dataMime(file.uri)
  if (mime) {
    if (textMime(mime)) {
      return {
        file: {
          ...file,
          mime,
          description: formatAttachmentText({ name: file.name, uri: file.uri, text: decodeDataText(file.uri) }),
        },
      }
    }
    return { file: { ...file, mime } }
  }
  if (!URL.canParse(file.uri)) {
    return {
      file: {
        ...file,
        mime: "application/octet-stream",
        description: attachmentError({ name: file.name, uri: file.uri, message: "unsupported attachment URI" }),
      },
    }
  }
  const url = new URL(file.uri)
  const target = url.pathname || file.name || file.uri
  return { file: { ...file, mime: target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target) } }
}

function resolveInlinePrompt(input: PromptInput.Prompt) {
  const files = (input.files ?? []).map(resolveInlineFileAttachment)
  return Prompt.make({
    text: input.text,
    agents: input.agents,
    files: files.map((file) => file.file),
  })
}

const resolveFileAttachment = Effect.fn("Session.resolveFileAttachment")(function* (file: PromptInput.FileAttachment) {
  const mime = dataMime(file.uri)
  if (mime) {
    if (textMime(mime)) {
      return {
        file: {
          ...file,
          mime,
          description: formatAttachmentText({ name: file.name, uri: file.uri, text: decodeDataText(file.uri) }),
        },
      }
    }
    return { file: { ...file, mime } }
  }

  if (!URL.canParse(file.uri)) {
    return {
      file: {
        ...file,
        mime: "application/octet-stream",
        description: attachmentError({ name: file.name, uri: file.uri, message: "unsupported attachment URI" }),
      },
    }
  }

  const url = new URL(file.uri)
  if (url.protocol !== "file:") {
    const target = url.pathname || file.name || file.uri
    return { file: { ...file, mime: target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target) } }
  }

  const location = yield* Location.Service
  const filesystem = yield* FileSystem.Service
  const filepath = fileURLToPath(url)
  const relative = path.relative(location.directory, filepath)
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      file: {
        ...file,
        mime: FSUtil.mimeType(filepath),
        description: attachmentError({
          name: file.name ?? filepath,
          uri: file.uri,
          message: "file is outside the session location",
        }),
      },
    }
  }

  const target = RelativePath.make(relative.split(path.sep).join("/"))
  const listed = yield* filesystem.list({ path: target }).pipe(Effect.exit)
  if (Exit.isSuccess(listed)) {
    const entries = listed.value
    const visible = entries
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .map((entry) => `${entry.path}${entry.type === "directory" ? "/" : ""}`)
      .join("\n")
    return {
      file: {
        ...file,
        mime: "application/x-directory",
        description: formatAttachmentText({
          name: file.name ?? filepath,
          uri: file.uri,
          text: visible || "[Directory is empty]",
          truncated: entries.length > MAX_DIRECTORY_ENTRIES,
        }),
      },
    }
  }

  const read = yield* filesystem.read({ path: target }).pipe(Effect.exit)
  if (Exit.isFailure(read)) {
    return {
      file: {
        ...file,
        mime: FSUtil.mimeType(filepath),
        description: attachmentError({ name: file.name ?? filepath, uri: file.uri, message: "file not found" }),
      },
    }
  }
  const content = read.value

  if (textFile(filepath, content.mime)) {
    const selected = selectedLines(Buffer.from(content.content).toString("utf8"), url)
    const truncated = truncateAttachmentText(selected.text, selected.truncated)
    return {
      file: {
        ...file,
        mime: "text/plain",
        description: formatAttachmentText({ name: file.name ?? filepath, uri: file.uri, ...truncated }),
      },
    }
  }

  if (mediaMime(content.mime)) {
    return {
      file: {
        ...file,
        uri: `data:${content.mime};base64,${Buffer.from(content.content).toString("base64")}`,
        mime: content.mime,
      },
    }
  }

  return {
    file: {
      ...file,
      mime: content.mime,
      description: attachmentError({
        name: file.name ?? filepath,
        uri: file.uri,
        message: `unsupported file type ${content.mime}`,
      }),
    },
  }
})

const resolvePrompt = Effect.fn("Session.resolvePrompt")(function* (input: PromptInput.Prompt) {
  const files = yield* Effect.forEach(input.files ?? [], resolveFileAttachment, { concurrency: "unbounded" })
  return Prompt.make({
    text: input.text,
    agents: input.agents,
    files: files.map((file) => file.file),
  })
})

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionStore.node,
    LocationServiceMap.node,
    SessionProjector.node,
  ],
})
