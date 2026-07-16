export type Session = {
  id: string
  slug: string
  projectID: string
  directory: string
  title: string
  version: string
  parentID?: string
  time: { created: number; updated: number; archived?: number }
  revert?: { messageID: string }
}

export type SessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "running" }
  | {
      type: "retry"
      attempt: number
      message: string
      next: number
      action?: { reason: string; provider: string; title: string; message: string; label: string; link?: string }
    }

export type Todo = {
  content: string
  status: string
  priority: string
}

export type QuestionInfo = {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiple?: boolean
  custom?: boolean
}

export type QuestionAnswer = string[]

export type SnapshotFileDiff = {
  file: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

export type VcsFileDiff = SnapshotFileDiff & { file: string }
type SummaryFileDiff = Omit<SnapshotFileDiff, "file"> & { file?: string }

export type FileContent = {
  readonly type: "text" | "binary"
  readonly content: string
  readonly diff?: string
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
  readonly encoding?: "base64"
  readonly mimeType?: string
}

export type MessageError =
  | { name: "ProviderAuthError"; data: { providerID: string; message: string } }
  | { name: "UnknownError"; data: { message: string; ref?: string } }
  | { name: "MessageOutputLengthError"; data: Record<string, unknown> }
  | { name: "MessageAbortedError"; data: { message: string } }
  | { name: "StructuredOutputError"; data: { message: string; retries: number } }
  | { name: "ContextOverflowError"; data: { message: string; responseBody?: string } }
  | { name: "ContentFilterError"; data: { message: string } }
  | {
      name: "APIError"
      data: {
        message: string
        statusCode?: number
        isRetryable: boolean
        responseHeaders?: Record<string, string>
        responseBody?: string
        metadata?: Record<string, string>
      }
    }

export type Message =
  | {
      id: string
      sessionID: string
      role: "user"
      time: { created: number }
      agent: string
      model: { providerID: string; modelID: string; variant?: string }
      system?: string
      summary?: { title?: string; body?: string; diffs: SummaryFileDiff[] }
    }
  | {
      id: string
      sessionID: string
      role: "assistant"
      time: { created: number; completed?: number }
      parentID: string
      modelID: string
      providerID: string
      mode: string
      agent: string
      path: { cwd: string; root: string }
      cost: number
      tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
      error?: MessageError
      finish?: string
    }

export type UserMessage = Extract<Message, { role: "user" }>
export type AssistantMessage = Extract<Message, { role: "assistant" }>

type PartBase = { id: string; sessionID: string; messageID: string }
export type FilePart = PartBase & {
  type: "file"
  mime: string
  filename?: string
  url: string
  source?:
    | { type: "file"; path: string; text: { value: string; start: number; end: number } }
    | {
        type: "symbol"
        path: string
        range: {
          start: { line: number; character: number }
          end: { line: number; character: number }
        }
        name: string
        kind: number
        text: { value: string; start: number; end: number }
      }
    | { type: "resource"; clientName: string; uri: string; text: { value: string; start: number; end: number } }
}
type ToolState =
  | { status: "pending"; input: Record<string, unknown>; raw: string }
  | {
      status: "running"
      input: Record<string, unknown>
      title?: string
      metadata?: Record<string, unknown>
      time: { start: number }
    }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title: string
      metadata: Record<string, unknown>
      time: { start: number; end: number; compacted?: number }
      attachments?: FilePart[]
    }
  | {
      status: "error"
      input: Record<string, unknown>
      error: string
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }

export type Part =
  | (PartBase & {
      type: "text"
      text: string
      synthetic?: boolean
      ignored?: boolean
      time?: { start: number; end?: number }
      metadata?: Record<string, unknown>
    })
  | (PartBase & {
      type: "reasoning"
      text: string
      metadata?: Record<string, unknown>
      time: { start: number; end?: number }
    })
  | FilePart
  | (PartBase & { type: "agent"; name: string; source?: { value: string; start: number; end: number } })
  | (PartBase & { type: "tool"; callID: string; tool: string; state: ToolState; metadata?: Record<string, unknown> })
  | (PartBase & { type: "subtask"; prompt: string; description: string; agent: string })
  | (PartBase & { type: "step-start"; snapshot?: string })
  | (PartBase & {
      type: "step-finish"
      reason: string
      snapshot?: string
      cost: number
      tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    })
  | (PartBase & { type: "snapshot"; snapshot: string })
  | (PartBase & { type: "patch"; hash: string; files: string[] })
  | (PartBase & {
      type: "retry"
      attempt: number
      error: Extract<MessageError, { name: "APIError" }>
      time: { created: number }
    })
  | (PartBase & { type: "compaction"; auto: boolean })

export type TextPart = Extract<Part, { type: "text" }>
export type ReasoningPart = Extract<Part, { type: "reasoning" }>
export type ToolPart = Extract<Part, { type: "tool" }>
export type AgentPart = Extract<Part, { type: "agent" }>
