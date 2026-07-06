export * as SessionCompaction from "./compaction"

import { LLM, LLMClient, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { Context, DateTime, Effect, Layer, Stream } from "effect"
import { Config } from "../config"
import { EventV2 } from "../event"
import { makeLocationNode } from "../effect/app-node"
import { llmClient } from "../effect/app-node-platform"
import { SessionEvent } from "./event"
import type { SessionMessage } from "./message"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
- Completed: [finished work, verified facts, or changes made; otherwise "(none)"]
- Active: [current work, partial changes, or investigation state; otherwise "(none)"]
- Blocked: [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Put relevant files and symbols inside the section where they matter; do not add extra sections.
- Do not mention the summary process or that context was compacted.`

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

export type AutoInput = {
  readonly sessionID: SessionSchema.ID
  readonly messages: readonly SessionMessage.Message[]
  readonly request: LLMRequest
}

type CompactInput = {
  readonly sessionID: SessionSchema.ID
  readonly messages: readonly SessionMessage.Message[]
  readonly model: Model
}

export type ManualInput = {
  readonly session: SessionSchema.Info
  readonly messages: readonly SessionMessage.Message[]
}

export interface Interface {
  readonly compactIfNeeded: (input: AutoInput) => Effect.Effect<boolean>
  readonly compactAfterOverflow: (input: AutoInput) => Effect.Effect<boolean>
  readonly compactManual: (input: ManualInput) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionCompaction") {}

const serializeString = (value: unknown) => {
  try {
    return String(value)
  } catch {
    return "[unserializable]"
  }
}

const serializeJson = (value: unknown) => {
  try {
    return JSON.stringify(value) ?? serializeString(value)
  } catch {
    return serializeString(value)
  }
}

const serializeError = (value: unknown) => {
  try {
    const prototype =
      typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value)
    const structured = Array.isArray(value) || prototype === Object.prototype || prototype === null
    return structured ? serializeJson(value) : serializeString(value)
  } catch {
    return serializeString(value)
  }
}

const serializeContent = (part: LLMRequest["messages"][number]["content"][number]) => {
  if (part.type === "text" || part.type === "reasoning") return part.text
  if (part.type === "media") return ""
  if (part.type === "tool-call") return `${part.name}\n${serializeJson(part.input)}`
  // OpenAI replays hosted image generations by item reference; the opaque JSON result contains the image bytes.
  if (
    part.providerExecuted &&
    part.name === "image_generation" &&
    part.result.type === "json" &&
    typeof part.providerMetadata?.openai?.itemId === "string"
  )
    return part.name
  if (part.result.type === "content")
    return [part.name, ...part.result.value.flatMap((item) => (item.type === "text" ? [item.text] : []))].join("\n")
  if (part.result.type === "text") return `${part.name}\n${serializeString(part.result.value)}`
  if (part.result.type === "error") return `${part.name}\n${serializeError(part.result.value)}`
  return `${part.name}\n${serializeJson(part.result.value)}`
}

const estimate = (request: LLMRequest) =>
  Token.estimate(
    [
      ...request.system.map((part) => part.text),
      serializeJson(request.tools),
      ...request.messages.flatMap((message) => message.content.map(serializeContent).filter(Boolean)),
    ].join("\n"),
  )

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files =
      message.files?.map(
        (file) =>
          `[Attached ${file.mime}: ${file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")}]`,
      ) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "skill") return `[Skill activated: ${message.name}]\n${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.shell.command}\n${truncate(message.output?.output ?? "")}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
}

const select = (
  messages: readonly SessionMessage.Message[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = messages
    .filter((message) => message.type !== "compaction")
    .map(serialize)
    .filter(Boolean)
  if (conversation.length === 0) return undefined
  let total = 0
  let split = conversation.length
  let splitPrefix = ""
  let splitSuffix = ""
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) {
      const remaining = Math.max(0, tokens - total) * 4
      if (remaining > 0) {
        splitPrefix = conversation[index].slice(0, -remaining)
        splitSuffix = conversation[index].slice(-remaining)
        split = index + 1
      }
      break
    }
    total = next
    split = index
  }
  return {
    head: [...conversation.slice(0, split), splitPrefix].filter(Boolean).join("\n\n"),
    recent: [splitSuffix, ...conversation.slice(split)].filter(Boolean).join("\n\n"),
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const compact = Effect.fn("SessionCompaction.compact")(function* (input: {
    readonly sessionID: SessionSchema.ID
    readonly model: Model
    readonly reason: SessionMessage.Compaction["reason"]
    readonly previousSummary?: string
    readonly context: readonly string[]
    readonly recent: string
    readonly output?: number
  }) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.output ?? input.model.route.defaults.limits?.output ?? 0
    const summaryPrompt = buildPrompt({ previousSummary: input.previousSummary, context: input.context })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    if (Token.estimate(summaryPrompt) > context - summaryOutput) return false
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      reason: input.reason,
    })

    const chunks: string[] = []
    let failed = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          messages: [Message.user(summaryPrompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) {
            chunks.push(event.text)
            return dependencies.events.publish(SessionEvent.Compaction.Delta, {
              sessionID: input.sessionID,
              text: event.text,
            })
          }
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
      )
    const summary = chunks.join("")
    if (!summarized || failed || !summary.trim()) return false
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      reason: input.reason,
      text: summary,
      recent: input.recent,
    })
    return true
  })
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: AutoInput) {
    return yield* compactSelected({
      sessionID: input.sessionID,
      messages: input.messages,
      model: input.request.model,
      reason: "auto",
      force: false,
      output: input.request.generation?.maxTokens ?? input.request.model.route.defaults.limits?.output ?? 0,
    })
  })
  const compactSelected = Effect.fn("SessionCompaction.compactSelected")(function* (
    input: CompactInput & {
      readonly reason: SessionMessage.Compaction["reason"]
      readonly force: boolean
      readonly output?: number
    },
  ) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const selected = select(input.messages, config.tokens)
    if (!selected) return false
    const previousSummary = input.messages.find((message) => message.type === "compaction")
    const hasHead = selected.head.length > 0
    if (!hasHead && previousSummary?.type !== "compaction" && !input.force) return false
    const forcedShortContext = input.force && !hasHead
    const previousRecent = previousSummary?.type === "compaction" ? previousSummary.recent : ""
    return yield* compact({
      sessionID: input.sessionID,
      model: input.model,
      reason: input.reason,
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: (forcedShortContext ? [previousRecent, selected.recent] : [previousRecent, selected.head]).filter(
        Boolean,
      ),
      recent: forcedShortContext ? "" : selected.recent,
      output: input.output,
    })
  })
  const compactManual = Effect.fn("SessionCompaction.compactManual")(function* (input: CompactInput) {
    return yield* compactSelected({ ...input, reason: "manual", force: true })
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: AutoInput) {
    if (!config.auto) return false
    const context = input.request.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.request.model.route.defaults.limits?.output ?? 0
    if (estimate(input.request) <= context - Math.max(output, config.buffer)) return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
    compactManual,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const config = yield* Config.Service
    const models = yield* SessionRunnerModel.Service
    const compaction = make({ events, llm, config: yield* config.entries() })

    return Service.of({
      compactIfNeeded: compaction.compactIfNeeded,
      compactAfterOverflow: compaction.compactAfterOverflow,
      compactManual: Effect.fn("SessionCompaction.compactManual")(function* (input) {
        const resolved = yield* models.resolve(input.session).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!resolved) return false
        return yield* compaction.compactManual({
          sessionID: input.session.id,
          messages: input.messages,
          model: resolved.model,
        })
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventV2.node, llmClient, Config.node, SessionRunnerModel.node],
})
