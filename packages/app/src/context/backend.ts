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
  readonly previous?: string
  readonly next?: string
}

export type Health = {
  readonly healthy: boolean
  readonly version?: string
  readonly pid?: number
}

export type AppProject = {
  readonly id: string
  readonly worktree: string
  readonly name?: string
  readonly icon?: {
    readonly url?: string
    readonly override?: string
    readonly color?: string
  }
  readonly commands?: {
    readonly start?: string
  }
  readonly sandboxes: readonly string[]
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
  readonly parentID?: string
  readonly projectID: string
  readonly location: LocationRef
  readonly title: string
  readonly cost: number
  readonly tokens?: TokenUsage
  readonly time: {
    readonly created: number
    readonly updated?: number
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
      readonly raw?: string
    }
  | {
      readonly status: "running"
      readonly input: Readonly<Record<string, unknown>>
      readonly title?: string
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | {
      readonly status: "completed"
      readonly input: Readonly<Record<string, unknown>>
      readonly output: string
      readonly title?: string
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | {
      readonly status: "error"
      readonly input: Readonly<Record<string, unknown>>
      readonly error: string
      readonly metadata?: Readonly<Record<string, unknown>>
    }

export type TimelineContent =
  | {
      readonly type: "text"
      readonly id: string
      readonly text: string
      readonly synthetic?: boolean
      readonly ignored?: boolean
      readonly metadata?: Readonly<Record<string, unknown>>
    }
  | {
      readonly type: "reasoning"
      readonly id: string
      readonly text: string
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
    }

export type TimelineItem =
  | {
      readonly type: "user"
      readonly id: string
      readonly sessionID: string
      readonly created: number
      readonly content: readonly TimelineContent[]
      readonly agent?: string
      readonly model?: ModelRef
      readonly raw?: unknown
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
      readonly error?: unknown
      readonly raw?: unknown
    }
  | {
      readonly type: "agent-switch" | "model-switch" | "synthetic" | "system" | "skill" | "shell" | "compaction"
      readonly id: string
      readonly sessionID: string
      readonly created: number
      readonly raw?: unknown
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

export type PromptInput = {
  readonly sessionID: string
  readonly id: string
  readonly text: string
  readonly files?: readonly PromptFile[]
  readonly agents?: readonly PromptAgentMention[]
  readonly selection?: {
    readonly agent?: string
    readonly model?: ModelRef
  }
  readonly delivery?: "steer" | "queue"
}

export type CommandInput = {
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
  readonly type: "file" | "directory"
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

export type AppPermissionRequest = {
  readonly id: string
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type AppQuestion = {
  readonly question: string
  readonly header?: string
  readonly options: readonly {
    readonly label: string
    readonly description?: string
  }[]
  readonly multiple?: boolean
  readonly custom?: boolean
}

export type AppQuestionRequest = {
  readonly id: string
  readonly sessionID: string
  readonly questions: readonly AppQuestion[]
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
  | { readonly type: "project.updated"; readonly project: AppProject }
  | { readonly type: "session.created"; readonly session: AppSession }
  | { readonly type: "session.updated"; readonly session: AppSession }
  | { readonly type: "session.deleted"; readonly sessionID: string }
  | { readonly type: "session.activity"; readonly sessionID: string; readonly activity: SessionActivity }
  | { readonly type: "session.error"; readonly sessionID?: string; readonly error?: unknown }
  | { readonly type: "timeline.updated"; readonly item: TimelineItem }
  | { readonly type: "timeline.removed"; readonly sessionID: string; readonly itemID: string }
  | { readonly type: "permission.requested"; readonly request: AppPermissionRequest }
  | { readonly type: "permission.replied"; readonly sessionID: string; readonly requestID: string }
  | { readonly type: "question.requested"; readonly request: AppQuestionRequest }
  | { readonly type: "question.replied" | "question.rejected"; readonly sessionID: string; readonly requestID: string }
  | { readonly type: "file.changed"; readonly path: string; readonly change: "add" | "change" | "unlink" }
  | { readonly type: "vcs.branch.updated"; readonly branch?: string }
  | { readonly type: "pty.exited"; readonly ptyID: string }
  | { readonly type: "unknown"; readonly raw: unknown }

export interface HealthApi {
  get(options?: RequestOptions): Promise<Health>
}

export interface ProjectApi {
  list(options?: RequestOptions): Promise<readonly AppProject[]>
  current(input?: LocationInput, options?: RequestOptions): Promise<CurrentProject>
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
  remove(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<void>
  fork(
    input: LocationInput & { readonly sessionID: string; readonly messageID?: string },
    options?: RequestOptions,
  ): Promise<AppSession>
  rename(
    input: LocationInput & { readonly sessionID: string; readonly title: string },
    options?: RequestOptions,
  ): Promise<void>
  interrupt(input: LocationInput & { readonly sessionID: string }, options?: RequestOptions): Promise<void>
  activity(input?: LocationInput, options?: RequestOptions): Promise<Readonly<Record<string, SessionActivity>>>
  history(
    input: { readonly sessionID: string; readonly limit?: number; readonly cursor?: string },
    options?: RequestOptions,
  ): Promise<Page<TimelineItem>>
  message(
    input: { readonly sessionID: string; readonly messageID: string },
    options?: RequestOptions,
  ): Promise<TimelineItem>
  prompt(input: PromptInput, options?: RequestOptions): Promise<void>
  command(input: CommandInput, options?: RequestOptions): Promise<void>
}

export interface FileApi {
  list(input: LocationInput & { readonly path?: string }, options?: RequestOptions): Promise<readonly FileEntry[]>
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
    input: {
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
    input: {
      readonly sessionID: string
      readonly requestID: string
      readonly answers: readonly (readonly string[])[]
    },
    options?: RequestOptions,
  ): Promise<void>
  reject(input: { readonly sessionID: string; readonly requestID: string }, options?: RequestOptions): Promise<void>
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
  readonly vcs: VcsApi
  readonly mcp: McpApi
  readonly pty: PtyApi
  readonly events: EventApi
  disposeLocation(input: LocationInput, options?: RequestOptions): Promise<void>
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
  remove(input: LocationInput & { readonly directory: string }, options?: RequestOptions): Promise<void>
  reset(input: LocationInput & { readonly directory: string }, options?: RequestOptions): Promise<void>
}

export type AppTodo = {
  readonly id?: string
  readonly content: string
  readonly status: "pending" | "in_progress" | "completed" | "cancelled" | (string & {})
}

export type LegacySessionShellInput = LocationInput & {
  readonly sessionID: string
  readonly id?: string
  readonly command: string
  readonly agent: string
  readonly model?: ModelRef
}

export interface SessionExtrasV1Capability {
  archive(sessionID: string, archivedAt: number, options?: RequestOptions): Promise<void>
  share(sessionID: string, options?: RequestOptions): Promise<string>
  unshare(sessionID: string, options?: RequestOptions): Promise<void>
  diff(sessionID: string, options?: RequestOptions): Promise<readonly AppFileDiff[]>
  todos(sessionID: string, options?: RequestOptions): Promise<readonly AppTodo[]>
  summarize(sessionID: string, model: ModelRef, options?: RequestOptions): Promise<void>
  revert(sessionID: string, messageID: string, options?: RequestOptions): Promise<void>
  clearRevert(sessionID: string, options?: RequestOptions): Promise<void>
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
    readonly hunks: readonly { readonly lines: readonly string[] }[]
  }
}

export interface DecoratedFileCapability {
  read(input: LocationInput & { readonly path: string }, options?: RequestOptions): Promise<DecoratedFileContent>
}

export type PtyTicket = {
  readonly ticket: string
}

export interface PtyTransportCapability {
  connectToken(input: LocationInput & { readonly ptyID: string }, options?: RequestOptions): Promise<PtyTicket>
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
  switchAgent(input: { readonly sessionID: string; readonly agent: string }, options?: RequestOptions): Promise<void>
  switchModel(input: { readonly sessionID: string; readonly model: ModelRef }, options?: RequestOptions): Promise<void>
  move(
    input: { readonly sessionID: string; readonly directory: string; readonly moveChanges?: boolean },
    options?: RequestOptions,
  ): Promise<void>
  skill(
    input: { readonly sessionID: string; readonly id?: string; readonly skill: string; readonly resume?: boolean },
    options?: RequestOptions,
  ): Promise<void>
  synthetic(
    input: {
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
  shell(
    input: { readonly sessionID: string; readonly id?: string; readonly command: string },
    options?: RequestOptions,
  ): Promise<void>
  compact(
    input: { readonly sessionID: string; readonly id?: string },
    options?: RequestOptions,
  ): Promise<PendingSessionInput>
  wait(input: { readonly sessionID: string }, options?: RequestOptions): Promise<void>
  context(input: { readonly sessionID: string }, options?: RequestOptions): Promise<readonly TimelineItem[]>
  pending(input: { readonly sessionID: string }, options?: RequestOptions): Promise<readonly PendingSessionInput[]>
  instructionEntries(
    input: { readonly sessionID: string },
    options?: RequestOptions,
  ): Promise<readonly InstructionEntry[]>
  putInstructionEntry(
    input: { readonly sessionID: string; readonly key: string; readonly value: JsonValue },
    options?: RequestOptions,
  ): Promise<void>
  removeInstructionEntry(
    input: { readonly sessionID: string; readonly key: string },
    options?: RequestOptions,
  ): Promise<void>
  log(
    input: { readonly sessionID: string; readonly after?: number; readonly follow?: boolean },
    options?: RequestOptions,
  ): AsyncIterable<SessionLogItem>
  background(input: { readonly sessionID: string }, options?: RequestOptions): Promise<void>
  stageRevert(
    input: { readonly sessionID: string; readonly messageID: string; readonly files?: readonly string[] },
    options?: RequestOptions,
  ): Promise<{ readonly messageID: string }>
  clearRevert(input: { readonly sessionID: string }, options?: RequestOptions): Promise<void>
  commitRevert(input: { readonly sessionID: string }, options?: RequestOptions): Promise<void>
}

export type ProjectDirectory = {
  readonly directory: string
  readonly strategy?: string
}

export interface ProjectCopiesV2Capability {
  directories(
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
  readonly configuration?: ConfigurationCapability
  readonly providerAuthV1?: ProviderAuthV1Capability
  readonly integrationsV2?: IntegrationsV2Capability
  readonly projectEditing?: ProjectEditingCapability
  readonly worktreesV1?: WorktreesV1Capability
  readonly projectCopiesV2?: ProjectCopiesV2Capability
  readonly sessionExtrasV1?: SessionExtrasV1Capability
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
