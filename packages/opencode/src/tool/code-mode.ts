import * as Tool from "./tool"
import type { Tool as AITool, ToolExecutionOptions } from "ai"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Schema } from "effect"
import {
  CodeMode,
  Tool as SandboxTool,
  toolError,
  type ExecuteResult,
  type JsonSchema,
  type ToolDefinition,
} from "@opencode-ai/codemode"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"

export const CODE_MODE_TOOL = "execute"

const DESCRIPTION = [
  "Execute a JavaScript/TypeScript program that orchestrates the connected MCP tools inside a confined runtime.",
  "The full usage guide and the catalog of available tools follow below.",
].join("\n")

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: [
      "JavaScript source to execute.",
      "Inside CodeMode, `tools` contains only the MCP/CodeMode tools listed in this execute tool's description; top-level opencode tools like bash, read, or lsp are not available unless listed there.",
      "Call available tools using the exact signatures shown in this execute tool's description, compose the results, and `return` the final value.",
    ].join(" "),
  }),
})

export type CallEntry = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

type Metadata = {
  toolCalls: CallEntry[]
  error?: boolean
}

export type Attachment = NonNullable<Tool.ExecuteResult["attachments"]>[number]

export type CatalogEntry = {
  path: string
  key: string
  server: string
  local: string
  description: string
  tool: AITool
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
}

const toJsonSchema = (schema: unknown): JsonSchema => schema as JsonSchema

function fallbackInputSchema(tool: AITool): JsonSchema {
  const schema = (tool.inputSchema as { jsonSchema?: unknown } | undefined)?.jsonSchema
  if (schema && typeof schema === "object") return toJsonSchema(schema)
  return { type: "object", properties: {} }
}

export function groupByServer(
  mcpTools: Record<string, AITool>,
  servers: readonly string[],
  mcpDefs: Record<string, MCPToolDef> = {},
): Map<string, CatalogEntry[]> {
  const byLongest = [...servers].sort((a, b) => b.length - a.length)
  const groups = new Map<string, CatalogEntry[]>()
  for (const key of Object.keys(mcpTools).sort((a, b) => a.localeCompare(b))) {
    const server = byLongest.find((name) => key.startsWith(name + "_")) ?? (key.includes("_") ? key.slice(0, key.indexOf("_")) : key)
    const local = server && key.startsWith(server + "_") ? key.slice(server.length + 1) : key
    const def = mcpDefs[key]
    const entry: CatalogEntry = {
      path: `${server}.${local}`,
      key,
      server,
      local,
      description: mcpTools[key]!.description ?? def?.description ?? "",
      tool: mcpTools[key]!,
      inputSchema: def?.inputSchema ? toJsonSchema(def.inputSchema) : fallbackInputSchema(mcpTools[key]!),
      ...(def?.outputSchema ? { outputSchema: toJsonSchema(def.outputSchema) } : {}),
    }
    groups.set(server, [...(groups.get(server) ?? []), entry])
  }
  return groups
}

export function buildCatalog(
  mcpTools: Record<string, AITool>,
  mcpDefs: Record<string, MCPToolDef>,
  servers: readonly string[],
): CatalogEntry[] {
  return [...groupByServer(mcpTools, servers, mcpDefs).values()].flat().filter((entry) => entry.tool.execute !== undefined)
}

export function catalogInstructions(
  mcpTools: Record<string, AITool>,
  mcpDefs: Record<string, MCPToolDef>,
  servers: readonly string[],
): string {
  const catalog = buildCatalog(mcpTools, mcpDefs, servers)
  return CodeMode.make({
    tools: toolTree(catalog, () => () => Effect.fail(toolError("Tool preview is not executable."))),
  }).instructions()
}

function displayInput(input: unknown): Record<string, unknown> | undefined {
  if (input === null || input === undefined) return
  if (typeof input === "object" && !Array.isArray(input)) {
    const value = input as Record<string, unknown>
    if (Object.keys(value).length > 0) return value
    return
  }
  return { input }
}

const lastSegment = (uri: string) => {
  const trimmed = uri.split(/[?#]/, 1)[0]!.replace(/\/+$/, "")
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1)
  return segment.length > 0 ? segment : undefined
}

const dataUrl = (mime: string, base64: string) => `data:${mime};base64,${base64}`

const mediaMarker = (files: number, images: number) => {
  const noun = files === images ? "image" : "file"
  return `[${files} ${noun}${files === 1 ? "" : "s"} attached to the result]`
}

export function toSandboxResult(raw: unknown, collect: (attachment: Attachment) => void): unknown {
  if (raw === null || typeof raw !== "object") return raw
  const record = raw as { structuredContent?: unknown; content?: unknown }
  const content = Array.isArray(record.content) ? record.content : []
  const text: string[] = []
  let files = 0
  let images = 0
  const push = (attachment: Attachment) => {
    files += 1
    if (attachment.mime.startsWith("image/")) images += 1
    collect(attachment)
  }
  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const block = item as Record<string, unknown>
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") text.push(block.text)
        break
      case "image":
      case "audio":
        if (typeof block.data === "string" && typeof block.mimeType === "string") {
          push({ type: "file", mime: block.mimeType, url: dataUrl(block.mimeType, block.data) })
        }
        break
      case "resource": {
        const res = block.resource as Record<string, unknown> | undefined
        if (res && typeof res === "object") {
          const mime = typeof res.mimeType === "string" ? res.mimeType : "application/octet-stream"
          const uri = typeof res.uri === "string" ? res.uri : undefined
          if (typeof res.blob === "string") {
            push({ type: "file", mime, url: dataUrl(mime, res.blob), filename: uri ? lastSegment(uri) : undefined })
          } else if (typeof res.text === "string") {
            text.push(res.text)
          }
        }
        break
      }
      case "resource_link":
        if (typeof block.uri === "string") {
          push({
            type: "file",
            mime: typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream",
            url: block.uri,
            filename: typeof block.name === "string" ? block.name : lastSegment(block.uri),
          })
        }
        break
    }
  }

  if (record.structuredContent !== undefined && record.structuredContent !== null) return record.structuredContent
  if (text.length > 0) return text.join("\n")
  if (files > 0) return mediaMarker(files, images)
  if (Array.isArray(record.content)) return null // MCP-shaped result with nothing extractable
  return raw
}

export function withLogs(output: string, logs: ReadonlyArray<string> = []): string {
  if (logs.length === 0) return output
  const section = "Logs:\n" + logs.join("\n")
  return output.length > 0 ? `${output}\n\n${section}` : section
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return "undefined"
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

type Run = (input: unknown) => Effect.Effect<unknown, unknown>

function toolTree(catalog: readonly CatalogEntry[], run: (entry: CatalogEntry) => Run) {
  const tree: Record<string, Record<string, ToolDefinition>> = {}
  for (const entry of catalog) {
    const namespace = (tree[entry.server] ??= {})
    namespace[entry.local] = SandboxTool.make({
      description: entry.description,
      input: entry.inputSchema,
      output: entry.outputSchema,
      run: run(entry),
    })
  }
  return tree
}

const toCatchable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
      const error = Cause.squash(cause)
      return Effect.fail(toolError(error instanceof Error ? error.message : String(error), error))
    }),
  )

const invokeChildTool = Effect.fn("CodeMode.invokeChildTool")(function* <R>(input: {
  plugin: Plugin.Interface
  entry: CatalogEntry
  args: any
  callID: string
  options: ToolExecutionOptions
  ctx: Tool.Context
  execute: (args: any, options: ToolExecutionOptions) => R | PromiseLike<R>
}) {
  yield* input.plugin.trigger(
    "tool.execute.before",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID },
    { args: input.args },
  )
  const result: R = yield* Effect.gen(function* () {
    yield* input.ctx.ask({ permission: input.entry.key, metadata: {}, patterns: ["*"], always: ["*"] })
    return yield* Effect.promise(() => Promise.resolve(input.execute(input.args, input.options)))
  }).pipe(
    Effect.withSpan("Tool.execute", {
      attributes: {
        "tool.name": input.entry.key,
        "tool.call_id": input.callID,
        "session.id": input.ctx.sessionID,
        "message.id": input.ctx.messageID,
      },
    }),
  )
  yield* input.plugin.trigger(
    "tool.execute.after",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID, args: input.args },
    result,
  )
  return result
})

export const CodeModeTool = Tool.define(
  CODE_MODE_TOOL,
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const plugin = yield* Plugin.Service

    const init: Tool.DefWithoutID<typeof Parameters, Metadata> = {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: Effect.fn("CodeMode.execute")(function* (params, ctx) {
        if (ctx.abort.aborted) {
          return {
            title: CODE_MODE_TOOL,
            metadata: { toolCalls: [], error: true },
            output: "Execution cancelled.",
          } satisfies Tool.ExecuteResult<Metadata>
        }
        const agent = yield* agents.get(ctx.agent)
        const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
        const ruleset = Permission.merge(agent.permission, session.permission ?? [])
        const mcpTools = Permission.visibleTools(yield* mcp.tools(), ruleset)
        const servers = Object.keys(yield* mcp.clients()).map(McpCatalog.sanitize)
        const catalog = buildCatalog(mcpTools, yield* mcp.defs(), servers)

        const calls: CallEntry[] = []
        const attachments: Attachment[] = []
        const collect = (attachment: Attachment) => void attachments.push(attachment)
        const publish = () => ctx.metadata({ title: CODE_MODE_TOOL, metadata: { toolCalls: calls.map((c) => ({ ...c })) } })

        let childCalls = 0
        const callTool = (entry: CatalogEntry) => (input: unknown) =>
          toCatchable(
            Effect.gen(function* () {
              childCalls += 1
              const raw = yield* invokeChildTool({
                plugin,
                entry,
                args: input ?? {},
                callID: `${ctx.callID ?? entry.key}/${childCalls}`,
                options: { toolCallId: ctx.callID ?? entry.key, abortSignal: ctx.abort, messages: [] },
                ctx,
                execute: entry.tool.execute!,
              })
              return toSandboxResult(raw, collect)
            }),
          )

        const runtime = CodeMode.make({
          tools: toolTree(catalog, callTool),
          onToolCallStart: ({ index, name, input }) =>
            Effect.suspend(() => {
              const shown = displayInput(input)
              calls[index] = { tool: name, status: "running", ...(shown ? { input: shown } : {}) }
              return publish()
            }),
          onToolCallEnd: ({ index, outcome }) =>
            Effect.suspend(() => {
              const current = calls[index]
              if (current) calls[index] = { ...current, status: outcome === "success" ? "completed" : "error" }
              return publish()
            }),
        })

        // Bridge ai-sdk AbortSignal cancellation into the Effect fiber.
        const cancelled = Effect.callback<ExecuteResult>((resume) => {
          const onAbort = () =>
            resume(
              Effect.succeed<ExecuteResult>({
                ok: false,
                error: { kind: "ExecutionFailure", message: "Execution cancelled." },
                toolCalls: calls.map((call) => ({ name: call.tool })),
              }),
            )
          if (ctx.abort.aborted) return onAbort()
          ctx.abort.addEventListener("abort", onAbort, { once: true })
          return Effect.sync(() => ctx.abort.removeEventListener("abort", onAbort))
        })

        const result = yield* Effect.raceFirst(runtime.execute(params.code), cancelled)
        const logs = result.logs ?? []
        const attached = attachments.length > 0 ? { attachments } : {}

        if (result.ok) {
          return {
            title: CODE_MODE_TOOL,
            metadata: { toolCalls: calls },
            output: withLogs(formatValue(result.value), logs),
            ...attached,
          } satisfies Tool.ExecuteResult<Metadata>
        }
        const hints = (result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))
        return {
          title: CODE_MODE_TOOL,
          metadata: { toolCalls: calls, error: true },
          output: withLogs([result.error.message, ...hints].join("\n"), logs),
          ...attached,
        } satisfies Tool.ExecuteResult<Metadata>
      }),
    }
    return init
  }),
)
