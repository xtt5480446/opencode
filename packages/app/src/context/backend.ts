export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export type RequestOptions = {
  readonly signal?: AbortSignal
}

export type LocationRef = {
  readonly directory: string
  readonly workspaceID?: string
}

export type LocationInput = {
  readonly location?: LocationRef
}

export type ModelRef = {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export type Page<T> = {
  readonly items: readonly T[]
  /** Cursor for items older than this page. */
  readonly older?: string
  /** Cursor for items newer than this page. */
  readonly newer?: string
}

export type Health = {
  readonly healthy: boolean
  readonly version?: string
  readonly pid?: number
}

export type AppProject = {
  readonly id: string
  readonly worktree: string
  readonly vcs?: "git"
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly initialized?: number
  }
  readonly name?: string
  readonly icon?: {
    readonly url?: string
    readonly override?: string
    readonly color?: string
  }
  readonly commands?: {
    readonly start?: string
  }
  sandboxes: string[]
}

export type CurrentProject = {
  readonly id: string
  readonly directory: string
}

export type AppModel = {
  readonly id: string
  readonly providerID: string
  readonly name: string
  readonly family?: string
  readonly releaseDate?: string
  readonly cost?: {
    readonly input: number
    readonly output?: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
  }
  readonly capabilities: {
    readonly reasoning: boolean
    readonly input: {
      readonly text: boolean
      readonly image: boolean
      readonly audio: boolean
      readonly video: boolean
      readonly pdf: boolean
    }
  }
  readonly limit: {
    readonly context: number
    readonly output?: number
  }
  readonly variants?: Readonly<Record<string, unknown>>
}

export type AppProvider = {
  readonly id: string
  readonly name: string
  readonly source?: "env" | "config" | "custom" | "api"
  readonly integrationID?: string
  readonly models: Readonly<Record<string, AppModel>>
}

export type ProviderCatalog = {
  readonly providers: ReadonlyMap<string, AppProvider>
  readonly connected: readonly string[]
  readonly defaults: Readonly<Record<string, string>>
}

export type AppAgent = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly mode: "subagent" | "primary" | "all"
  readonly hidden: boolean
  readonly color?: string
  readonly model?: ModelRef
}

export type AppCommand = {
  readonly name: string
  readonly description?: string
  readonly source?: "command" | "mcp" | "skill"
}

export type AppReference = {
  readonly name: string
  readonly path: string
  readonly description?: string
  readonly hidden?: boolean
  readonly source:
    | {
        readonly type: "local"
        readonly path: string
      }
    | {
        readonly type: "git"
        readonly repository: string
        readonly branch?: string
      }
}

export type TokenUsage = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: {
    readonly read: number
    readonly write: number
  }
}

export type AppSession = {
  readonly id: string
  readonly slug: string
  readonly version: string
  readonly parentID?: string
  readonly projectID: string
  readonly location?: LocationRef
  readonly directory: string
  readonly workspaceID?: string
  title: string
  readonly cost?: number
  readonly tokens?: TokenUsage
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly archived?: number
  }
  readonly share?: {
    readonly url: string
  }
  readonly revert?: {
    readonly messageID: string
  }
}

export type SessionActivity =
  | { readonly type: "idle" }
  | { readonly type: "busy" }
  | { readonly type: "running" }
  | {
      readonly type: "retry"
      readonly attempt: number
      readonly message: string
      readonly next: number
      readonly action?: {
        readonly reason: string
        readonly provider: string
        readonly title: string
        readonly message: string
        readonly label: string
        readonly link?: string
      }
    }

export type SessionListInput = LocationInput & {
  readonly roots?: boolean
  readonly limit?: number
  readonly search?: string
  readonly cursor?: string
}

export type SourceText = {
  readonly text: string
  readonly start: number
  readonly end: number
}

export type FileSource =
  | {
      readonly type: "file" | "symbol"
      readonly path: string
      readonly name?: string
      readonly kind?: number
      readonly text: SourceText
    }
  | {
      readonly type: "resource"
      readonly clientName: string
      readonly uri: string
      readonly text: SourceText
    }

export type ToolState =
  | {
      readonly status: "pending"
      readonly input: Readonly<Record<string, unknown>>
      readonly raw: string
    }
  | {
      readonly status: "running"
      readonly input: Readonly<Record<string, unknown>>
      readonly title?: string
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly time: { readonly start: number }
      readonly content?: readonly ToolOutputContent[]
      readonly provider?: ToolProviderInfo
    }
  | {
      readonly status: "completed"
      readonly input: Readonly<Record<string, unknown>>
      readonly output: string
      readonly title: string
      readonly metadata: Readonly<Record<string, unknown>>
      readonly time: { readonly start: number; readonly end: number; readonly compacted?: number }
      readonly attachments?: AppFilePart[]
      readonly content?: readonly ToolOutputContent[]
      readonly outputPaths?: readonly string[]
      readonly result?: unknown
      readonly provider?: ToolProviderInfo
    }
  | {
      readonly status: "error"
      readonly input: Readonly<Record<string, unknown>>
      readonly error: string
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly time: { readonly start: number; readonly end: number }
      readonly content?: readonly ToolOutputContent[]
      readonly result?: unknown
      readonly provider?: ToolProviderInfo
    }

export type ToolOutputContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }

export type ToolProviderInfo = {
  readonly executed: boolean
  readonly metadata?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly resultMetadata?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export type AppMessage = AppUserMessage | AppAssistantMessage

export type AppUserMessage = {
  readonly id: string
  readonly sessionID: string
  readonly role: "user"
  readonly time: { readonly created: number }
  readonly format?:
    | { readonly type: "text" }
    | { readonly type: "json_schema"; readonly schema: Readonly<Record<string, unknown>>; readonly retryCount?: number }
  readonly summary?: {
    readonly title?: string
    readonly body?: string
    readonly diffs: (Omit<AppFileDiff, "file"> & { readonly file?: string })[]
  }
  readonly agent: string
  readonly model: { readonly providerID: string; readonly modelID: string; readonly variant?: string }
  readonly system?: string
  readonly tools?: Readonly<Record<string, boolean>>
}

export type AppAssistantMessage = {
  readonly id: string
  readonly sessionID: string
  readonly role: "assistant"
  readonly time: { readonly created: number; readonly completed?: number }
  readonly parentID: string
  readonly modelID: string
  readonly providerID: string
  readonly mode: string
  readonly agent: string
  readonly path: { readonly cwd: string; readonly root: string }
  readonly summary?: boolean
  readonly cost: number
  readonly tokens: TokenUsage & { readonly total?: number }
  readonly structured?: unknown
  readonly variant?: string
  readonly finish?: string
  readonly error?: AppMessageError
}

export type AppMessageError =
  | { readonly name: "ProviderAuthError"; readonly data: { readonly providerID: string; readonly message: string } }
  | { readonly name: "UnknownError"; readonly data: { readonly message: string; readonly ref?: string } }
  | { readonly name: "MessageOutputLengthError"; readonly data: Readonly<Record<string, unknown>> }
  | { readonly name: "MessageAbortedError"; readonly data: { readonly message: string } }
  | { readonly name: "StructuredOutputError"; readonly data: { readonly message: string; readonly retries: number } }
  | { readonly name: "ContextOverflowError"; readonly data: { readonly message: string; readonly responseBody?: string } }
  | { readonly name: "ContentFilterError"; readonly data: { readonly message: string } }
  | { readonly name: "APIError"; readonly data: { readonly message: string; readonly statusCode?: number; readonly isRetryable: boolean; readonly responseHeaders?: Readonly<Record<string, string>>; readonly responseBody?: string; readonly metadata?: Readonly<Record<string, string>> } }

export type AppRetryError = Extract<AppMessageError, { readonly name: "APIError" }>

export type AppSessionError = AppMessageError | { readonly type: "unknown"; readonly message: string }

type AppPartBase = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
}

export type AppFilePart = AppPartBase & {
  readonly type: "file"
  readonly mime: string
  readonly filename?: string
  readonly url: string
  readonly source?: AppFilePartSource
}

export type AppFilePartSource =
  | { readonly type: "file"; readonly path: string; readonly text: { readonly value: string; readonly start: number; readonly end: number } }
  | { readonly type: "symbol"; readonly path: string; readonly name: string; readonly kind: number; readonly range: { readonly start: { readonly line: number; readonly character: number }; readonly end: { readonly line: number; readonly character: number } }; readonly text: { readonly value: string; readonly start: number; readonly end: number } }
  | { readonly type: "resource"; readonly clientName: string; readonly uri: string; readonly text: { readonly value: string; readonly start: number; readonly end: number } }

export type AppPart =
  | (AppPartBase & { readonly type: "text"; readonly text: string; readonly synthetic?: boolean; readonly ignored?: boolean; readonly time?: { readonly start: number; readonly end?: number }; readonly metadata?: Readonly<Record<string, unknown>> })
  | (AppPartBase & { readonly type: "reasoning"; readonly text: string; readonly metadata?: Readonly<Record<string, unknown>>; readonly time: { readonly start: number; readonly end?: number } })
  | AppFilePart
  | (AppPartBase & { readonly type: "agent"; readonly name: string; readonly source?: { readonly value: string; readonly start: number; readonly end: number } })
  | (AppPartBase & { readonly type: "tool"; readonly callID: string; readonly tool: string; readonly state: ToolState; readonly metadata?: Readonly<Record<string, unknown>> })
  | (AppPartBase & { readonly type: "subtask"; readonly prompt: string; readonly description: string; readonly agent: string; readonly model?: { readonly providerID: string; readonly modelID: string }; readonly command?: string })
  | (AppPartBase & { readonly type: "step-start"; readonly snapshot?: string })
  | (AppPartBase & { readonly type: "step-finish"; readonly reason: string; readonly snapshot?: string; readonly cost: number; readonly tokens: TokenUsage & { readonly total?: number } })
  | (AppPartBase & { readonly type: "snapshot"; readonly snapshot: string })
  | (AppPartBase & { readonly type: "patch"; readonly hash: string; readonly files: string[] })
  | (AppPartBase & { readonly type: "retry"; readonly attempt: number; readonly error: AppRetryError; readonly time: { readonly created: number } })
  | (AppPartBase & { readonly type: "compaction"; readonly auto: boolean })

export type TimelineContent =
  | {
      readonly type: "text"
      readonly id: string
      readonly text: string
      readonly synthetic?: boolean
      readonly ignored?: boolean
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly time?: { readonly start: number; readonly end?: number }
    }
  | {
      readonly type: "reasoning"
      readonly id: string
      readonly text: string
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly time?: { readonly start: number; readonly end?: number }
    }
  | {
      readonly type: "file"
      readonly id: string
      readonly uri: string
      readonly name?: string
      readonly mime?: string
      readonly source?: FileSource
    }
  | {
      readonly type: "agent"
      readonly id: string
      readonly name: string
      readonly source?: SourceText
    }
  | {
      readonly type: "tool"
      readonly id: string
      readonly callID?: string
      readonly tool: string
      readonly state: ToolState
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | { readonly type: "subtask"; readonly id: string; readonly prompt: string; readonly description: string; readonly agent: string; readonly model?: ModelRef; readonly command?: string }
  | { readonly type: "step-start"; readonly id: string; readonly snapshot?: string }
  | { readonly type: "step-finish"; readonly id: string; readonly reason: string; readonly snapshot?: string; readonly cost: number; readonly tokens: TokenUsage & { readonly total?: number } }
  | { readonly type: "snapshot"; readonly id: string; readonly snapshot: string }
  | { readonly type: "patch"; readonly id: string; readonly hash: string; readonly files: string[] }
  | { readonly type: "retry"; readonly id: string; readonly attempt: number; readonly error: AppRetryError; readonly time: { readonly created: number } }
  | { readonly type: "compaction"; readonly id: string; readonly auto: boolean }

export type TimelineItem =
  | {
      readonly type: "user"
      readonly id: string
      readonly sessionID: string
      readonly created: number
      readonly content: readonly TimelineContent[]
      readonly agent?: string
      readonly model?: ModelRef
      readonly format?: AppUserMessage["format"]
      readonly summary?: AppUserMessage["summary"]
      readonly system?: string
      readonly tools?: Readonly<Record<string, boolean>>
    }
  | {
      readonly type: "assistant"
      readonly id: string
      readonly sessionID: string
      readonly parentID?: string
      readonly created: number
      readonly completed?: number
      readonly content: readonly TimelineContent[]
      readonly agent?: string
      readonly model?: ModelRef
      readonly tokens?: TokenUsage
      readonly error?: AppMessageError
      readonly mode?: string
      readonly path?: AppAssistantMessage["path"]
      readonly cost?: number
      readonly structured?: unknown
      readonly finish?: string
      readonly summary?: boolean
      readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: readonly string[] }
    }
  | {
      readonly type: "agent-switch" | "model-switch" | "synthetic" | "system" | "skill" | "shell" | "compaction"
      readonly id: string
      readonly sessionID: string
      readonly created: number
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly text?: string
      readonly reason?: "auto" | "manual"
      readonly summary?: string
      readonly recent?: string
      readonly callID?: string
      readonly command?: string
      readonly output?: string
    }

export function timelineMessage(item: TimelineItem): AppMessage | undefined {
  if (item.type === "user")
    return {
      id: item.id,
      sessionID: item.sessionID,
      role: "user",
      time: { created: item.created },
      format: item.format,
      summary: item.summary,
      agent: item.agent ?? "",
      model: {
        providerID: item.model?.providerID ?? "",
        modelID: item.model?.id ?? "",
        variant: item.model?.variant,
      },
      system: item.system,
      tools: item.tools,
    }
  if (item.type !== "assistant") return
  return {
    id: item.id,
    sessionID: item.sessionID,
    role: "assistant",
    time: { created: item.created, completed: item.completed },
    parentID: item.parentID ?? "",
    modelID: item.model?.id ?? "",
    providerID: item.model?.providerID ?? "",
    variant: item.model?.variant,
    mode: item.mode ?? item.agent ?? "",
    agent: item.agent ?? "",
    path: item.path ?? { cwd: "", root: "" },
    summary: item.summary,
    cost: item.cost ?? 0,
    tokens: item.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    structured: item.structured,
    finish: item.finish,
    error: item.error,
  }
}

export function timelineParts(item: TimelineItem): AppPart[] {
  if (item.type !== "user" && item.type !== "assistant") return []
  return item.content.map((content): AppPart => {
    const base = { id: content.id, sessionID: item.sessionID, messageID: item.id }
    if (content.type === "file")
      return {
        ...base,
        type: content.type,
        mime: content.mime ?? "application/octet-stream",
        filename: content.name,
        url: content.uri,
        source:
          content.source?.type === "resource"
            ? {
                type: content.source.type,
                clientName: content.source.clientName,
                uri: content.source.uri,
                text: {
                  value: content.source.text.text,
                  start: content.source.text.start,
                  end: content.source.text.end,
                },
              }
            : content.source?.type === "symbol"
              ? {
                  type: content.source.type,
                  path: content.source.path,
                  name: content.source.name ?? "",
                  kind: content.source.kind ?? 0,
                  range: {
                    start: { line: 0, character: content.source.text.start },
                    end: { line: 0, character: content.source.text.end },
                  },
                  text: {
                    value: content.source.text.text,
                    start: content.source.text.start,
                    end: content.source.text.end,
                  },
                }
              : content.source && {
                  type: "file",
                  path: content.source.path,
                  text: {
                    value: content.source.text.text,
                    start: content.source.text.start,
                    end: content.source.text.end,
                  },
                },
      }
    if (content.type === "agent")
      return {
        ...base,
        type: content.type,
        name: content.name,
        source: content.source && {
          value: content.source.text,
          start: content.source.start,
          end: content.source.end,
        },
      }
    if (content.type === "tool")
      return {
        ...base,
        type: content.type,
        callID: content.callID ?? content.id,
        tool: content.tool,
        state: content.state,
        metadata: content.metadata,
      }
    if (content.type === "subtask")
      return {
        ...base,
        ...content,
        model: content.model && { providerID: content.model.providerID, modelID: content.model.id },
      }
    if (content.type === "reasoning")
      return {
        ...base,
        ...content,
        time: content.time ?? {
          start: item.created,
          end: item.type === "assistant" ? item.completed : undefined,
        },
      }
    return { ...base, ...content }
  })
}

export type PromptFile = {
  readonly uri: string
  readonly name?: string
  readonly mime?: string
  readonly source?: SourceText & {
    readonly path?: string
  }
}

export type PromptAgentMention = {
  readonly name: string
  readonly start?: number
  readonly end?: number
  readonly text?: string
}

export type PromptPart =
  | {
      readonly id: string
      readonly type: "text"
      readonly text: string
      readonly synthetic?: boolean
      readonly ignored?: boolean
      readonly time?: { readonly start: number; readonly end?: number }
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | {
      readonly id: string
      readonly type: "file"
      readonly mime: string
      readonly url: string
      readonly filename?: string
      readonly source?:
        | {
            readonly type: "file"
            readonly path: string
            readonly text: { readonly value: string; readonly start: number; readonly end: number }
          }
        | {
            readonly type: "symbol"
            readonly path: string
            readonly name: string
            readonly kind: number
            readonly range: {
              readonly start: { readonly line: number; readonly character: number }
              readonly end: { readonly line: number; readonly character: number }
            }
            readonly text: { readonly value: string; readonly start: number; readonly end: number }
          }
        | {
            readonly type: "resource"
            readonly clientName: string
            readonly uri: string
            readonly text: { readonly value: string; readonly start: number; readonly end: number }
          }
    }
  | {
      readonly id: string
      readonly type: "agent"
      readonly name: string
      readonly source?: { readonly value: string; readonly start: number; readonly end: number }
    }

export type PromptInput = LocationInput & {
  readonly sessionID: string
  readonly id: string
  readonly text: string
  readonly files?: readonly PromptFile[]
  readonly agents?: readonly PromptAgentMention[]
  readonly parts?: readonly PromptPart[]
  readonly selection?: {
    readonly agent?: string
    readonly model?: ModelRef
  }
  readonly delivery?: "steer" | "queue"
}

export type CommandInput = LocationInput & {
  readonly sessionID: string
  readonly id?: string
  readonly command: string
  readonly arguments?: string
  readonly agent?: string
  readonly model?: ModelRef
  readonly files?: readonly PromptFile[]
  readonly delivery?: "steer" | "queue"
}

export type FileEntry = {
  readonly path: string
  readonly name?: string
  readonly absolute?: string
  readonly type: "file" | "directory"
}

export type AppFileNode = {
  readonly name: string
  readonly path: string
  readonly absolute: string
  readonly type: "file" | "directory"
  readonly ignored: boolean
}

export type FileContent = {
  readonly bytes: Uint8Array
  readonly kind?: "text" | "binary"
  readonly mimeType?: string
}

export type AppFileDiff = {
  readonly file: string
  readonly patch?: string
  readonly additions: number
  readonly deletions: number
  readonly status?: "added" | "deleted" | "modified"
}

export type AppSnapshotFileDiff = Omit<AppFileDiff, "file"> & { readonly file?: string }
export type AppVcsFileDiff = AppFileDiff

export type AppPermissionRequest = {
  readonly id: string
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
  readonly permission: string
  readonly patterns: string[]
  readonly always: string[]
  readonly metadata: Record<string, unknown>
}

export type AppQuestion = {
  readonly question: string
  readonly header: string
  readonly options: {
    readonly label: string
    readonly description: string
  }[]
  readonly multiple?: boolean
  readonly custom?: boolean
}

export type AppQuestionRequest = {
  readonly id: string
  readonly sessionID: string
  readonly questions: AppQuestion[]
}

export type AppQuestionAnswer = string[]

export type AppSessionNotFoundError = {
  readonly _tag: "SessionNotFoundError"
  readonly sessionID: string
  readonly message: string
}

export type AppMcpStatus =
  | { readonly status: "connected" }
  | { readonly status: "pending" }
  | { readonly status: "disabled" }
  | { readonly status: "needs_auth" }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "needs_client_registration"; readonly error: string }

export type AppMcpServer = {
  readonly name: string
  readonly status: AppMcpStatus
  readonly integrationID?: string
}

export type AppMcpResource = {
  readonly server: string
  readonly name: string
  readonly uri: string
  readonly description?: string
  readonly mimeType?: string
}

export type AppMcpResourceTemplate = {
  readonly server: string
  readonly name: string
  readonly uriTemplate: string
  readonly description?: string
  readonly mimeType?: string
}

export type AppPty = {
  readonly id: string
  readonly title: string
}

export type AppEventEnvelope = {
  readonly location?: LocationRef
  readonly event: AppEvent
}

export type AppEvent =
  | { readonly type: "server.connected" }
  | { readonly type: "server.disposed"; readonly location?: LocationRef }
  | { readonly type: "instance.disposed"; readonly location: LocationRef }
  | { readonly type: "project.updated"; readonly project: AppProject }
  | { readonly type: "session.created"; readonly session: AppSession }
  | { readonly type: "session.updated"; readonly session: AppSession }
  | { readonly type: "session.deleted"; readonly sessionID: string }
  | { readonly type: "session.moved"; readonly sessionID: string; readonly location: LocationRef }
  | { readonly type: "session.revert"; readonly sessionID: string; readonly revert?: { readonly messageID: string } }
  | {
      readonly type: "session.activity"
      readonly sessionID: string
      readonly activity: SessionActivity
      readonly item?: TimelineItem
    }
  | { readonly type: "session.diff"; readonly sessionID: string; readonly diff: readonly AppFileDiff[] }
  | { readonly type: "todo.updated"; readonly sessionID: string; readonly todos: readonly AppTodo[] }
  | { readonly type: "session.error"; readonly sessionID?: string; readonly error?: AppSessionError }
  | { readonly type: "timeline.updated"; readonly item: TimelineItem }
  | {
      readonly type: "timeline.content.updated"
      readonly sessionID: string
      readonly itemID: string
      readonly content: TimelineContent
    }
  | { readonly type: "timeline.removed"; readonly sessionID: string; readonly itemID: string }
  | {
      readonly type: "timeline.delta"
      readonly sessionID: string
      readonly itemID: string
      readonly contentID: string
      readonly field: string
      readonly delta: string
    }
  | {
      readonly type: "timeline.part.removed"
      readonly sessionID: string
      readonly itemID: string
      readonly contentID: string
    }
  | { readonly type: "permission.requested"; readonly request: AppPermissionRequest }
  | { readonly type: "permission.replied"; readonly sessionID: string; readonly requestID: string }
  | { readonly type: "question.requested"; readonly request: AppQuestionRequest }
  | { readonly type: "question.replied" | "question.rejected"; readonly sessionID: string; readonly requestID: string }
  | { readonly type: "file.changed"; readonly path: string; readonly change: "add" | "change" | "unlink" }
  | { readonly type: "vcs.branch.updated"; readonly branch?: string }
  | { readonly type: "worktree.ready"; readonly name: string; readonly branch?: string }
  | { readonly type: "worktree.failed"; readonly message: string }
  | { readonly type: "lsp.updated" }
  | { readonly type: "reference.updated" }
  | { readonly type: "mcp.updated"; readonly server?: string }
  | { readonly type: "provider.updated" }
  | { readonly type: "pty.exited"; readonly ptyID: string }
  | { readonly type: "unknown"; readonly raw: unknown }

export interface HealthApi {
  get(options?: RequestOptions): Promise<Health>
}

export interface ProjectApi {
  current(input?: LocationInput, options?: RequestOptions): Promise<CurrentProject>
}

export interface ProjectListCapability {
  list(options?: RequestOptions): Promise<readonly AppProject[]>
}

export interface CatalogApi {
  providers(input?: LocationInput, options?: RequestOptions): Promise<ProviderCatalog>
  agents(input?: LocationInput, options?: RequestOptions): Promise<readonly AppAgent[]>
}

export interface CommandApi {
  list(input?: LocationInput, options?: RequestOptions): Promise<readonly AppCommand[]>
}

export interface ReferenceApi {
  list(input?: LocationInput, options?: RequestOptions): Promise<readonly AppReference[]>
}

export interface SessionApi {
  list(input?: SessionListInput, options?: RequestOptions): Promise<Page<AppSession>>
  create(
    input?: LocationInput & { readonly agent?: string; readonly model?: ModelRef },
    options?: RequestOptions,
  ): Promise<AppSession>
  get(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<AppSession>
  interrupt(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<void>
  activity(input?: LocationInput, options?: RequestOptions): Promise<Readonly<Record<string, SessionActivity>>>
  history(
    input: LocationInput & { readonly sessionID: string; readonly limit?: number; readonly cursor?: string },
    options?: RequestOptions,
  ): Promise<Page<TimelineItem>>
  message(
    input: LocationInput & { readonly sessionID: string; readonly messageID: string },
    options?: RequestOptions,
  ): Promise<TimelineItem>
  prompt(input: PromptInput, options?: RequestOptions): Promise<void>
}

export interface SessionActionsV1Capability {
  remove(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<boolean>
  fork(
    input: LocationInput & { readonly sessionID: string; readonly messageID?: string },
    options?: RequestOptions,
  ): Promise<AppSession>
  rename(
    input: LocationInput & { readonly sessionID: string; readonly title: string },
    options?: RequestOptions,
  ): Promise<void>
  command(input: CommandInput, options?: RequestOptions): Promise<void>
}

export interface FileApi {
  list(input: LocationInput & { readonly path?: string }, options?: RequestOptions): Promise<readonly AppFileNode[]>
  find(
    input: LocationInput & {
      readonly query: string
      readonly type?: "file" | "directory"
      readonly limit?: number
    },
    options?: RequestOptions,
  ): Promise<readonly FileEntry[]>
  read(input: LocationInput & { readonly path: string }, options?: RequestOptions): Promise<FileContent>
}

export interface PermissionApi {
  pending(input?: LocationInput, options?: RequestOptions): Promise<readonly AppPermissionRequest[]>
  reply(
    input: LocationInput & {
      readonly sessionID: string
      readonly requestID: string
      readonly reply: "once" | "always" | "reject"
      readonly message?: string
    },
    options?: RequestOptions,
  ): Promise<void>
}

export interface QuestionApi {
  pending(input?: LocationInput, options?: RequestOptions): Promise<readonly AppQuestionRequest[]>
  reply(
    input: LocationInput & {
      readonly sessionID: string
      readonly requestID: string
      readonly answers: readonly (readonly string[])[]
    },
    options?: RequestOptions,
  ): Promise<void>
  reject(
    input: LocationInput & { readonly sessionID: string; readonly requestID: string },
    options?: RequestOptions,
  ): Promise<void>
}

export interface VcsApi {
  status(
    input?: LocationInput,
    options?: RequestOptions,
  ): Promise<
    readonly {
      readonly file: string
      readonly additions: number
      readonly deletions: number
      readonly status: "added" | "deleted" | "modified"
    }[]
  >
  diff(
    input: LocationInput & { readonly mode: "working" | "branch"; readonly context?: number },
    options?: RequestOptions,
  ): Promise<readonly AppFileDiff[]>
}

export interface McpApi {
  list(input?: LocationInput, options?: RequestOptions): Promise<readonly AppMcpServer[]>
  resources(
    input?: LocationInput,
    options?: RequestOptions,
  ): Promise<{
    readonly resources: readonly AppMcpResource[]
    readonly templates: readonly AppMcpResourceTemplate[]
  }>
}

export interface PtyApi {
  list(input?: LocationInput, options?: RequestOptions): Promise<readonly AppPty[]>
  create(
    input: LocationInput & {
      readonly title?: string
      readonly command?: string
      readonly args?: readonly string[]
      readonly cwd?: string
      readonly env?: Readonly<Record<string, string>>
    },
    options?: RequestOptions,
  ): Promise<AppPty>
  get(input: LocationInput & { readonly ptyID: string }, options?: RequestOptions): Promise<AppPty>
  update(
    input: LocationInput & {
      readonly ptyID: string
      readonly title?: string
      readonly size?: { readonly rows: number; readonly cols: number }
    },
    options?: RequestOptions,
  ): Promise<AppPty>
  remove(input: LocationInput & { readonly ptyID: string }, options?: RequestOptions): Promise<void>
}

export interface EventApi {
  subscribe(options?: RequestOptions): AsyncIterable<AppEventEnvelope>
}

export interface CommonClient {
  readonly health: HealthApi
  readonly projects: ProjectApi
  readonly catalog: CatalogApi
  readonly commands: CommandApi
  readonly references: ReferenceApi
  readonly sessions: SessionApi
  readonly files: FileApi
  readonly permissions: PermissionApi
  readonly questions: QuestionApi
  readonly pty: PtyApi
  readonly events: EventApi
}

export type AppProviderConfig = {
  readonly npm?: string
  readonly name?: string
  readonly env?: readonly string[]
  readonly options?: {
    readonly baseURL?: string
    readonly headers?: Readonly<Record<string, string>>
    readonly [key: string]: unknown
  }
  readonly models?: Readonly<Record<string, { readonly name?: string }>>
}

export type AppConfig = {
  readonly shell?: string
  readonly model?: string
  readonly share?: "manual" | "auto" | "disabled"
  readonly plugin?: readonly (string | readonly [string, Readonly<Record<string, unknown>>])[]
  readonly disabledProviders?: readonly string[]
  readonly provider?: Readonly<Record<string, AppProviderConfig>>
  readonly permission?: unknown
}

export interface ConfigurationCapability {
  getGlobal(options?: RequestOptions): Promise<AppConfig>
  updateGlobal(config: AppConfig, options?: RequestOptions): Promise<void>
  get(input?: LocationInput, options?: RequestOptions): Promise<AppConfig>
}

export type ProviderAuthPrompt =
  | {
      readonly type: "text"
      readonly key: string
      readonly message: string
      readonly placeholder?: string
      readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
    }
  | {
      readonly type: "select"
      readonly key: string
      readonly message: string
      readonly options: readonly { readonly label: string; readonly value: string; readonly hint?: string }[]
      readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
    }

export type ProviderAuthMethod = {
  readonly type: "oauth" | "api"
  readonly label: string
  readonly prompts?: readonly ProviderAuthPrompt[]
}

export type AppProviderAuthResponse = Readonly<Record<string, readonly ProviderAuthMethod[]>>

export type ProviderAuthorization = {
  readonly url: string
  readonly method: "auto" | "code"
  readonly instructions: string
}

export interface ProviderAuthV1Capability {
  methods(
    input?: LocationInput,
    options?: RequestOptions,
  ): Promise<Readonly<Record<string, readonly ProviderAuthMethod[]>>>
  authorize(
    input: LocationInput & {
      readonly providerID: string
      readonly method: number
      readonly values?: Readonly<Record<string, string>>
    },
    options?: RequestOptions,
  ): Promise<ProviderAuthorization>
  callback(
    input: LocationInput & { readonly providerID: string; readonly method: number; readonly code?: string },
    options?: RequestOptions,
  ): Promise<void>
  setApiKey(
    input: {
      readonly providerID: string
      readonly key: string
      readonly metadata?: Readonly<Record<string, string>>
    },
    options?: RequestOptions,
  ): Promise<void>
  remove(input: { readonly providerID: string }, options?: RequestOptions): Promise<void>
}

export interface ProjectEditingCapability {
  update(
    input: LocationInput & {
      readonly projectID: string
      readonly name?: string
      readonly icon?: { readonly override?: string; readonly color?: string }
      readonly commands?: { readonly start?: string }
    },
    options?: RequestOptions,
  ): Promise<AppProject>
  initGit(input?: LocationInput, options?: RequestOptions): Promise<AppProject>
}

export type AppWorktree = {
  readonly directory: string
  readonly branch?: string
}

export interface WorktreesV1Capability {
  list(input: LocationInput, options?: RequestOptions): Promise<readonly string[]>
  create(input: LocationInput, options?: RequestOptions): Promise<AppWorktree>
  remove(input: LocationInput & { readonly directory: string }, options?: RequestOptions): Promise<boolean>
  reset(input: LocationInput & { readonly directory: string }, options?: RequestOptions): Promise<boolean>
}

export type AppTodo = {
  readonly id?: string
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed" | "cancelled" | (string & {})
  readonly priority: "high" | "medium" | "low" | (string & {})
}

export type LegacySessionShellInput = LocationInput & {
  readonly sessionID: string
  readonly id?: string
  readonly command: string
  readonly agent: string
  readonly model?: ModelRef
}

export interface SessionExtrasV1Capability {
  archive(
    input: LocationInput & { readonly sessionID: string; readonly archivedAt: number },
    options?: RequestOptions,
  ): Promise<void>
  share(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<string>
  unshare(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<void>
  diff(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<readonly AppFileDiff[]>
  todos(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<readonly AppTodo[]>
  summarize(
    input: LocationInput & { readonly sessionID: string; readonly model: ModelRef },
    options?: RequestOptions,
  ): Promise<void>
  revert(
    input: LocationInput & { readonly sessionID: string; readonly messageID: string },
    options?: RequestOptions,
  ): Promise<AppSession>
  clearRevert(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<AppSession>
  shell(input: LegacySessionShellInput, options?: RequestOptions): Promise<void>
}

export type AppLspStatus = {
  readonly id: string
  readonly name: string
  readonly status: "connected" | "error"
}

export interface LspCapability {
  status(input?: LocationInput, options?: RequestOptions): Promise<readonly AppLspStatus[]>
}

export interface McpControlCapability {
  connect(input: LocationInput & { readonly name: string }, options?: RequestOptions): Promise<void>
  disconnect(input: LocationInput & { readonly name: string }, options?: RequestOptions): Promise<void>
  authenticate(input: LocationInput & { readonly name: string }, options?: RequestOptions): Promise<void>
}

export type AppPathInfo = {
  readonly home: string
  readonly directory: string
  readonly state?: string
  readonly config?: string
  readonly worktree?: string
}

export interface PathInfoCapability {
  get(input?: LocationInput, options?: RequestOptions): Promise<AppPathInfo>
}

export type AppVcsInfo = {
  readonly branch?: string
  readonly defaultBranch?: string
}

export interface VcsInfoCapability {
  get(input?: LocationInput, options?: RequestOptions): Promise<AppVcsInfo>
}

export type DecoratedFileContent = {
  readonly type: "text" | "binary"
  readonly content: string
  readonly diff?: string
  readonly encoding?: "base64"
  readonly mimeType?: string
  readonly patch?: {
    readonly oldFileName: string
    readonly newFileName: string
    readonly oldHeader?: string
    readonly newHeader?: string
    readonly hunks: readonly {
      readonly oldStart: number
      readonly oldLines: number
      readonly newStart: number
      readonly newLines: number
      readonly lines: readonly string[]
    }[]
    readonly index?: string
  }
}

export interface DecoratedFileCapability {
  read(input: LocationInput & { readonly path: string }, options?: RequestOptions): Promise<DecoratedFileContent>
}

export type PtyTicket = {
  readonly status: number
  readonly ticket?: string
}

export type PtyTransportConfig = {
  readonly baseUrl: string
  readonly fetch: typeof globalThis.fetch
  readonly username?: string
  readonly password?: string
  readonly sameOrigin: boolean
  readonly authToken: boolean
}

export interface PtyTransportCapability {
  connectToken(input: LocationInput & { readonly ptyID: string }, options?: RequestOptions): Promise<PtyTicket>
  exists(input: LocationInput & { readonly ptyID: string }, options?: RequestOptions): Promise<boolean>
  connectURL(input: {
    readonly ptyID: string
    readonly location: LocationRef
    readonly cursor: number
    readonly ticket?: string
  }): URL
}

export type ShellOption = {
  readonly name: string
  readonly path: string
  readonly acceptable: boolean
}

export interface ShellDiscoveryCapability {
  list(input?: LocationInput, options?: RequestOptions): Promise<readonly ShellOption[]>
}

export interface RuntimeV1Capability {
  disposeLocation(input: LocationInput, options?: RequestOptions): Promise<void>
  disposeAll(options?: RequestOptions): Promise<void>
}

export type IntegrationMethod =
  | {
      readonly type: "oauth"
      readonly id: string
      readonly label: string
      readonly prompts?: readonly ProviderAuthPrompt[]
    }
  | {
      readonly type: "key"
      readonly label: string
    }
  | {
      readonly type: "environment"
      readonly label: string
    }

export type IntegrationConnection = {
  readonly id: string
  readonly label: string
  readonly kind: "credential" | "environment"
}

export function credentialConnectionIDs(connections: readonly IntegrationConnection[]) {
  return connections.filter((connection) => connection.kind === "credential").map((connection) => connection.id)
}

export type IntegrationInfo = {
  readonly id: string
  readonly name: string
  readonly methods: readonly IntegrationMethod[]
  readonly connections: readonly IntegrationConnection[]
}

export type IntegrationAttempt = {
  readonly attemptID: string
  readonly url: string
  readonly instructions: string
  readonly mode: "auto" | "code"
  readonly time: {
    readonly created: number
    readonly expires: number
  }
}

export type IntegrationAttemptStatus =
  | { readonly status: "pending" }
  | { readonly status: "complete" }
  | { readonly status: "failed"; readonly error?: string }
  | { readonly status: "expired" }

export interface IntegrationsV2Capability {
  list(input?: LocationInput, options?: RequestOptions): Promise<readonly IntegrationInfo[]>
  get(
    input: LocationInput & { readonly integrationID: string },
    options?: RequestOptions,
  ): Promise<IntegrationInfo | null>
  connectKey(
    input: LocationInput & { readonly integrationID: string; readonly key: string; readonly label?: string },
    options?: RequestOptions,
  ): Promise<void>
  connectOauth(
    input: LocationInput & {
      readonly integrationID: string
      readonly methodID: string
      readonly values: Readonly<Record<string, string>>
      readonly label?: string
    },
    options?: RequestOptions,
  ): Promise<IntegrationAttempt>
  attemptStatus(
    input: LocationInput & { readonly attemptID: string },
    options?: RequestOptions,
  ): Promise<IntegrationAttemptStatus>
  completeAttempt(
    input: LocationInput & { readonly attemptID: string; readonly code?: string },
    options?: RequestOptions,
  ): Promise<void>
  cancelAttempt(input: LocationInput & { readonly attemptID: string }, options?: RequestOptions): Promise<void>
  renameCredential(
    input: LocationInput & { readonly credentialID: string; readonly label: string },
    options?: RequestOptions,
  ): Promise<void>
  removeCredential(input: LocationInput & { readonly credentialID: string }, options?: RequestOptions): Promise<void>
}

export type PendingSessionInput = {
  readonly id: string
  readonly sessionID: string
  readonly sequence: number
  readonly created: number
  readonly delivery?: "steer" | "queue"
  readonly raw: unknown
}

export type SessionLogItem = {
  readonly sequence: number
  readonly event: AppEvent | { readonly type: "unknown"; readonly raw: unknown }
}

export type InstructionEntry = {
  readonly key: string
  readonly value: JsonValue
}

export interface SessionExtrasV2Capability {
  diff?(
    input: LocationInput & { readonly sessionID: string },
    options?: RequestOptions,
  ): Promise<readonly AppFileDiff[]>
  todos?(
    input: LocationInput & { readonly sessionID: string },
    options?: RequestOptions,
  ): Promise<readonly AppTodo[]>
  switchAgent(
    input: LocationInput & { readonly sessionID: string; readonly agent: string },
    options?: RequestOptions,
  ): Promise<void>
  switchModel(
    input: LocationInput & { readonly sessionID: string; readonly model: ModelRef },
    options?: RequestOptions,
  ): Promise<void>
  move?(
    input: LocationInput & { readonly sessionID: string; readonly directory: string; readonly moveChanges?: boolean },
    options?: RequestOptions,
  ): Promise<void>
  skill?(
    input: LocationInput & {
      readonly sessionID: string
      readonly id?: string
      readonly skill: string
      readonly resume?: boolean
    },
    options?: RequestOptions,
  ): Promise<void>
  synthetic?(
    input: LocationInput & {
      readonly sessionID: string
      readonly id?: string
      readonly text: string
      readonly description?: string
      readonly metadata?: Readonly<Record<string, JsonValue>>
      readonly delivery?: "steer" | "queue"
      readonly resume?: boolean
    },
    options?: RequestOptions,
  ): Promise<PendingSessionInput>
  shell?(
    input: LocationInput & { readonly sessionID: string; readonly id?: string; readonly command: string },
    options?: RequestOptions,
  ): Promise<void>
  compact?(
    input: LocationInput & { readonly sessionID: string; readonly id?: string },
    options?: RequestOptions,
  ): Promise<PendingSessionInput>
  wait(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<void>
  context(
    input: LocationInput & { readonly sessionID: string },
    options?: RequestOptions,
  ): Promise<readonly TimelineItem[]>
  pending?(
    input: LocationInput & { readonly sessionID: string },
    options?: RequestOptions,
  ): Promise<readonly PendingSessionInput[]>
  instructionEntries?(
    input: LocationInput & { readonly sessionID: string },
    options?: RequestOptions,
  ): Promise<readonly InstructionEntry[]>
  putInstructionEntry?(
    input: LocationInput & { readonly sessionID: string; readonly key: string; readonly value: JsonValue },
    options?: RequestOptions,
  ): Promise<void>
  removeInstructionEntry?(
    input: LocationInput & { readonly sessionID: string; readonly key: string },
    options?: RequestOptions,
  ): Promise<void>
  log(
    input: LocationInput & { readonly sessionID: string; readonly after?: number; readonly follow?: boolean },
    options?: RequestOptions,
  ): AsyncIterable<SessionLogItem>
  background?(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<void>
  stageRevert(
    input: LocationInput & {
      readonly sessionID: string
      readonly messageID: string
      readonly files?: readonly string[]
    },
    options?: RequestOptions,
  ): Promise<{ readonly messageID: string }>
  clearRevert(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<void>
  commitRevert(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<void>
}

export type ProjectDirectory = {
  readonly directory: string
  readonly strategy?: string
}

export interface ProjectCopiesV2Capability {
  directories?(
    input: LocationInput & { readonly projectID: string },
    options?: RequestOptions,
  ): Promise<readonly ProjectDirectory[]>
  create(
    input: LocationInput & {
      readonly projectID: string
      readonly strategy: string
      readonly directory: string
      readonly name?: string
    },
    options?: RequestOptions,
  ): Promise<{ readonly directory: string }>
  remove(
    input: LocationInput & { readonly projectID: string; readonly directory: string; readonly force: boolean },
    options?: RequestOptions,
  ): Promise<void>
  refresh(input: LocationInput & { readonly projectID: string }, options?: RequestOptions): Promise<void>
}

export type FormField =
  | {
      readonly type: "string"
      readonly key: string
      readonly label: string
      readonly required?: boolean
      readonly description?: string
    }
  | {
      readonly type: "number" | "integer"
      readonly key: string
      readonly label: string
      readonly required?: boolean
      readonly description?: string
    }
  | {
      readonly type: "boolean"
      readonly key: string
      readonly label: string
      readonly description?: string
    }
  | {
      readonly type: "multiselect"
      readonly key: string
      readonly label: string
      readonly options: readonly string[]
      readonly required?: boolean
      readonly description?: string
    }
  | {
      readonly type: "external"
      readonly key: string
      readonly label: string
      readonly url: string
      readonly description?: string
    }

export type FormInfo = {
  readonly id: string
  readonly sessionID: string
  readonly title: string
  readonly metadata?: Readonly<Record<string, JsonValue>>
  readonly fields: readonly FormField[]
}

export type FormAnswer = Readonly<Record<string, string | number | boolean | readonly string[]>>

export type FormState =
  | { readonly status: "pending" }
  | { readonly status: "answered"; readonly answer: FormAnswer }
  | { readonly status: "cancelled" }

export interface FormsV2Capability {
  pending(input?: LocationInput, options?: RequestOptions): Promise<readonly FormInfo[]>
  list(input: { readonly sessionID: string }, options?: RequestOptions): Promise<readonly FormInfo[]>
  create(
    input: {
      readonly sessionID: string
      readonly id?: string
      readonly title: string
      readonly metadata?: Readonly<Record<string, JsonValue>>
      readonly fields: readonly FormField[]
    },
    options?: RequestOptions,
  ): Promise<FormInfo>
  get(input: { readonly sessionID: string; readonly formID: string }, options?: RequestOptions): Promise<FormInfo>
  state(input: { readonly sessionID: string; readonly formID: string }, options?: RequestOptions): Promise<FormState>
  reply(
    input: { readonly sessionID: string; readonly formID: string; readonly answer: FormAnswer },
    options?: RequestOptions,
  ): Promise<void>
  cancel(input: { readonly sessionID: string; readonly formID: string }, options?: RequestOptions): Promise<void>
}

export type SavedPermission = {
  readonly id: string
  readonly projectID: string
  readonly action: string
  readonly resource: string
}

export interface SavedPermissionsV2Capability {
  list(input?: { readonly projectID?: string }, options?: RequestOptions): Promise<readonly SavedPermission[]>
  remove(input: { readonly id: string }, options?: RequestOptions): Promise<void>
}

export type ShellProcess = {
  readonly id: string
  readonly command: string
  readonly cwd: string
  readonly status: "running" | "exited"
  readonly created: number
  readonly exitCode?: number
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

export type ShellOutput = {
  readonly output: string
  readonly cursor: number
  readonly size: number
  readonly truncated: boolean
}

export interface ShellsV2Capability {
  list(input?: LocationInput, options?: RequestOptions): Promise<readonly ShellProcess[]>
  create(
    input: LocationInput & {
      readonly command: string
      readonly cwd?: string
      readonly timeout: number
      readonly metadata?: Readonly<Record<string, JsonValue>>
    },
    options?: RequestOptions,
  ): Promise<ShellProcess>
  get(input: LocationInput & { readonly id: string }, options?: RequestOptions): Promise<ShellProcess>
  setTimeout(
    input: LocationInput & { readonly id: string; readonly timeout: number },
    options?: RequestOptions,
  ): Promise<ShellProcess>
  output(
    input: LocationInput & { readonly id: string; readonly cursor?: number; readonly limit?: number },
    options?: RequestOptions,
  ): Promise<ShellOutput>
  remove(input: LocationInput & { readonly id: string }, options?: RequestOptions): Promise<void>
}

export type ServerInfo = {
  readonly urls: readonly string[]
}

export type LocationInfo = LocationRef & {
  readonly project: CurrentProject
}

export type PluginInfo = {
  readonly id: string
}

export type SkillInfo = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly slash?: boolean
  readonly autoinvoke?: boolean
  readonly location: LocationRef
  readonly content: string
}

export interface DiscoveryV2Capability {
  server(options?: RequestOptions): Promise<ServerInfo>
  location(input?: LocationInput, options?: RequestOptions): Promise<LocationInfo>
  plugins(input?: LocationInput, options?: RequestOptions): Promise<readonly PluginInfo[]>
  skills(input?: LocationInput, options?: RequestOptions): Promise<readonly SkillInfo[]>
  models(input?: LocationInput, options?: RequestOptions): Promise<readonly AppModel[]>
  defaultModel(input?: LocationInput, options?: RequestOptions): Promise<AppModel | null>
  generateText(
    input: LocationInput & { readonly prompt: string; readonly model?: ModelRef },
    options?: RequestOptions,
  ): Promise<string>
  loadedLocations(options?: RequestOptions): Promise<readonly LocationRef[]>
}

export interface Capabilities {
  readonly projectList?: ProjectListCapability
  readonly vcs?: VcsApi
  readonly mcp?: McpApi
  readonly configuration?: ConfigurationCapability
  readonly providerAuthV1?: ProviderAuthV1Capability
  readonly integrationsV2?: IntegrationsV2Capability
  readonly projectEditing?: ProjectEditingCapability
  readonly worktreesV1?: WorktreesV1Capability
  readonly projectCopiesV2?: ProjectCopiesV2Capability
  readonly sessionExtrasV1?: SessionExtrasV1Capability
  readonly sessionActionsV1?: SessionActionsV1Capability
  readonly sessionExtrasV2?: SessionExtrasV2Capability
  readonly lsp?: LspCapability
  readonly mcpControl?: McpControlCapability
  readonly pathInfo?: PathInfoCapability
  readonly vcsInfo?: VcsInfoCapability
  readonly decoratedFiles?: DecoratedFileCapability
  readonly ptyTransport?: PtyTransportCapability
  readonly shellDiscovery?: ShellDiscoveryCapability
  readonly shellsV2?: ShellsV2Capability
  readonly formsV2?: FormsV2Capability
  readonly savedPermissionsV2?: SavedPermissionsV2Capability
  readonly discoveryV2?: DiscoveryV2Capability
  readonly runtimeV1?: RuntimeV1Capability
}

export interface AppClient {
  readonly version: "v1" | "v2"
  readonly common: CommonClient
  readonly capabilities: Capabilities
}
