import type { OpenCodeEventEncoded } from "@opencode-ai/protocol/groups/event"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type UnauthorizedError = { readonly _tag: "UnauthorizedError"; readonly message: string }
export const isUnauthorizedError = (value: unknown): value is UnauthorizedError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "UnauthorizedError"

export type InvalidRequestError = {
  readonly _tag: "InvalidRequestError"
  readonly message: string
  readonly kind?: string | undefined
  readonly field?: string | undefined
}
export const isInvalidRequestError = (value: unknown): value is InvalidRequestError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "InvalidRequestError"

export type InvalidCursorError = { readonly _tag: "InvalidCursorError"; readonly message: string }
export const isInvalidCursorError = (value: unknown): value is InvalidCursorError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "InvalidCursorError"

export type SessionNotFoundError = {
  readonly _tag: "SessionNotFoundError"
  readonly sessionID: string
  readonly message: string
}
export const isSessionNotFoundError = (value: unknown): value is SessionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SessionNotFoundError"

export type MessageNotFoundError = {
  readonly _tag: "MessageNotFoundError"
  readonly sessionID: string
  readonly messageID: string
  readonly message: string
}
export const isMessageNotFoundError = (value: unknown): value is MessageNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "MessageNotFoundError"

export type ConflictError = {
  readonly _tag: "ConflictError"
  readonly message: string
  readonly resource?: string | undefined
}
export const isConflictError = (value: unknown): value is ConflictError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ConflictError"

export type CommandNotFoundError = {
  readonly _tag: "CommandNotFoundError"
  readonly command: string
  readonly message: string
}
export const isCommandNotFoundError = (value: unknown): value is CommandNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "CommandNotFoundError"

export type CommandEvaluationError = {
  readonly _tag: "CommandEvaluationError"
  readonly command: string
  readonly message: string
}
export const isCommandEvaluationError = (value: unknown): value is CommandEvaluationError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "CommandEvaluationError"

export type SkillNotFoundError = {
  readonly _tag: "SkillNotFoundError"
  readonly skill: string
  readonly message: string
}
export const isSkillNotFoundError = (value: unknown): value is SkillNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SkillNotFoundError"

export type SessionBusyError = {
  readonly _tag: "SessionBusyError"
  readonly sessionID: string
  readonly message: string
}
export const isSessionBusyError = (value: unknown): value is SessionBusyError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SessionBusyError"

export type ServiceUnavailableError = {
  readonly _tag: "ServiceUnavailableError"
  readonly message: string
  readonly service?: string | undefined
}
export const isServiceUnavailableError = (value: unknown): value is ServiceUnavailableError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ServiceUnavailableError"

export type UnknownError = {
  readonly _tag: "UnknownError"
  readonly message: string
  readonly ref?: string | undefined
}
export const isUnknownError = (value: unknown): value is UnknownError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "UnknownError"

export type ProviderNotFoundError = {
  readonly _tag: "ProviderNotFoundError"
  readonly providerID: string
  readonly message: string
}
export const isProviderNotFoundError = (value: unknown): value is ProviderNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ProviderNotFoundError"

export type FormNotFoundError = { readonly _tag: "FormNotFoundError"; readonly id: string; readonly message: string }
export const isFormNotFoundError = (value: unknown): value is FormNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "FormNotFoundError"

export type FormAlreadySettledError = {
  readonly _tag: "FormAlreadySettledError"
  readonly id: string
  readonly message: string
}
export const isFormAlreadySettledError = (value: unknown): value is FormAlreadySettledError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "FormAlreadySettledError"

export type FormInvalidAnswerError = {
  readonly _tag: "FormInvalidAnswerError"
  readonly id: string
  readonly message: string
}
export const isFormInvalidAnswerError = (value: unknown): value is FormInvalidAnswerError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "FormInvalidAnswerError"

export type PermissionNotFoundError = {
  readonly _tag: "PermissionNotFoundError"
  readonly requestID: string
  readonly message: string
}
export const isPermissionNotFoundError = (value: unknown): value is PermissionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "PermissionNotFoundError"

export type PtyNotFoundError = { readonly _tag: "PtyNotFoundError"; readonly ptyID: string; readonly message: string }
export const isPtyNotFoundError = (value: unknown): value is PtyNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "PtyNotFoundError"

export type ShellNotFoundError = { readonly _tag: "ShellNotFoundError"; readonly id: string; readonly message: string }
export const isShellNotFoundError = (value: unknown): value is ShellNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ShellNotFoundError"

export type QuestionNotFoundError = {
  readonly _tag: "QuestionNotFoundError"
  readonly requestID: string
  readonly message: string
}
export const isQuestionNotFoundError = (value: unknown): value is QuestionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "QuestionNotFoundError"

export type ProjectCopyError = {
  readonly name: "ProjectCopyError"
  readonly data: { readonly message: string; readonly forceRequired?: boolean | undefined }
}
export const isProjectCopyError = (value: unknown): value is ProjectCopyError =>
  typeof value === "object" && value !== null && "name" in value && value["name"] === "ProjectCopyError"

export type LocationQuery = {
  readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
}

export type ModelRef = { readonly id: string; readonly providerID: string; readonly variant?: string }

export type ProviderSettings = { readonly [x: string]: JsonValue }

export type AgentColor = string | "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info"

export type PermissionV2Effect = "allow" | "deny" | "ask"

export type ProviderRequest = {
  readonly settings: ProviderSettings
  readonly headers: { readonly [x: string]: string }
  readonly body: { readonly [x: string]: JsonValue }
}

export type PermissionV2Rule = {
  readonly action: string
  readonly resource: string
  readonly effect: PermissionV2Effect
}

export type PermissionV2Ruleset = ReadonlyArray<PermissionV2Rule>

export type AgentV2Info = {
  readonly id: string
  readonly model?: ModelRef
  readonly request: ProviderRequest
  readonly system?: string
  readonly description?: string
  readonly mode: "subagent" | "primary" | "all"
  readonly hidden: boolean
  readonly color?: AgentColor
  readonly steps?: number
  readonly permissions: PermissionV2Ruleset
}

export type PluginInfo = { readonly id: string }

export type SessionsQuery = {
  readonly workspace?: string | undefined
  readonly limit?: number | undefined
  readonly order?: "asc" | "desc" | undefined
  readonly search?: string | undefined
  readonly parentID?: string | null | undefined
  readonly directory?: string | undefined
  readonly project?: string | undefined
  readonly subpath?: string | undefined
  readonly cursor?: string | undefined
}

export type LocationRef = { readonly directory: string; readonly workspaceID?: string }

export type FileDiff = {
  readonly path: string
  readonly status: "added" | "modified" | "deleted"
  readonly additions: number
  readonly deletions: number
  readonly patch: string
}

export type SessionWatermarks = { readonly [x: string]: number }

export type RevertState = {
  readonly messageID: string
  readonly partID?: string
  readonly snapshot?: string
  readonly diff?: string
  readonly files?: ReadonlyArray<FileDiff>
}

export type SessionV2Info = {
  readonly id: string
  readonly parentID?: string
  readonly projectID: string
  readonly agent?: string
  readonly model?: ModelRef
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
  readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
  readonly title: string
  readonly location: LocationRef
  readonly subpath?: string
  readonly revert?: RevertState
}

export type SessionsResponse = {
  readonly data: ReadonlyArray<SessionV2Info>
  readonly watermarks: SessionWatermarks
  readonly cursor: { readonly previous?: string | null; readonly next?: string | null }
}

export type SessionActive = { readonly type: "running" }

export type PromptSource = { readonly start: number; readonly end: number; readonly text: string }

export type PromptInputFileAttachment = {
  readonly uri: string
  readonly name?: string
  readonly description?: string
  readonly source?: PromptSource
}

export type PromptAgentAttachment = { readonly name: string; readonly source?: PromptSource }

export type PromptInput = {
  readonly text: string
  readonly files?: ReadonlyArray<PromptInputFileAttachment>
  readonly agents?: ReadonlyArray<PromptAgentAttachment>
}

export type PromptFileAttachment = {
  readonly uri: string
  readonly mime: string
  readonly name?: string
  readonly description?: string
  readonly source?: PromptSource
}

export type Prompt = {
  readonly text: string
  readonly files?: ReadonlyArray<PromptFileAttachment>
  readonly agents?: ReadonlyArray<PromptAgentAttachment>
}

export type SessionInputAdmitted = {
  readonly admittedSeq: number
  readonly id: string
  readonly sessionID: string
  readonly prompt: Prompt
  readonly delivery: "steer" | "queue"
  readonly timeCreated: number
  readonly promotedSeq?: number
}

export type SessionMessageAgentSelected = {
  readonly id: string
  readonly metadata?: { readonly [x: string]: JsonValue }
  readonly time: { readonly created: number }
  readonly type: "agent-switched"
  readonly agent: string
}

export type SessionMessageSynthetic = {
  readonly id: string
  readonly metadata?: { readonly [x: string]: JsonValue }
  readonly time: { readonly created: number }
  readonly sessionID: string
  readonly text: string
  readonly description?: string
  readonly type: "synthetic"
}

export type SessionMessageSystem = {
  readonly id: string
  readonly metadata?: { readonly [x: string]: JsonValue }
  readonly time: { readonly created: number }
  readonly type: "system"
  readonly text: string
}

export type SessionMessageSkill = {
  readonly id: string
  readonly metadata?: { readonly [x: string]: JsonValue }
  readonly time: { readonly created: number }
  readonly type: "skill"
  readonly name: string
  readonly text: string
}

export type Shell = {
  readonly id: string
  readonly status: "running" | "exited" | "timeout" | "killed"
  readonly command: string
  readonly cwd: string
  readonly shell: string
  readonly file: string
  readonly pid?: number
  readonly exit?: number | "Infinity" | "-Infinity" | "NaN"
  readonly metadata: { readonly [x: string]: JsonValue }
  readonly time: {
    readonly started: number | "Infinity" | "-Infinity" | "NaN"
    readonly completed?: number | "Infinity" | "-Infinity" | "NaN"
  }
}

export type SessionMessageAssistantText = { readonly type: "text"; readonly id: string; readonly text: string }

export type LLMProviderMetadata = { readonly [x: string]: { readonly [x: string]: JsonValue } }

export type SessionMessageToolStatePending = { readonly status: "pending"; readonly input: string }

export type ToolTextContent = { readonly type: "text"; readonly text: string }

export type ToolFileContent = {
  readonly type: "file"
  readonly uri: string
  readonly mime: string
  readonly name?: string
}

export type SessionErrorUnknown = { readonly type: "unknown"; readonly message: string }

export type SessionMessageCompaction = {
  readonly type: "compaction"
  readonly reason: "auto" | "manual"
  readonly summary: string
  readonly recent: string
  readonly id: string
  readonly metadata?: { readonly [x: string]: JsonValue }
  readonly time: { readonly created: number }
}

export type SessionMessageModelSelected = {
  readonly id: string
  readonly metadata?: { readonly [x: string]: JsonValue }
  readonly time: { readonly created: number }
  readonly type: "model-switched"
  readonly model: ModelRef
  readonly previous?: ModelRef
}

export type SessionMessageShell = {
  readonly id: string
  readonly metadata?: { readonly [x: string]: JsonValue }
  readonly time: { readonly created: number; readonly completed?: number }
  readonly type: "shell"
  readonly shell: Shell
  readonly output?: {
    readonly output: string
    readonly cursor: number
    readonly size: number
    readonly truncated: boolean
  }
}

export type SessionMessageAssistantReasoning = {
  readonly type: "reasoning"
  readonly id: string
  readonly text: string
  readonly providerMetadata?: LLMProviderMetadata
  readonly time?: { readonly created: number; readonly completed?: number }
}

export type LLMToolContent = ToolTextContent | ToolFileContent

export type SessionMessageUser = {
  readonly id: string
  readonly metadata?: { readonly [x: string]: JsonValue }
  readonly time: { readonly created: number }
  readonly text: string
  readonly files?: ReadonlyArray<PromptFileAttachment>
  readonly agents?: ReadonlyArray<PromptAgentAttachment>
  readonly type: "user"
}

export type SessionMessageToolStateRunning = {
  readonly status: "running"
  readonly input: { readonly [x: string]: JsonValue }
  readonly structured: { readonly [x: string]: JsonValue }
  readonly content: ReadonlyArray<LLMToolContent>
}

export type SessionMessageToolStateCompleted = {
  readonly status: "completed"
  readonly input: { readonly [x: string]: JsonValue }
  readonly attachments?: ReadonlyArray<PromptFileAttachment>
  readonly content: ReadonlyArray<LLMToolContent>
  readonly outputPaths?: ReadonlyArray<string>
  readonly structured: { readonly [x: string]: JsonValue }
  readonly result?: JsonValue
}

export type SessionMessageToolStateError = {
  readonly status: "error"
  readonly input: { readonly [x: string]: JsonValue }
  readonly content: ReadonlyArray<LLMToolContent>
  readonly structured: { readonly [x: string]: JsonValue }
  readonly error: SessionErrorUnknown
  readonly result?: JsonValue
}

export type SessionMessageAssistantTool = {
  readonly type: "tool"
  readonly id: string
  readonly name: string
  readonly provider?: {
    readonly executed: boolean
    readonly metadata?: LLMProviderMetadata
    readonly resultMetadata?: LLMProviderMetadata
  }
  readonly state:
    | SessionMessageToolStatePending
    | SessionMessageToolStateRunning
    | SessionMessageToolStateCompleted
    | SessionMessageToolStateError
  readonly time: {
    readonly created: number
    readonly ran?: number
    readonly completed?: number
    readonly pruned?: number
  }
}

export type SessionMessageAssistant = {
  readonly id: string
  readonly metadata?: { readonly [x: string]: JsonValue }
  readonly time: { readonly created: number; readonly completed?: number }
  readonly type: "assistant"
  readonly agent: string
  readonly model: ModelRef
  readonly content: ReadonlyArray<
    SessionMessageAssistantText | SessionMessageAssistantReasoning | SessionMessageAssistantTool
  >
  readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
  readonly finish?: string
  readonly cost?: number
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
  readonly error?: SessionErrorUnknown
}

export type SessionMessage =
  | SessionMessageAgentSelected
  | SessionMessageModelSelected
  | SessionMessageUser
  | SessionMessageSynthetic
  | SessionMessageSystem
  | SessionMessageSkill
  | SessionMessageShell
  | SessionMessageAssistant
  | SessionMessageCompaction

export type SessionContextEntryKey = string

export type SessionContextEntryInfo = { readonly key: SessionContextEntryKey; readonly value: JsonValue }

export type Shell2 = {
  readonly id: string
  readonly status: "running" | "exited" | "timeout" | "killed"
  readonly command: string
  readonly cwd: string
  readonly shell: string
  readonly file: string
  readonly pid?: number
  readonly exit?: number
  readonly metadata: { readonly [x: string]: unknown }
  readonly time: { readonly started: number; readonly completed?: number }
}

export type LLMProviderMetadata2 = { readonly [x: string]: { readonly [x: string]: unknown } }

export type SessionRetryError = {
  readonly message: string
  readonly statusCode?: number
  readonly isRetryable: boolean
  readonly responseHeaders?: { readonly [x: string]: string }
  readonly responseBody?: string
  readonly metadata?: { readonly [x: string]: string }
}

export type EventLogSynced = { readonly type: "log.synced"; readonly aggregateID: string; readonly seq?: number }

export type SessionAgentSelected = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.agent.selected"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly agent: string }
}

export type SessionMoved = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.moved"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly location: LocationRef; readonly subpath?: string }
}

export type SessionRenamed = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.renamed"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly title: string }
}

export type SessionForked = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.forked"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly parentID: string; readonly from?: string }
}

export type SessionPromptPromoted = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.prompt.promoted"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly inputID: string }
}

export type SessionContextUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.context.updated"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly text: string }
}

export type SessionSynthetic = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.synthetic"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly text: string
    readonly description?: string
    readonly metadata?: { readonly [x: string]: unknown }
  }
}

export type SessionSkillActivated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.skill.activated"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly name: string; readonly text: string }
}

export type SessionStepEnded = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.step.ended"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly finish: string
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly snapshot?: string
    readonly files?: ReadonlyArray<string>
  }
}

export type SessionTextStarted = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.text.started"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly assistantMessageID: string; readonly textID: string }
}

export type SessionTextEnded = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.text.ended"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly textID: string
    readonly text: string
  }
}

export type SessionToolInputStarted = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.tool.input.started"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly callID: string
    readonly name: string
  }
}

export type SessionToolInputEnded = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.tool.input.ended"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly callID: string
    readonly text: string
  }
}

export type SessionCompactionStarted = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.compaction.started"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly reason: "auto" | "manual" }
}

export type SessionCompactionEnded = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.compaction.ended"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly reason: "auto" | "manual"
    readonly text: string
    readonly recent: string
  }
}

export type SessionRevertCleared = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.revert.cleared"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string }
}

export type SessionRevertCommitted = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.revert.committed"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly messageID: string }
}

export type SessionModelSelected = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.model.selected"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly model: ModelRef }
}

export type SessionStepStarted = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.step.started"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly agent: string
    readonly model: ModelRef
    readonly snapshot?: string
  }
}

export type SessionShellStarted = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.shell.started"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly shell: Shell2 }
}

export type SessionShellEnded = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.shell.ended"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly shell: Shell2
    readonly output: {
      readonly output: string
      readonly cursor: number
      readonly size: number
      readonly truncated: boolean
    }
  }
}

export type SessionStepFailed = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.step.failed"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly error: SessionErrorUnknown
  }
}

export type SessionReasoningStarted = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.reasoning.started"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly reasoningID: string
    readonly providerMetadata?: LLMProviderMetadata2
  }
}

export type SessionReasoningEnded = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.reasoning.ended"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly reasoningID: string
    readonly text: string
    readonly providerMetadata?: LLMProviderMetadata2
  }
}

export type SessionToolCalled = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.tool.called"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly callID: string
    readonly tool: string
    readonly input: { readonly [x: string]: unknown }
    readonly provider: { readonly executed: boolean; readonly metadata?: LLMProviderMetadata2 }
  }
}

export type SessionToolFailed = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.tool.failed"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly callID: string
    readonly error: SessionErrorUnknown
    readonly result?: unknown
    readonly provider: { readonly executed: boolean; readonly metadata?: LLMProviderMetadata2 }
  }
}

export type SessionRetried = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.retried"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly attempt: number; readonly error: SessionRetryError }
}

export type SessionToolProgress = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.tool.progress"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly callID: string
    readonly structured: { readonly [x: string]: unknown }
    readonly content: ReadonlyArray<LLMToolContent>
  }
}

export type SessionToolSuccess = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.tool.success"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly callID: string
    readonly structured: { readonly [x: string]: unknown }
    readonly content: ReadonlyArray<LLMToolContent>
    readonly outputPaths?: ReadonlyArray<string>
    readonly result?: unknown
    readonly provider: { readonly executed: boolean; readonly metadata?: LLMProviderMetadata2 }
  }
}

export type SessionRevertStaged = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.revert.staged"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly revert: RevertState }
}

export type SessionPromptAdmitted = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.prompt.admitted"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly inputID: string
    readonly prompt: Prompt
    readonly delivery: "steer" | "queue"
  }
}

export type SessionDurableEvent =
  | SessionAgentSelected
  | SessionModelSelected
  | SessionMoved
  | SessionRenamed
  | SessionForked
  | SessionPromptPromoted
  | SessionPromptAdmitted
  | SessionContextUpdated
  | SessionSynthetic
  | SessionSkillActivated
  | SessionShellStarted
  | SessionShellEnded
  | SessionStepStarted
  | SessionStepEnded
  | SessionStepFailed
  | SessionTextStarted
  | SessionTextEnded
  | SessionReasoningStarted
  | SessionReasoningEnded
  | SessionToolInputStarted
  | SessionToolInputEnded
  | SessionToolCalled
  | SessionToolProgress
  | SessionToolSuccess
  | SessionToolFailed
  | SessionRetried
  | SessionCompactionStarted
  | SessionCompactionEnded
  | SessionRevertStaged
  | SessionRevertCleared
  | SessionRevertCommitted

export type SessionLogItem = SessionDurableEvent | EventLogSynced

export type SessionMessagesQuery = {
  readonly limit?: number | undefined
  readonly order?: "asc" | "desc" | undefined
  readonly cursor?: string | undefined
}

export type SessionMessagesResponse = {
  readonly data: ReadonlyArray<SessionMessage>
  readonly watermark?: number
  readonly cursor: { readonly previous?: string | null; readonly next?: string | null }
}

export type ModelApi =
  | {
      readonly id: string
      readonly type: "aisdk"
      readonly package: string
      readonly url?: string
      readonly settings?: { readonly [x: string]: JsonValue }
    }
  | {
      readonly id: string
      readonly type: "native"
      readonly url?: string
      readonly settings: { readonly [x: string]: JsonValue }
    }

export type ModelCapabilities = {
  readonly tools: boolean
  readonly input: ReadonlyArray<string>
  readonly output: ReadonlyArray<string>
}

export type ModelCost = {
  readonly tier?: { readonly type: "context"; readonly size: number }
  readonly input: number
  readonly output: number
  readonly cache: { readonly read: number; readonly write: number }
}

export type ModelV2Info = {
  readonly id: string
  readonly providerID: string
  readonly family?: string
  readonly name: string
  readonly api: ModelApi
  readonly capabilities: ModelCapabilities
  readonly request: {
    readonly settings: ProviderSettings
    readonly headers: { readonly [x: string]: string }
    readonly body: { readonly [x: string]: JsonValue }
    readonly variant?: string
  }
  readonly variants: ReadonlyArray<{
    readonly id: string
    readonly settings: ProviderSettings
    readonly headers: { readonly [x: string]: string }
    readonly body: { readonly [x: string]: JsonValue }
  }>
  readonly time: { readonly released: number }
  readonly cost: ReadonlyArray<ModelCost>
  readonly status: "alpha" | "beta" | "deprecated" | "active"
  readonly enabled: boolean
  readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
}

export type GenerateTextResponse = { readonly data: { readonly text: string } }

export type ProviderAISDK = {
  readonly type: "aisdk"
  readonly package: string
  readonly url?: string
  readonly settings?: { readonly [x: string]: JsonValue }
}

export type ProviderNative = {
  readonly type: "native"
  readonly url?: string
  readonly settings: { readonly [x: string]: JsonValue }
}

export type ProviderApi = ProviderAISDK | ProviderNative

export type ProviderV2Info = {
  readonly id: string
  readonly integrationID?: string
  readonly name: string
  readonly disabled?: boolean
  readonly api: ProviderApi
  readonly request: ProviderRequest
}

export type IntegrationWhen = { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }

export type IntegrationKeyMethod = { readonly type: "key"; readonly label?: string }

export type IntegrationEnvMethod = { readonly type: "env"; readonly names: ReadonlyArray<string> }

export type ConnectionCredentialInfo = { readonly type: "credential"; readonly id: string; readonly label: string }

export type ConnectionEnvInfo = { readonly type: "env"; readonly name: string }

export type IntegrationTextPrompt = {
  readonly type: "text"
  readonly key: string
  readonly message: string
  readonly placeholder?: string
  readonly when?: IntegrationWhen
}

export type IntegrationSelectPrompt = {
  readonly type: "select"
  readonly key: string
  readonly message: string
  readonly options: ReadonlyArray<{ readonly label: string; readonly value: string; readonly hint?: string }>
  readonly when?: IntegrationWhen
}

export type ConnectionInfo = ConnectionCredentialInfo | ConnectionEnvInfo

export type IntegrationOAuthMethod = {
  readonly id: string
  readonly type: "oauth"
  readonly label: string
  readonly prompts?: ReadonlyArray<IntegrationTextPrompt | IntegrationSelectPrompt>
}

export type IntegrationMethod = IntegrationOAuthMethod | IntegrationKeyMethod | IntegrationEnvMethod

export type IntegrationAttemptStatus =
  | {
      readonly status: "pending"
      readonly time: {
        readonly created: number | "Infinity" | "-Infinity" | "NaN"
        readonly expires: number | "Infinity" | "-Infinity" | "NaN"
      }
    }
  | {
      readonly status: "complete"
      readonly time: {
        readonly created: number | "Infinity" | "-Infinity" | "NaN"
        readonly expires: number | "Infinity" | "-Infinity" | "NaN"
      }
    }
  | {
      readonly status: "failed"
      readonly message: string
      readonly time: {
        readonly created: number | "Infinity" | "-Infinity" | "NaN"
        readonly expires: number | "Infinity" | "-Infinity" | "NaN"
      }
    }
  | {
      readonly status: "expired"
      readonly time: {
        readonly created: number | "Infinity" | "-Infinity" | "NaN"
        readonly expires: number | "Infinity" | "-Infinity" | "NaN"
      }
    }

export type McpStatusConnected = { readonly status: "connected" }

export type McpStatusPending = { readonly status: "pending" }

export type McpStatusDisabled = { readonly status: "disabled" }

export type McpStatusFailed = { readonly status: "failed"; readonly error: string }

export type McpStatusNeedsAuth = { readonly status: "needs_auth" }

export type McpStatusNeedsClientRegistration = { readonly status: "needs_client_registration"; readonly error: string }

export type McpServer = {
  readonly name: string
  readonly status:
    | McpStatusConnected
    | McpStatusPending
    | McpStatusDisabled
    | McpStatusFailed
    | McpStatusNeedsAuth
    | McpStatusNeedsClientRegistration
  readonly integrationID?: string
}

export type ProjectCurrent = { readonly id: string; readonly directory: string }

export type ProjectDirectory = { readonly directory: string; readonly strategy?: string }

export type ProjectDirectories = ReadonlyArray<ProjectDirectory>

export type FormMetadata = { readonly [x: string]: JsonValue }

export type FormWhen = {
  readonly key: string
  readonly op: "eq" | "neq"
  readonly value: string | number | "Infinity" | "-Infinity" | "NaN" | boolean
}

export type FormOption = { readonly value: string; readonly label: string; readonly description?: string }

export type FormUrlInfo = {
  readonly id: string
  readonly sessionID: string
  readonly title?: string
  readonly metadata?: FormMetadata
  readonly mode: "url"
  readonly url: string
}

export type FormNumberField = {
  readonly key: string
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly when?: ReadonlyArray<FormWhen>
  readonly type: "number"
  readonly minimum?: number | "Infinity" | "-Infinity" | "NaN"
  readonly maximum?: number | "Infinity" | "-Infinity" | "NaN"
  readonly default?: number | "Infinity" | "-Infinity" | "NaN"
}

export type FormIntegerField = {
  readonly key: string
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly when?: ReadonlyArray<FormWhen>
  readonly type: "integer"
  readonly minimum?: number | "Infinity" | "-Infinity" | "NaN"
  readonly maximum?: number | "Infinity" | "-Infinity" | "NaN"
  readonly default?: number | "Infinity" | "-Infinity" | "NaN"
}

export type FormBooleanField = {
  readonly key: string
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly when?: ReadonlyArray<FormWhen>
  readonly type: "boolean"
  readonly default?: boolean
}

export type FormStringField = {
  readonly key: string
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly when?: ReadonlyArray<FormWhen>
  readonly type: "string"
  readonly format?: "email" | "uri" | "date" | "date-time"
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: string
  readonly placeholder?: string
  readonly default?: string
  readonly options?: ReadonlyArray<FormOption>
  readonly custom?: boolean
}

export type FormMultiselectField = {
  readonly key: string
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly when?: ReadonlyArray<FormWhen>
  readonly type: "multiselect"
  readonly options: ReadonlyArray<FormOption>
  readonly minItems?: number
  readonly maxItems?: number
  readonly custom?: boolean
  readonly default?: ReadonlyArray<string>
}

export type FormFormInfo = {
  readonly id: string
  readonly sessionID: string
  readonly title?: string
  readonly metadata?: FormMetadata
  readonly mode: "form"
  readonly fields: ReadonlyArray<
    FormStringField | FormNumberField | FormIntegerField | FormBooleanField | FormMultiselectField
  >
}

export type FormCreatePayload = {
  readonly id?: string | null
  readonly title?: string
  readonly metadata?: FormMetadata
  readonly mode: "form" | "url"
  readonly fields?: ReadonlyArray<
    FormStringField | FormNumberField | FormIntegerField | FormBooleanField | FormMultiselectField
  > | null
  readonly url?: string | null
}

export type FormValue = string | number | "Infinity" | "-Infinity" | "NaN" | boolean | ReadonlyArray<string>

export type FormAnswer = { readonly [x: string]: FormValue }

export type FormState =
  | { readonly status: "pending" }
  | { readonly status: "answered"; readonly answer: FormAnswer }
  | { readonly status: "cancelled" }

export type FormReply = { readonly answer: FormAnswer }

export type PermissionV2Source = { readonly type: "tool"; readonly messageID: string; readonly callID: string }

export type PermissionV2Request = {
  readonly id: string
  readonly sessionID: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly save?: ReadonlyArray<string>
  readonly metadata?: { readonly [x: string]: JsonValue }
  readonly source?: PermissionV2Source
}

export type PermissionSavedInfo = {
  readonly id: string
  readonly projectID: string
  readonly action: string
  readonly resource: string
}

export type PermissionV2Reply = "once" | "always" | "reject"

export type FileSystemEntry = { readonly path: string; readonly type: "file" | "directory" }

export type CommandV2Info = {
  readonly name: string
  readonly template: string
  readonly description?: string
  readonly agent?: string
  readonly model?: ModelRef
  readonly subtask?: boolean
}

export type SkillV2Info = {
  readonly name: string
  readonly description?: string
  readonly slash?: boolean
  readonly autoinvoke?: boolean
  readonly location: string
  readonly content: string
}

export type SnapshotFileDiff = {
  readonly file?: string
  readonly patch?: string
  readonly additions: number
  readonly deletions: number
  readonly status?: "added" | "deleted" | "modified"
}

export type PermissionAction = "allow" | "deny" | "ask"

export type JSONSchema = { readonly [x: string]: any }

export type ProviderAuthError = {
  readonly name: "ProviderAuthError"
  readonly data: { readonly providerID: string; readonly message: string }
}

export type UnknownError2 = {
  readonly name: "UnknownError"
  readonly data: { readonly message: string; readonly ref?: string | undefined }
}

export type MessageOutputLengthError = { readonly name: "MessageOutputLengthError"; readonly data: {} }

export type MessageAbortedError = { readonly name: "MessageAbortedError"; readonly data: { readonly message: string } }

export type StructuredOutputError = {
  readonly name: "StructuredOutputError"
  readonly data: { readonly message: string; readonly retries: number }
}

export type ContextOverflowError = {
  readonly name: "ContextOverflowError"
  readonly data: { readonly message: string; readonly responseBody?: string | undefined }
}

export type ContentFilterError = { readonly name: "ContentFilterError"; readonly data: { readonly message: string } }

export type APIError = {
  readonly name: "APIError"
  readonly data: {
    readonly message: string
    readonly statusCode?: number | undefined
    readonly isRetryable: boolean
    readonly responseHeaders?: { readonly [x: string]: string } | undefined
    readonly responseBody?: string | undefined
    readonly metadata?: { readonly [x: string]: string } | undefined
  }
}

export type TextPart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "text"
  readonly text: string
  readonly synthetic?: boolean | undefined
  readonly ignored?: boolean | undefined
  readonly time?: { readonly start: number; readonly end?: number | undefined } | undefined
  readonly metadata?: { readonly [x: string]: any } | undefined
}

export type SubtaskPart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "subtask"
  readonly prompt: string
  readonly description: string
  readonly agent: string
  readonly model?: { readonly providerID: string; readonly modelID: string } | undefined
  readonly command?: string | undefined
}

export type ReasoningPart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "reasoning"
  readonly text: string
  readonly metadata?: { readonly [x: string]: any } | undefined
  readonly time: { readonly start: number; readonly end?: number | undefined }
}

export type FilePartSourceText = { readonly value: string; readonly start: number; readonly end: number }

export type Range = {
  readonly start: { readonly line: number; readonly character: number }
  readonly end: { readonly line: number; readonly character: number }
}

export type ToolStatePending = {
  readonly status: "pending"
  readonly input: { readonly [x: string]: any }
  readonly raw: string
}

export type ToolStateRunning = {
  readonly status: "running"
  readonly input: { readonly [x: string]: any }
  readonly title?: string | undefined
  readonly metadata?: { readonly [x: string]: any } | undefined
  readonly time: { readonly start: number }
}

export type ToolStateError = {
  readonly status: "error"
  readonly input: { readonly [x: string]: any }
  readonly error: string
  readonly metadata?: { readonly [x: string]: any } | undefined
  readonly time: { readonly start: number; readonly end: number }
}

export type StepStartPart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "step-start"
  readonly snapshot?: string | undefined
}

export type StepFinishPart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "step-finish"
  readonly reason: string
  readonly snapshot?: string | undefined
  readonly cost: number
  readonly tokens: {
    readonly total?: number | undefined
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
}

export type SnapshotPart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "snapshot"
  readonly snapshot: string
}

export type PatchPart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "patch"
  readonly hash: string
  readonly files: ReadonlyArray<string>
}

export type AgentPart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "agent"
  readonly name: string
  readonly source?: { readonly value: string; readonly start: number; readonly end: number } | undefined
}

export type CompactionPart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "compaction"
  readonly auto: boolean
  readonly overflow?: boolean | undefined
  readonly tail_start_id?: string | undefined
}

export type Pty = {
  readonly id: string
  readonly title: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly status: "running" | "exited"
  readonly pid: number
  readonly exitCode?: number
}

export type QuestionV2Option = { readonly label: string; readonly description: string }

export type QuestionV2Tool = { readonly messageID: string; readonly callID: string }

export type QuestionV2Answer = ReadonlyArray<string>

export type FormMetadata2 = { readonly [x: string]: unknown }

export type FormWhen2 = { readonly key: string; readonly op: "eq" | "neq"; readonly value: string | number | boolean }

export type FormValue2 = string | number | boolean | ReadonlyArray<string>

export type Todo = { readonly content: string; readonly status: string; readonly priority: string }

export type SessionStatus =
  | { readonly type: "idle" }
  | {
      readonly type: "retry"
      readonly attempt: number
      readonly message: string
      readonly action?: {
        readonly reason: string
        readonly provider: string
        readonly title: string
        readonly message: string
        readonly label: string
        readonly link?: string
      }
      readonly next: number
    }
  | { readonly type: "busy" }

export type QuestionOption = { readonly label: string; readonly description: string }

export type QuestionTool = { readonly messageID: string; readonly callID: string }

export type QuestionAnswer = ReadonlyArray<string>

export type ModelsDevRefreshed = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "models-dev.refreshed"
  readonly location?: LocationRef
  readonly data: {}
}

export type IntegrationUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "integration.updated"
  readonly location?: LocationRef
  readonly data: {}
}

export type IntegrationConnectionUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "integration.connection.updated"
  readonly location?: LocationRef
  readonly data: { readonly integrationID: string }
}

export type CatalogUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "catalog.updated"
  readonly location?: LocationRef
  readonly data: {}
}

export type AgentUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "agent.updated"
  readonly location?: LocationRef
  readonly data: {}
}

export type MessageRemoved = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "message.removed"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly messageID: string }
}

export type MessagePartRemoved = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "message.part.removed"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly messageID: string; readonly partID: string }
}

export type SessionTextDelta = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.text.delta"
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly textID: string
    readonly delta: string
  }
}

export type SessionReasoningDelta = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.reasoning.delta"
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly reasoningID: string
    readonly delta: string
  }
}

export type SessionToolInputDelta = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.tool.input.delta"
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly assistantMessageID: string
    readonly callID: string
    readonly delta: string
  }
}

export type SessionCompactionDelta = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.compaction.delta"
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly text: string }
}

export type FilesystemChanged = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "filesystem.changed"
  readonly location?: LocationRef
  readonly data: { readonly file: string; readonly event: "add" | "change" | "unlink" }
}

export type ReferenceUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "reference.updated"
  readonly location?: LocationRef
  readonly data: {}
}

export type PluginAdded = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "plugin.added"
  readonly location?: LocationRef
  readonly data: { readonly id: string }
}

export type ProjectDirectoriesUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "project.directories.updated"
  readonly location?: LocationRef
  readonly data: { readonly projectID: string }
}

export type CommandUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "command.updated"
  readonly location?: LocationRef
  readonly data: {}
}

export type ConfigUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "config.updated"
  readonly location?: LocationRef
  readonly data: {}
}

export type SkillUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "skill.updated"
  readonly location?: LocationRef
  readonly data: {}
}

export type PtyExited = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "pty.exited"
  readonly location?: LocationRef
  readonly data: { readonly id: string; readonly exitCode: number }
}

export type PtyDeleted = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "pty.deleted"
  readonly location?: LocationRef
  readonly data: { readonly id: string }
}

export type ShellExited = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "shell.exited"
  readonly location?: LocationRef
  readonly data: {
    readonly id: string
    readonly exit?: number
    readonly status: "running" | "exited" | "timeout" | "killed"
  }
}

export type ShellDeleted = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "shell.deleted"
  readonly location?: LocationRef
  readonly data: { readonly id: string }
}

export type QuestionV2Rejected = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "question.v2.rejected"
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly requestID: string }
}

export type FormCancelled = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "form.cancelled"
  readonly location?: LocationRef
  readonly data: { readonly id: string; readonly sessionID: string }
}

export type SessionIdle = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.idle"
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string }
}

export type TuiPromptAppend = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "tui.prompt.append"
  readonly location?: LocationRef
  readonly data: { readonly text: string }
}

export type TuiCommandExecute = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "tui.command.execute"
  readonly location?: LocationRef
  readonly data: {
    readonly command:
      | "session.list"
      | "session.new"
      | "session.share"
      | "session.interrupt"
      | "session.background"
      | "session.compact"
      | "session.page.up"
      | "session.page.down"
      | "session.line.up"
      | "session.line.down"
      | "session.half.page.up"
      | "session.half.page.down"
      | "session.first"
      | "session.last"
      | "prompt.clear"
      | "prompt.submit"
      | "agent.cycle"
      | string
  }
}

export type TuiToastShow = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "tui.toast.show"
  readonly location?: LocationRef
  readonly data: {
    readonly title?: string
    readonly message: string
    readonly variant: "info" | "success" | "warning" | "error"
    readonly duration?: number | undefined
  }
}

export type TuiSessionSelect = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "tui.session.select"
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string }
}

export type InstallationUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "installation.updated"
  readonly location?: LocationRef
  readonly data: { readonly version: string }
}

export type InstallationUpdateAvailable = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "installation.update-available"
  readonly location?: LocationRef
  readonly data: { readonly version: string }
}

export type VcsBranchUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "vcs.branch.updated"
  readonly location?: LocationRef
  readonly data: { readonly branch?: string }
}

export type McpStatusChanged = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "mcp.status.changed"
  readonly location?: LocationRef
  readonly data: { readonly server: string }
}

export type PermissionAsked = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "permission.asked"
  readonly location?: LocationRef
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly permission: string
    readonly patterns: ReadonlyArray<string>
    readonly metadata: { readonly [x: string]: unknown }
    readonly always: ReadonlyArray<string>
    readonly tool?: { readonly messageID: string; readonly callID: string } | undefined
  }
}

export type PermissionReplied = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "permission.replied"
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly requestID: string
    readonly reply: "once" | "always" | "reject"
  }
}

export type QuestionRejected = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "question.rejected"
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly requestID: string }
}

export type V2EventServerConnected = {
  readonly id: string
  readonly metadata?: { readonly [x: string]: unknown } | undefined
  readonly location?: LocationRef | undefined
  readonly type: "server.connected"
  readonly data: {}
}

export type PermissionRule = {
  readonly permission: string
  readonly pattern: string
  readonly action: PermissionAction
}

export type OutputFormat =
  | { readonly type: "text" }
  | { readonly type: "json_schema"; readonly schema: JSONSchema; readonly retryCount?: number | undefined | undefined }

export type AssistantMessage = {
  readonly id: string
  readonly sessionID: string
  readonly role: "assistant"
  readonly time: { readonly created: number; readonly completed?: number | undefined }
  readonly error?:
    | ProviderAuthError
    | UnknownError2
    | MessageOutputLengthError
    | MessageAbortedError
    | StructuredOutputError
    | ContextOverflowError
    | ContentFilterError
    | APIError
    | undefined
  readonly parentID: string
  readonly modelID: string
  readonly providerID: string
  readonly mode: string
  readonly agent: string
  readonly path: { readonly cwd: string; readonly root: string }
  readonly summary?: boolean | undefined
  readonly cost: number
  readonly tokens: {
    readonly total?: number | undefined
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
  readonly structured?: any | undefined
  readonly variant?: string | undefined
  readonly finish?: string | undefined
}

export type RetryPart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "retry"
  readonly attempt: number
  readonly error: APIError
  readonly time: { readonly created: number }
}

export type SessionError = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.error"
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID?: string | undefined
    readonly error?:
      | ProviderAuthError
      | UnknownError2
      | MessageOutputLengthError
      | MessageAbortedError
      | StructuredOutputError
      | ContextOverflowError
      | ContentFilterError
      | APIError
      | undefined
  }
}

export type FileSource = { readonly text: FilePartSourceText; readonly type: "file"; readonly path: string }

export type ResourceSource = {
  readonly text: FilePartSourceText
  readonly type: "resource"
  readonly clientName: string
  readonly uri: string
}

export type SymbolSource = {
  readonly text: FilePartSourceText
  readonly type: "symbol"
  readonly path: string
  readonly range: Range
  readonly name: string
  readonly kind: number
}

export type SessionExecutionSettled = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.execution.settled"
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly outcome: "success" | "failure" | "interrupted"
    readonly error?: SessionErrorUnknown
  }
}

export type ShellCreated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "shell.created"
  readonly location?: LocationRef
  readonly data: { readonly info: Shell2 }
}

export type PermissionV2Asked = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "permission.v2.asked"
  readonly location?: LocationRef
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: unknown }
    readonly source?: PermissionV2Source
  }
}

export type PermissionV2Replied = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "permission.v2.replied"
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly requestID: string; readonly reply: PermissionV2Reply }
}

export type PtyCreated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "pty.created"
  readonly location?: LocationRef
  readonly data: { readonly info: Pty }
}

export type PtyUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "pty.updated"
  readonly location?: LocationRef
  readonly data: { readonly info: Pty }
}

export type QuestionV2Info = {
  readonly question: string
  readonly header: string
  readonly options: ReadonlyArray<QuestionV2Option>
  readonly multiple?: boolean
  readonly custom?: boolean
}

export type QuestionV2Replied = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "question.v2.replied"
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly requestID: string
    readonly answers: ReadonlyArray<QuestionV2Answer>
  }
}

export type FormUrlInfo2 = {
  readonly id: string
  readonly sessionID: string
  readonly title?: string
  readonly metadata?: FormMetadata2
  readonly mode: "url"
  readonly url: string
}

export type FormNumberField2 = {
  readonly key: string
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly when?: ReadonlyArray<FormWhen2>
  readonly type: "number"
  readonly minimum?: number
  readonly maximum?: number
  readonly default?: number
}

export type FormIntegerField2 = {
  readonly key: string
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly when?: ReadonlyArray<FormWhen2>
  readonly type: "integer"
  readonly minimum?: number
  readonly maximum?: number
  readonly default?: number
}

export type FormBooleanField2 = {
  readonly key: string
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly when?: ReadonlyArray<FormWhen2>
  readonly type: "boolean"
  readonly default?: boolean
}

export type FormStringField2 = {
  readonly key: string
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly when?: ReadonlyArray<FormWhen2>
  readonly type: "string"
  readonly format?: "email" | "uri" | "date" | "date-time"
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: string
  readonly placeholder?: string
  readonly default?: string
  readonly options?: ReadonlyArray<FormOption>
  readonly custom?: boolean
}

export type FormMultiselectField2 = {
  readonly key: string
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly when?: ReadonlyArray<FormWhen2>
  readonly type: "multiselect"
  readonly options: ReadonlyArray<FormOption>
  readonly minItems?: number
  readonly maxItems?: number
  readonly custom?: boolean
  readonly default?: ReadonlyArray<string>
}

export type FormAnswer2 = { readonly [x: string]: FormValue2 }

export type TodoUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "todo.updated"
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly todos: ReadonlyArray<Todo> }
}

export type SessionStatus2 = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.status"
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly status: SessionStatus }
}

export type QuestionInfo = {
  readonly question: string
  readonly header: string
  readonly options: ReadonlyArray<QuestionOption>
  readonly multiple?: boolean | undefined
  readonly custom?: boolean | undefined
}

export type QuestionReplied = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "question.replied"
  readonly location?: LocationRef
  readonly data: {
    readonly sessionID: string
    readonly requestID: string
    readonly answers: ReadonlyArray<QuestionAnswer>
  }
}

export type PermissionRuleset = ReadonlyArray<PermissionRule>

export type UserMessage = {
  readonly id: string
  readonly sessionID: string
  readonly role: "user"
  readonly time: { readonly created: number }
  readonly format?: OutputFormat | undefined
  readonly summary?:
    | {
        readonly title?: string | undefined
        readonly body?: string | undefined
        readonly diffs: ReadonlyArray<SnapshotFileDiff>
      }
    | undefined
  readonly agent: string
  readonly model: { readonly providerID: string; readonly modelID: string; readonly variant?: string | undefined }
  readonly system?: string | undefined
  readonly tools?: { readonly [x: string]: boolean } | undefined
}

export type FilePartSource = FileSource | SymbolSource | ResourceSource

export type QuestionV2Asked = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "question.v2.asked"
  readonly location?: LocationRef
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly questions: ReadonlyArray<QuestionV2Info>
    readonly tool?: QuestionV2Tool
  }
}

export type FormFormInfo2 = {
  readonly id: string
  readonly sessionID: string
  readonly title?: string
  readonly metadata?: FormMetadata2
  readonly mode: "form"
  readonly fields: ReadonlyArray<
    FormStringField2 | FormNumberField2 | FormIntegerField2 | FormBooleanField2 | FormMultiselectField2
  >
}

export type FormReplied = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "form.replied"
  readonly location?: LocationRef
  readonly data: { readonly id: string; readonly sessionID: string; readonly answer: FormAnswer2 }
}

export type QuestionAsked = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "question.asked"
  readonly location?: LocationRef
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly questions: ReadonlyArray<QuestionInfo>
    readonly tool?: QuestionTool | undefined
  }
}

export type Session = {
  readonly id: string
  readonly slug: string
  readonly projectID: string
  readonly workspaceID?: string
  readonly directory: string
  readonly path?: string
  readonly parentID?: string
  readonly summary?: {
    readonly additions: number
    readonly deletions: number
    readonly files: number
    readonly diffs?: ReadonlyArray<SnapshotFileDiff>
  }
  readonly cost?: number
  readonly tokens?: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cache: { readonly read: number; readonly write: number }
  }
  readonly share?: { readonly url: string }
  readonly title: string
  readonly agent?: string
  readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
  readonly version: string
  readonly metadata?: { readonly [x: string]: any }
  readonly time: {
    readonly created: number
    readonly updated: number
    readonly compacting?: number
    readonly archived?: number
  }
  readonly permission?: PermissionRuleset
  readonly revert?: {
    readonly messageID: string
    readonly partID?: string
    readonly snapshot?: string
    readonly diff?: string
  }
}

export type Message = UserMessage | AssistantMessage

export type FilePart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "file"
  readonly mime: string
  readonly filename?: string | undefined
  readonly url: string
  readonly source?: FilePartSource | undefined
}

export type FormCreated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "form.created"
  readonly location?: LocationRef
  readonly data: { readonly form: FormFormInfo2 | FormUrlInfo2 }
}

export type SessionCreated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.created"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly info: Session }
}

export type SessionUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.updated"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly info: Session }
}

export type SessionDeleted = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "session.deleted"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly info: Session }
}

export type MessageUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "message.updated"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly info: Message }
}

export type ToolStateCompleted = {
  readonly status: "completed"
  readonly input: { readonly [x: string]: any }
  readonly output: string
  readonly title: string
  readonly metadata: { readonly [x: string]: any }
  readonly time: { readonly start: number; readonly end: number; readonly compacted?: number | undefined }
  readonly attachments?: ReadonlyArray<FilePart> | undefined
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export type ToolPart = {
  readonly id: string
  readonly sessionID: string
  readonly messageID: string
  readonly type: "tool"
  readonly callID: string
  readonly tool: string
  readonly state: ToolState
  readonly metadata?: { readonly [x: string]: any } | undefined
}

export type Part =
  | TextPart
  | SubtaskPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | AgentPart
  | RetryPart
  | CompactionPart

export type MessagePartUpdated = {
  readonly id: string
  readonly created: number
  readonly metadata?: { readonly [x: string]: unknown }
  readonly type: "message.part.updated"
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly location?: LocationRef
  readonly data: { readonly sessionID: string; readonly part: Part; readonly time: number }
}

export type V2Event =
  | ModelsDevRefreshed
  | IntegrationUpdated
  | IntegrationConnectionUpdated
  | CatalogUpdated
  | AgentUpdated
  | SessionCreated
  | SessionUpdated
  | SessionDeleted
  | MessageUpdated
  | MessageRemoved
  | MessagePartUpdated
  | MessagePartRemoved
  | SessionAgentSelected
  | SessionModelSelected
  | SessionMoved
  | SessionRenamed
  | SessionForked
  | SessionPromptPromoted
  | SessionPromptAdmitted
  | SessionExecutionSettled
  | SessionContextUpdated
  | SessionSynthetic
  | SessionSkillActivated
  | SessionShellStarted
  | SessionShellEnded
  | SessionStepStarted
  | SessionStepEnded
  | SessionStepFailed
  | SessionTextStarted
  | SessionTextDelta
  | SessionTextEnded
  | SessionReasoningStarted
  | SessionReasoningDelta
  | SessionReasoningEnded
  | SessionToolInputStarted
  | SessionToolInputDelta
  | SessionToolInputEnded
  | SessionToolCalled
  | SessionToolProgress
  | SessionToolSuccess
  | SessionToolFailed
  | SessionRetried
  | SessionCompactionStarted
  | SessionCompactionDelta
  | SessionCompactionEnded
  | SessionRevertStaged
  | SessionRevertCleared
  | SessionRevertCommitted
  | FilesystemChanged
  | ReferenceUpdated
  | PermissionV2Asked
  | PermissionV2Replied
  | PluginAdded
  | ProjectDirectoriesUpdated
  | CommandUpdated
  | ConfigUpdated
  | SkillUpdated
  | PtyCreated
  | PtyUpdated
  | PtyExited
  | PtyDeleted
  | ShellCreated
  | ShellExited
  | ShellDeleted
  | QuestionV2Asked
  | QuestionV2Replied
  | QuestionV2Rejected
  | FormCreated
  | FormReplied
  | FormCancelled
  | TodoUpdated
  | SessionStatus2
  | SessionIdle
  | TuiPromptAppend
  | TuiCommandExecute
  | TuiToastShow
  | TuiSessionSelect
  | InstallationUpdated
  | InstallationUpdateAvailable
  | VcsBranchUpdated
  | McpStatusChanged
  | PermissionAsked
  | PermissionReplied
  | QuestionAsked
  | QuestionReplied
  | QuestionRejected
  | SessionError
  | V2EventServerConnected

export type EventLogHint = { readonly type: "log.hint"; readonly aggregateID: string; readonly seq: number }

export type EventLogSweepRequired = { readonly type: "log.sweep_required" }

export type EventLogChange = EventLogHint | EventLogSweepRequired

export type QuestionV2Request = {
  readonly id: string
  readonly sessionID: string
  readonly questions: ReadonlyArray<QuestionV2Info>
  readonly tool?: QuestionV2Tool
}

export type QuestionV2Reply = { readonly answers: ReadonlyArray<QuestionV2Answer> }

export type ReferenceLocalSource = {
  readonly type: "local"
  readonly path: string
  readonly description?: string
  readonly hidden?: boolean
}

export type ReferenceGitSource = {
  readonly type: "git"
  readonly repository: string
  readonly branch?: string
  readonly description?: string
  readonly hidden?: boolean
}

export type ReferenceSource = ReferenceLocalSource | ReferenceGitSource

export type ProjectCopyCopy = { readonly directory: string }

export type VcsFileStatus = {
  readonly file: string
  readonly additions: number
  readonly deletions: number
  readonly status: "added" | "deleted" | "modified"
}

export type VcsMode = "working" | "branch"

export type HealthGetOutput = { readonly healthy: true }

export type LocationGetInput = { readonly location?: LocationQuery["location"] }

export type LocationGetOutput = {
  readonly directory: string
  readonly workspaceID?: string
  readonly project: { readonly id: string; readonly directory: string }
}

export type AgentListInput = { readonly location?: LocationQuery["location"] }

export type AgentListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<AgentV2Info>
}

export type PluginListInput = { readonly location?: LocationQuery["location"] }

export type PluginListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<PluginInfo>
}

export type SessionListInput = {
  readonly workspace?: SessionsQuery["workspace"]
  readonly limit?: SessionsQuery["limit"]
  readonly order?: SessionsQuery["order"]
  readonly search?: SessionsQuery["search"]
  readonly parentID?: SessionsQuery["parentID"]
  readonly directory?: SessionsQuery["directory"]
  readonly project?: SessionsQuery["project"]
  readonly subpath?: SessionsQuery["subpath"]
  readonly cursor?: SessionsQuery["cursor"]
}

export type SessionListOutput = SessionsResponse

export type SessionCreateInput = {
  readonly id?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly location?: LocationRef | null
  }["id"]
  readonly agent?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly location?: LocationRef | null
  }["agent"]
  readonly model?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly location?: LocationRef | null
  }["model"]
  readonly location?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly location?: LocationRef | null
  }["location"]
}

export type SessionCreateOutput = { readonly data: SessionV2Info }["data"]

export type SessionActiveOutput = {
  readonly data: { readonly [x: string]: SessionActive }
  readonly watermarks: SessionWatermarks
}

export type SessionGetInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionGetOutput = { readonly data: SessionV2Info }["data"]

export type SessionForkInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID?: { readonly messageID?: string | null }["messageID"]
}

export type SessionForkOutput = { readonly data: SessionV2Info }["data"]

export type SessionSwitchAgentInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly agent: { readonly agent: string }["agent"]
}

export type SessionSwitchAgentOutput = null

export type SessionSwitchModelInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly model: { readonly model: ModelRef }["model"]
}

export type SessionSwitchModelOutput = null

export type SessionRenameInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly title: { readonly title: string }["title"]
}

export type SessionRenameOutput = null

export type SessionPromptInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly prompt: PromptInput
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["id"]
  readonly prompt: {
    readonly id?: string | null
    readonly prompt: PromptInput
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["prompt"]
  readonly delivery?: {
    readonly id?: string | null
    readonly prompt: PromptInput
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["delivery"]
  readonly resume?: {
    readonly id?: string | null
    readonly prompt: PromptInput
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["resume"]
}

export type SessionPromptOutput = { readonly data: SessionInputAdmitted }["data"]

export type SessionCommandInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly files?: ReadonlyArray<PromptInputFileAttachment>
    readonly agents?: ReadonlyArray<PromptAgentAttachment>
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["id"]
  readonly command: {
    readonly id?: string | null
    readonly command: string
    readonly arguments?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly files?: ReadonlyArray<PromptInputFileAttachment>
    readonly agents?: ReadonlyArray<PromptAgentAttachment>
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["command"]
  readonly arguments?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly files?: ReadonlyArray<PromptInputFileAttachment>
    readonly agents?: ReadonlyArray<PromptAgentAttachment>
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["arguments"]
  readonly agent?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly files?: ReadonlyArray<PromptInputFileAttachment>
    readonly agents?: ReadonlyArray<PromptAgentAttachment>
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["agent"]
  readonly model?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly files?: ReadonlyArray<PromptInputFileAttachment>
    readonly agents?: ReadonlyArray<PromptAgentAttachment>
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["model"]
  readonly files?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly files?: ReadonlyArray<PromptInputFileAttachment>
    readonly agents?: ReadonlyArray<PromptAgentAttachment>
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["files"]
  readonly agents?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly files?: ReadonlyArray<PromptInputFileAttachment>
    readonly agents?: ReadonlyArray<PromptAgentAttachment>
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["agents"]
  readonly delivery?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly files?: ReadonlyArray<PromptInputFileAttachment>
    readonly agents?: ReadonlyArray<PromptAgentAttachment>
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["delivery"]
  readonly resume?: {
    readonly id?: string | null
    readonly command: string
    readonly arguments?: string | null
    readonly agent?: string | null
    readonly model?: ModelRef | null
    readonly files?: ReadonlyArray<PromptInputFileAttachment>
    readonly agents?: ReadonlyArray<PromptAgentAttachment>
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["resume"]
}

export type SessionCommandOutput = { readonly data: SessionInputAdmitted }["data"]

export type SessionSkillInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: { readonly id?: string | null; readonly skill: string; readonly resume?: boolean | null }["id"]
  readonly skill: { readonly id?: string | null; readonly skill: string; readonly resume?: boolean | null }["skill"]
  readonly resume?: { readonly id?: string | null; readonly skill: string; readonly resume?: boolean | null }["resume"]
}

export type SessionSkillOutput = null

export type SessionSyntheticInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly text: {
    readonly text: string
    readonly description?: string | null
    readonly metadata?: { readonly [x: string]: JsonValue }
  }["text"]
  readonly description?: {
    readonly text: string
    readonly description?: string | null
    readonly metadata?: { readonly [x: string]: JsonValue }
  }["description"]
  readonly metadata?: {
    readonly text: string
    readonly description?: string | null
    readonly metadata?: { readonly [x: string]: JsonValue }
  }["metadata"]
}

export type SessionSyntheticOutput = null

export type SessionShellInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: { readonly id?: string | null; readonly command: string }["id"]
  readonly command: { readonly id?: string | null; readonly command: string }["command"]
}

export type SessionShellOutput = null

export type SessionCompactInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionCompactOutput = null

export type SessionWaitInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionWaitOutput = null

export type SessionRevertStageInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID: { readonly messageID: string; readonly files?: boolean | null }["messageID"]
  readonly files?: { readonly messageID: string; readonly files?: boolean | null }["files"]
}

export type SessionRevertStageOutput = { readonly data: RevertState }["data"]

export type SessionRevertClearInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionRevertClearOutput = null

export type SessionRevertCommitInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionRevertCommitOutput = null

export type SessionContextInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionContextOutput = { readonly data: ReadonlyArray<SessionMessage> }["data"]

export type SessionListContextEntriesInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionListContextEntriesOutput = { readonly data: ReadonlyArray<SessionContextEntryInfo> }["data"]

export type SessionPutContextEntryInput = {
  readonly sessionID: { readonly sessionID: string; readonly key: SessionContextEntryKey }["sessionID"]
  readonly key: { readonly sessionID: string; readonly key: SessionContextEntryKey }["key"]
  readonly value: { readonly value: JsonValue }["value"]
}

export type SessionPutContextEntryOutput = null

export type SessionRemoveContextEntryInput = {
  readonly sessionID: { readonly sessionID: string; readonly key: SessionContextEntryKey }["sessionID"]
  readonly key: { readonly sessionID: string; readonly key: SessionContextEntryKey }["key"]
}

export type SessionRemoveContextEntryOutput = null

export type SessionLogInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly after?: { readonly after?: number | undefined; readonly follow?: boolean | undefined }["after"]
  readonly follow?: { readonly after?: number | undefined; readonly follow?: boolean | undefined }["follow"]
}

export type SessionLogOutput = SessionLogItem

export type SessionInterruptInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionInterruptOutput = null

export type SessionBackgroundInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionBackgroundOutput = null

export type SessionMessageInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
}

export type SessionMessageOutput = { readonly data: SessionMessage }["data"]

export type MessageListInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: SessionMessagesQuery["limit"]
  readonly order?: SessionMessagesQuery["order"]
  readonly cursor?: SessionMessagesQuery["cursor"]
}

export type MessageListOutput = SessionMessagesResponse

export type ModelListInput = { readonly location?: LocationQuery["location"] }

export type ModelListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<ModelV2Info>
}

export type ModelDefaultInput = { readonly location?: LocationQuery["location"] }

export type ModelDefaultOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ModelV2Info | null
}

export type GenerateTextInput = {
  readonly location?: LocationQuery["location"]
  readonly prompt: { readonly prompt: string; readonly model?: ModelRef | null }["prompt"]
  readonly model?: { readonly prompt: string; readonly model?: ModelRef | null }["model"]
}

export type GenerateTextOutput = GenerateTextResponse["data"]

export type ProviderListInput = { readonly location?: LocationQuery["location"] }

export type ProviderListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<ProviderV2Info>
}

export type ProviderGetInput = {
  readonly providerID: { readonly providerID: string }["providerID"]
  readonly location?: LocationQuery["location"]
}

export type ProviderGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ProviderV2Info
}

export type IntegrationListInput = { readonly location?: LocationQuery["location"] }

export type IntegrationListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly methods: ReadonlyArray<IntegrationMethod>
    readonly connections: ReadonlyArray<ConnectionInfo>
  }>
}

export type IntegrationGetInput = {
  readonly integrationID: { readonly integrationID: string }["integrationID"]
  readonly location?: LocationQuery["location"]
}

export type IntegrationGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly name: string
    readonly methods: ReadonlyArray<IntegrationMethod>
    readonly connections: ReadonlyArray<ConnectionInfo>
  } | null
}

export type IntegrationConnectKeyInput = {
  readonly integrationID: { readonly integrationID: string }["integrationID"]
  readonly location?: LocationQuery["location"]
  readonly key: { readonly key: string; readonly label?: string | null }["key"]
  readonly label?: { readonly key: string; readonly label?: string | null }["label"]
}

export type IntegrationConnectKeyOutput = null

export type IntegrationConnectOauthInput = {
  readonly integrationID: { readonly integrationID: string }["integrationID"]
  readonly location?: LocationQuery["location"]
  readonly methodID: {
    readonly methodID: string
    readonly inputs: { readonly [x: string]: string }
    readonly label?: string | null
  }["methodID"]
  readonly inputs: {
    readonly methodID: string
    readonly inputs: { readonly [x: string]: string }
    readonly label?: string | null
  }["inputs"]
  readonly label?: {
    readonly methodID: string
    readonly inputs: { readonly [x: string]: string }
    readonly label?: string | null
  }["label"]
}

export type IntegrationConnectOauthOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly attemptID: string
    readonly url: string
    readonly instructions: string
    readonly mode: "auto" | "code"
    readonly time: {
      readonly created: number | "Infinity" | "-Infinity" | "NaN"
      readonly expires: number | "Infinity" | "-Infinity" | "NaN"
    }
  }
}

export type IntegrationAttemptStatusInput = {
  readonly attemptID: { readonly attemptID: string }["attemptID"]
  readonly location?: LocationQuery["location"]
}

export type IntegrationAttemptStatusOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: IntegrationAttemptStatus
}

export type IntegrationAttemptCompleteInput = {
  readonly attemptID: { readonly attemptID: string }["attemptID"]
  readonly location?: LocationQuery["location"]
  readonly code?: { readonly code?: string | null }["code"]
}

export type IntegrationAttemptCompleteOutput = null

export type IntegrationAttemptCancelInput = {
  readonly attemptID: { readonly attemptID: string }["attemptID"]
  readonly location?: LocationQuery["location"]
}

export type IntegrationAttemptCancelOutput = null

export type ServerMcpListInput = { readonly location?: LocationQuery["location"] }

export type ServerMcpListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<McpServer>
}

export type CredentialUpdateInput = {
  readonly credentialID: { readonly credentialID: string }["credentialID"]
  readonly location?: LocationQuery["location"]
  readonly label: { readonly label: string }["label"]
}

export type CredentialUpdateOutput = null

export type CredentialRemoveInput = {
  readonly credentialID: { readonly credentialID: string }["credentialID"]
  readonly location?: LocationQuery["location"]
}

export type CredentialRemoveOutput = null

export type ProjectCurrentInput = { readonly location?: LocationQuery["location"] }

export type ProjectCurrentOutput = ProjectCurrent

export type ProjectDirectoriesInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: LocationQuery["location"]
}

export type ProjectDirectoriesOutput = ProjectDirectories

export type FormListRequestsInput = { readonly location?: LocationQuery["location"] }

export type FormListRequestsOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<FormFormInfo | FormUrlInfo>
}

export type FormListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type FormListOutput = { readonly data: ReadonlyArray<FormFormInfo | FormUrlInfo> }["data"]

export type FormCreateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: FormCreatePayload["id"]
  readonly title?: FormCreatePayload["title"]
  readonly metadata?: FormCreatePayload["metadata"]
  readonly mode: FormCreatePayload["mode"]
  readonly fields?: FormCreatePayload["fields"]
  readonly url?: FormCreatePayload["url"]
}

export type FormCreateOutput = { readonly data: FormFormInfo | FormUrlInfo }["data"]

export type FormGetInput = {
  readonly sessionID: { readonly sessionID: string; readonly formID: string }["sessionID"]
  readonly formID: { readonly sessionID: string; readonly formID: string }["formID"]
}

export type FormGetOutput = { readonly data: FormFormInfo | FormUrlInfo }["data"]

export type FormStateInput = {
  readonly sessionID: { readonly sessionID: string; readonly formID: string }["sessionID"]
  readonly formID: { readonly sessionID: string; readonly formID: string }["formID"]
}

export type FormStateOutput = { readonly data: FormState }["data"]

export type FormReplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly formID: string }["sessionID"]
  readonly formID: { readonly sessionID: string; readonly formID: string }["formID"]
  readonly answer: FormReply["answer"]
}

export type FormReplyOutput = null

export type FormCancelInput = {
  readonly sessionID: { readonly sessionID: string; readonly formID: string }["sessionID"]
  readonly formID: { readonly sessionID: string; readonly formID: string }["formID"]
}

export type FormCancelOutput = null

export type PermissionListRequestsInput = { readonly location?: LocationQuery["location"] }

export type PermissionListRequestsOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<PermissionV2Request>
}

export type PermissionListSavedInput = { readonly projectID?: { readonly projectID?: string | undefined }["projectID"] }

export type PermissionListSavedOutput = { readonly data: ReadonlyArray<PermissionSavedInfo> }["data"]

export type PermissionRemoveSavedInput = { readonly id: { readonly id: string }["id"] }

export type PermissionRemoveSavedOutput = null

export type PermissionCreateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: PermissionV2Source
    readonly agent?: string | null
  }["id"]
  readonly action: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: PermissionV2Source
    readonly agent?: string | null
  }["action"]
  readonly resources: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: PermissionV2Source
    readonly agent?: string | null
  }["resources"]
  readonly save?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: PermissionV2Source
    readonly agent?: string | null
  }["save"]
  readonly metadata?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: PermissionV2Source
    readonly agent?: string | null
  }["metadata"]
  readonly source?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: PermissionV2Source
    readonly agent?: string | null
  }["source"]
  readonly agent?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: PermissionV2Source
    readonly agent?: string | null
  }["agent"]
}

export type PermissionCreateOutput = {
  readonly data: { readonly id: string; readonly effect: PermissionV2Effect }
}["data"]

export type PermissionListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type PermissionListOutput = { readonly data: ReadonlyArray<PermissionV2Request> }["data"]

export type PermissionGetInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
}

export type PermissionGetOutput = { readonly data: PermissionV2Request }["data"]

export type PermissionReplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
  readonly reply: { readonly reply: PermissionV2Reply; readonly message?: string | null }["reply"]
  readonly message?: { readonly reply: PermissionV2Reply; readonly message?: string | null }["message"]
}

export type PermissionReplyOutput = null

export type FileReadInput = { readonly location?: LocationQuery["location"]; readonly path: string }

export type FileReadOutput = globalThis.Uint8Array

export type FileListInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly path?: string | undefined
  }["location"]
  readonly path?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly path?: string | undefined
  }["path"]
}

export type FileListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<FileSystemEntry>
}

export type FileFindInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly query: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["query"]
  readonly type?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["type"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type FileFindOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<FileSystemEntry>
}

export type CommandListInput = { readonly location?: LocationQuery["location"] }

export type CommandListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<CommandV2Info>
}

export type SkillListInput = { readonly location?: LocationQuery["location"] }

export type SkillListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<SkillV2Info>
}

export type EventSubscribeOutput = V2Event

export type EventChangesOutput = EventLogChange

export type PtyListInput = { readonly location?: LocationQuery["location"] }

export type PtyListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<Pty>
}

export type PtyCreateInput = {
  readonly location?: LocationQuery["location"]
  readonly command?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["command"]
  readonly args?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["args"]
  readonly cwd?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["cwd"]
  readonly title?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["title"]
  readonly env?: {
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["env"]
}

export type PtyCreateOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: Pty
}

export type PtyGetInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: LocationQuery["location"]
}

export type PtyGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: Pty
}

export type PtyUpdateInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: LocationQuery["location"]
  readonly title?: {
    readonly title?: string
    readonly size?: { readonly rows: number; readonly cols: number }
  }["title"]
  readonly size?: { readonly title?: string; readonly size?: { readonly rows: number; readonly cols: number } }["size"]
}

export type PtyUpdateOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: Pty
}

export type PtyRemoveInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: LocationQuery["location"]
}

export type PtyRemoveOutput = null

export type ShellListInput = { readonly location?: LocationQuery["location"] }

export type ShellListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<Shell>
}

export type ShellCreateInput = {
  readonly location?: LocationQuery["location"]
  readonly command: {
    readonly command: string
    readonly cwd?: string
    readonly timeout?: number
    readonly metadata?: { readonly [x: string]: JsonValue }
  }["command"]
  readonly cwd?: {
    readonly command: string
    readonly cwd?: string
    readonly timeout?: number
    readonly metadata?: { readonly [x: string]: JsonValue }
  }["cwd"]
  readonly timeout?: {
    readonly command: string
    readonly cwd?: string
    readonly timeout?: number
    readonly metadata?: { readonly [x: string]: JsonValue }
  }["timeout"]
  readonly metadata?: {
    readonly command: string
    readonly cwd?: string
    readonly timeout?: number
    readonly metadata?: { readonly [x: string]: JsonValue }
  }["metadata"]
}

export type ShellCreateOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: Shell
}

export type ShellGetInput = {
  readonly id: { readonly id: string }["id"]
  readonly location?: LocationQuery["location"]
}

export type ShellGetOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: Shell
}

export type ShellOutputInput = {
  readonly id: { readonly id: string }["id"]
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly cursor?: number | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly cursor?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly cursor?: number | undefined
    readonly limit?: number | undefined
  }["cursor"]
  readonly limit?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly cursor?: number | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type ShellOutputOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly output: string
    readonly cursor: number
    readonly size: number
    readonly truncated: boolean
  }
}

export type ShellRemoveInput = {
  readonly id: { readonly id: string }["id"]
  readonly location?: LocationQuery["location"]
}

export type ShellRemoveOutput = null

export type QuestionListRequestsInput = { readonly location?: LocationQuery["location"] }

export type QuestionListRequestsOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<QuestionV2Request>
}

export type QuestionListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type QuestionListOutput = { readonly data: ReadonlyArray<QuestionV2Request> }["data"]

export type QuestionReplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
  readonly answers: QuestionV2Reply["answers"]
}

export type QuestionReplyOutput = null

export type QuestionRejectInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
}

export type QuestionRejectOutput = null

export type ReferenceListInput = { readonly location?: LocationQuery["location"] }

export type ReferenceListOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly name: string
    readonly path: string
    readonly description?: string
    readonly hidden?: boolean
    readonly source: ReferenceSource
  }>
}

export type ProjectCopyCreateInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: LocationQuery["location"]
  readonly strategy: { readonly strategy: string; readonly directory: string; readonly name?: string }["strategy"]
  readonly directory: { readonly strategy: string; readonly directory: string; readonly name?: string }["directory"]
  readonly name?: { readonly strategy: string; readonly directory: string; readonly name?: string }["name"]
}

export type ProjectCopyCreateOutput = ProjectCopyCopy

export type ProjectCopyRemoveInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: LocationQuery["location"]
  readonly directory: { readonly directory: string; readonly force: boolean }["directory"]
  readonly force: { readonly directory: string; readonly force: boolean }["force"]
}

export type ProjectCopyRemoveOutput = null

export type ProjectCopyRefreshInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: LocationQuery["location"]
}

export type ProjectCopyRefreshOutput = null

export type VcsStatusInput = { readonly location?: LocationQuery["location"] }

export type VcsStatusOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<VcsFileStatus>
}

export type VcsDiffInput = {
  readonly location?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly mode: VcsMode
    readonly context?: number | undefined
  }["location"]
  readonly mode: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly mode: VcsMode
    readonly context?: number | undefined
  }["mode"]
  readonly context?: {
    readonly location?: { readonly directory?: string | undefined; readonly workspace?: string | undefined } | undefined
    readonly mode: VcsMode
    readonly context?: number | undefined
  }["context"]
}

export type VcsDiffOutput = {
  readonly location: {
    readonly directory: string
    readonly workspaceID?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<SnapshotFileDiff>
}
