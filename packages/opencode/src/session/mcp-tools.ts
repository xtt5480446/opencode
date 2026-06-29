import { Agent } from "@/agent/agent"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Truncate } from "@/tool/truncate"
import { isRecord } from "@/util/record"
import { Token } from "@/util/token"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { asSchema, jsonSchema, tool, type Tool, type ToolExecutionOptions } from "ai"
import { Effect } from "effect"
import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import type { Context } from "@/tool/tool"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"

const MCP_RESOURCE_TOOLS = {
  list: "list_mcp_resources",
  listTemplates: "list_mcp_resource_templates",
  read: "read_mcp_resource",
} as const
const DEFERRED_TOOL_TOOLS = {
  search: "search_deferred_tools",
  call: "call_deferred_tool",
} as const
const MIN_DEFERRED_MCP_SCHEMA_TOKENS = 8_000
const DEFAULT_DEFERRED_TOOL_LIMIT = 10
const MAX_DEFERRED_TOOL_LIMIT = 20
const MAX_MCP_RESOURCE_BLOB_BYTES = 10 * 1024 * 1024
const SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES = new Set([
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

export const DEFERRED_TOOL_SYSTEM_PROMPT = `Deferred tools are separate from direct tools.
- Some MCP server tools may be hidden behind \`search_deferred_tools\` and \`call_deferred_tool\` to keep provider tool schemas small.
- Use \`search_deferred_tools\` to find deferred tools by purpose, tool ID, description, or parameter names.
- Use \`call_deferred_tool\` only with a \`tool_id\` copied from \`search_deferred_tools\` results.
- Never use deferred tools for direct tools already listed in the current tool list, including shell, file, search, edit, web, task, LSP, question, or apply_patch tools.`

interface Input {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: SessionV1.WithParts[]
  promptOps: TaskPromptOps
  remainingSteps?: number
}

interface DeferredToolDescriptor {
  id: string
  description: string
  inputSchema: unknown
  searchText: string
}

type McpToolContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
  | { type: "resource"; resource: Record<string, unknown> }

export const resolve = Effect.fn("SessionMcpTools.resolve")(function* (input: Input) {
  const tools: Record<string, Tool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service
  const flags = yield* RuntimeFlags.Service

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Context => ({
    sessionID: input.session.id,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  const executeMcpTool = Effect.fnUntraced(function* (
    key: string,
    execute: NonNullable<Tool["execute"]>,
    args: unknown,
    opts: ToolExecutionOptions,
  ) {
    const ctx = context(toRecord(args), opts)
    yield* plugin.trigger(
      "tool.execute.before",
      { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
      { args },
    )
    const rawResult = yield* Effect.gen(function* () {
      yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
      return yield* Effect.promise(() => Promise.resolve(execute(args, opts)))
    }).pipe(
      Effect.withSpan("Tool.execute", {
        attributes: {
          "tool.name": key,
          "tool.call_id": opts.toolCallId,
          "session.id": ctx.sessionID,
          "message.id": input.processor.message.id,
        },
      }),
    )
    yield* plugin.trigger(
      "tool.execute.after",
      { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
      rawResult,
    )

    const content = mcpToolContent(rawResult)
    const textParts: string[] = []
    const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
    for (const contentItem of content) {
      if (contentItem.type === "text") textParts.push(contentItem.text)
      else if (contentItem.type === "image") {
        attachments.push({
          type: "file",
          mime: contentItem.mimeType,
          url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
        })
      } else if (contentItem.type === "resource") {
        const resource = contentItem.resource
        if (typeof resource.text === "string") textParts.push(resource.text)
        if (typeof resource.blob === "string") {
          const uri = typeof resource.uri === "string" ? resource.uri : "resource"
          const mime = typeof resource.mimeType === "string" ? resource.mimeType : "application/octet-stream"
          const size = base64Size(resource.blob)
          if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
            textParts.push(
              `[Binary MCP resource omitted: ${uri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
            )
            continue
          }
          if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
            textParts.push(
              `[Binary MCP resource omitted: ${uri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
            )
            continue
          }
          attachments.push({
            type: "file",
            mime,
            url: `data:${mime};base64,${resource.blob}`,
            filename: uri,
          })
        }
      }
    }

    const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
    const output = {
      title: "",
      metadata: {
        ...mcpToolMetadata(rawResult),
        truncated: truncated.truncated,
        ...(truncated.truncated && { outputPath: truncated.outputPath }),
      },
      output: truncated.content,
      attachments: attachments.map((attachment) => ({
        ...attachment,
        id: PartID.ascending(),
        sessionID: ctx.sessionID,
        messageID: input.processor.message.id,
      })),
      content,
    }
    if (opts.abortSignal?.aborted) {
      yield* input.processor.completeToolCall(opts.toolCallId, output)
    }
    return output
  })

  const hasMcpResourceServer = Object.values(yield* mcp.clients()).some(
    (client) => !!client.getServerCapabilities()?.resources,
  )
  if (hasMcpResourceServer) addResourceTools(tools, { input, run, mcp, plugin, truncate, context })

  const mcpTools = yield* mcp.tools()
  const mcpDisabled = Permission.disabled(
    Object.keys(mcpTools),
    Permission.merge(input.agent.permission, input.session.permission ?? []),
  )
  const allowedMcpTools = Object.fromEntries(Object.entries(mcpTools).filter(([key]) => !mcpDisabled.has(key)))
  const deferredDescriptors =
    flags.experimentalToolSearch && Object.keys(allowedMcpTools).length > 0
      ? yield* deferredToolDescriptors(allowedMcpTools)
      : []
  const deferMcpTools =
    deferredDescriptors.length > 0 &&
    (input.remainingSteps ?? Infinity) >= 3 &&
    Token.estimate(JSON.stringify(deferredDescriptors.map(deferredToolEstimatePayload))) >=
      MIN_DEFERRED_MCP_SCHEMA_TOKENS

  if (deferMcpTools) {
    addDeferredTools(tools, {
      input,
      run,
      plugin,
      truncate,
      context,
      deferredDescriptors,
      allowedMcpTools,
      executeMcpTool,
    })
    return tools
  }

  for (const [key, item] of Object.entries(mcpTools)) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, { ...schema, properties: schema.properties ?? {} })
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) => run.promise(executeMcpTool(key, execute, args, opts))
    tools[key] = item
  }

  return tools
})

function addResourceTools(
  tools: Record<string, Tool>,
  deps: {
    input: Input
    run: EffectBridge.Shape
    mcp: MCP.Interface
    plugin: Plugin.Interface
    truncate: Truncate.Interface
    context: (args: Record<string, unknown>, options: ToolExecutionOptions) => Context
  },
) {
  tools[MCP_RESOURCE_TOOLS.list] = tool({
    description:
      "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
    inputSchema: jsonSchema(
      ProviderTransform.schema(deps.input.model, {
        type: "object",
        properties: {
          server: {
            type: "string",
            description: "Optional MCP server name. When omitted, lists resources from every connected server.",
          },
        },
        additionalProperties: false,
      }),
    ),
    execute(args, opts) {
      return deps.run.promise(
        Effect.gen(function* () {
          const parsed = parseListMcpResourcesArgs(args)
          const ctx = deps.context(toRecord(args), opts)
          const resourceServers = Object.entries(yield* deps.mcp.clients())
            .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
            .map((entry) => entry[0])
            .sort((a, b) => a.localeCompare(b))
          if (parsed.server && !resourceServers.includes(parsed.server)) {
            throw new Error(
              resourceServers.length === 0
                ? `MCP server "${parsed.server}" does not support resources`
                : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
            )
          }
          const permissionPatterns = parsed.server
            ? [`mcp:${parsed.server}:*`]
            : resourceServers.map((server) => `mcp:${server}:*`)
          yield* deps.plugin.trigger(
            "tool.execute.before",
            { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          yield* ctx.ask({
            permission: "read",
            metadata: parsed.server ? { server: parsed.server } : {},
            patterns: permissionPatterns,
            always: permissionPatterns,
          })

          const filtered = Object.values(yield* deps.mcp.resources(parsed.server))
            .filter((resource) => !parsed.server || resource.client === parsed.server)
            .toSorted((a, b) =>
              (a.client + "\u0000" + a.name + "\u0000" + a.uri).localeCompare(
                b.client + "\u0000" + b.name + "\u0000" + b.uri,
              ),
            )
          const truncated = yield* deps.truncate.output(
            JSON.stringify({ resources: filtered.map(formatMcpResource) }, null, 2),
            {},
            deps.input.agent,
          )
          const output = {
            title: parsed.server ? `MCP resources: ${parsed.server}` : "MCP resources",
            metadata: {
              count: filtered.length,
              servers: resourceServers,
              ...(parsed.server ? { server: parsed.server } : {}),
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
            output: truncated.content,
          }
          yield* deps.plugin.trigger(
            "tool.execute.after",
            { tool: MCP_RESOURCE_TOOLS.list, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            output,
          )
          if (opts.abortSignal?.aborted) yield* deps.input.processor.completeToolCall(opts.toolCallId, output)
          return output
        }),
      )
    },
  })

  tools[MCP_RESOURCE_TOOLS.listTemplates] = tool({
    description:
      "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
    inputSchema: jsonSchema(
      ProviderTransform.schema(deps.input.model, {
        type: "object",
        properties: {
          server: {
            type: "string",
            description: "Optional MCP server name. When omitted, lists resource templates from every connected server.",
          },
        },
        additionalProperties: false,
      }),
    ),
    execute(args, opts) {
      return deps.run.promise(
        Effect.gen(function* () {
          const parsed = parseListMcpResourcesArgs(args)
          const ctx = deps.context(toRecord(args), opts)
          const resourceServers = Object.entries(yield* deps.mcp.clients())
            .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
            .map((entry) => entry[0])
            .sort((a, b) => a.localeCompare(b))
          if (parsed.server && !resourceServers.includes(parsed.server)) {
            throw new Error(
              resourceServers.length === 0
                ? `MCP server "${parsed.server}" does not support resources`
                : `MCP server "${parsed.server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
            )
          }
          const permissionPatterns = parsed.server
            ? [`mcp:${parsed.server}:*`]
            : resourceServers.map((server) => `mcp:${server}:*`)
          yield* deps.plugin.trigger(
            "tool.execute.before",
            { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          yield* ctx.ask({
            permission: "read",
            metadata: parsed.server ? { server: parsed.server } : {},
            patterns: permissionPatterns,
            always: permissionPatterns,
          })

          const filtered = Object.values(yield* deps.mcp.resourceTemplates(parsed.server))
            .filter((template) => !parsed.server || template.client === parsed.server)
            .toSorted((a, b) =>
              (a.client + "\u0000" + a.name + "\u0000" + a.uriTemplate).localeCompare(
                b.client + "\u0000" + b.name + "\u0000" + b.uriTemplate,
              ),
            )
          const truncated = yield* deps.truncate.output(
            JSON.stringify({ resourceTemplates: filtered.map(formatMcpResourceTemplate) }, null, 2),
            {},
            deps.input.agent,
          )
          const output = {
            title: parsed.server ? `MCP resource templates: ${parsed.server}` : "MCP resource templates",
            metadata: {
              count: filtered.length,
              servers: resourceServers,
              ...(parsed.server ? { server: parsed.server } : {}),
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
            output: truncated.content,
          }
          yield* deps.plugin.trigger(
            "tool.execute.after",
            { tool: MCP_RESOURCE_TOOLS.listTemplates, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            output,
          )
          if (opts.abortSignal?.aborted) yield* deps.input.processor.completeToolCall(opts.toolCallId, output)
          return output
        }),
      )
    },
  })

  tools[MCP_RESOURCE_TOOLS.read] = tool({
    description:
      "Read a specific resource from an MCP server using the server name and resource URI. The URI is an MCP identifier and does not need to be a file URL.",
    inputSchema: jsonSchema(
      ProviderTransform.schema(deps.input.model, {
        type: "object",
        properties: {
          server: {
            type: "string",
            description: "MCP server name exactly as returned by list_mcp_resources.",
          },
          uri: {
            type: "string",
            description: "Resource URI to read. Use the exact URI string returned by list_mcp_resources.",
          },
        },
        required: ["server", "uri"],
        additionalProperties: false,
      }),
    ),
    execute(args, opts) {
      return deps.run.promise(
        Effect.gen(function* () {
          const parsed = parseReadMcpResourceArgs(args)
          const ctx = deps.context(toRecord(args), opts)
          const client = (yield* deps.mcp.clients())[parsed.server]
          if (!client) throw new Error(`MCP server "${parsed.server}" is not connected`)
          if (!client.getServerCapabilities()?.resources) {
            throw new Error(`MCP server "${parsed.server}" does not support resources`)
          }
          yield* deps.plugin.trigger(
            "tool.execute.before",
            { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          yield* ctx.ask({
            permission: "read",
            metadata: { server: parsed.server, uri: parsed.uri },
            patterns: [`mcp:${parsed.server}:${parsed.uri}`],
            always: [`mcp:${parsed.server}:*`],
          })

          const content = yield* deps.mcp.readResource(parsed.server, parsed.uri)
          if (!content) throw new Error(`Failed to read MCP resource: ${parsed.server}/${parsed.uri}`)

          const formatted = formatMcpResourceContent(parsed.server, parsed.uri, content)
          const truncated = yield* deps.truncate.output(formatted.text, {}, deps.input.agent)
          const output = {
            title: `MCP resource: ${parsed.uri}`,
            metadata: {
              server: parsed.server,
              uri: parsed.uri,
              contents: formatted.contents,
              attachments: formatted.attachments.length,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
            output: truncated.content,
            attachments: formatted.attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: deps.input.processor.message.id,
            })),
          }
          yield* deps.plugin.trigger(
            "tool.execute.after",
            { tool: MCP_RESOURCE_TOOLS.read, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            output,
          )
          if (opts.abortSignal?.aborted) yield* deps.input.processor.completeToolCall(opts.toolCallId, output)
          return output
        }),
      )
    },
  })
}

function addDeferredTools(
  tools: Record<string, Tool>,
  deps: {
    input: Input
    run: EffectBridge.Shape
    plugin: Plugin.Interface
    truncate: Truncate.Interface
    context: (args: Record<string, unknown>, options: ToolExecutionOptions) => Context
    deferredDescriptors: DeferredToolDescriptor[]
    allowedMcpTools: Record<string, Tool>
    executeMcpTool: (
      key: string,
      execute: NonNullable<Tool["execute"]>,
      args: unknown,
      opts: ToolExecutionOptions,
    ) => Effect.Effect<unknown>
  },
) {
  tools[DEFERRED_TOOL_TOOLS.search] = tool({
    description:
      "Search only deferred tools. Deferred tools are not listed as direct tools; currently they are MCP server tools hidden to keep the provider tool list small. Do not use this for direct tools such as shell, file, edit, grep, glob, web, task, LSP, question, or apply_patch tools.",
    inputSchema: jsonSchema(
      ProviderTransform.schema(deps.input.model, {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Words describing the external capability to find. Use an empty string to list the top deferred tools.",
          },
          limit: {
            type: "number",
            description: `Maximum number of matches to return. Defaults to ${DEFAULT_DEFERRED_TOOL_LIMIT}; maximum ${MAX_DEFERRED_TOOL_LIMIT}.`,
          },
        },
        required: ["query"],
        additionalProperties: false,
      }),
    ),
    execute(args, opts) {
      return deps.run.promise(
        Effect.gen(function* () {
          const parsed = parseSearchDeferredToolsArgs(args)
          const ctx = deps.context(toRecord(args), opts)
          yield* deps.plugin.trigger(
            "tool.execute.before",
            { tool: DEFERRED_TOOL_TOOLS.search, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const matches = searchDeferredTools(deps.deferredDescriptors, parsed.query, parsed.limit)
          const truncated = yield* deps.truncate.output(
            JSON.stringify(
              {
                tools: matches.map((descriptor) => ({
                  tool_id: descriptor.id,
                  description: descriptor.description,
                  input_schema: descriptor.inputSchema,
                })),
              },
              null,
              2,
            ),
            {},
            deps.input.agent,
          )
          const output = {
            title: "Deferred tools search",
            metadata: {
              query: parsed.query,
              count: matches.length,
              total: deps.deferredDescriptors.length,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
            output: truncated.content,
          }
          yield* deps.plugin.trigger(
            "tool.execute.after",
            { tool: DEFERRED_TOOL_TOOLS.search, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            output,
          )
          if (opts.abortSignal?.aborted) yield* deps.input.processor.completeToolCall(opts.toolCallId, output)
          return output
        }),
      )
    },
  })

  tools[DEFERRED_TOOL_TOOLS.call] = tool({
    description:
      "Call one deferred tool by tool_id after finding it with search_deferred_tools. Do not use this for direct tools such as shell, file, edit, grep, glob, web, task, LSP, question, or apply_patch tools.",
    inputSchema: jsonSchema(
      ProviderTransform.schema(deps.input.model, {
        type: "object",
        properties: {
          tool_id: {
            type: "string",
            description: "Exact deferred tool_id copied from search_deferred_tools results.",
          },
          arguments: {
            type: "object",
            description: "JSON arguments for the deferred tool, matching its input_schema from search_deferred_tools.",
            additionalProperties: true,
          },
        },
        required: ["tool_id", "arguments"],
        additionalProperties: false,
      }),
    ),
    execute(args, opts) {
      return deps.run.promise(
        Effect.gen(function* () {
          const parsed = parseCallDeferredToolArgs(args)
          const item = deps.allowedMcpTools[parsed.toolID]
          const execute = item?.execute
          if (!item || !execute) {
            throw new Error(
              `Deferred tool "${parsed.toolID}" is not available. Use search_deferred_tools and copy a tool_id from the results.`,
            )
          }
          return yield* deps.executeMcpTool(parsed.toolID, execute, parsed.arguments, opts)
        }),
      )
    },
  })
}

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
}

function parseListMcpResourcesArgs(value: unknown) {
  const args = toRecord(value)
  return { server: optionalString(args, "server") }
}

function parseReadMcpResourceArgs(value: unknown) {
  const args = toRecord(value)
  return { server: requiredString(args, "server"), uri: requiredString(args, "uri") }
}

function parseSearchDeferredToolsArgs(value: unknown) {
  const args = toRecord(value)
  return {
    query: optionalString(args, "query") ?? "",
    limit: optionalPositiveInteger(args, "limit") ?? DEFAULT_DEFERRED_TOOL_LIMIT,
  }
}

function parseCallDeferredToolArgs(value: unknown) {
  const args = toRecord(value)
  return {
    toolID: requiredString(args, "tool_id"),
    arguments: optionalRecord(args, "arguments") ?? {},
  }
}

function optionalString(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

function requiredString(args: Record<string, unknown>, key: string) {
  const value = optionalString(args, key)
  if (value) return value
  throw new Error(`${key} is required`)
}

function optionalPositiveInteger(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`)
  }
  return Math.min(value, MAX_DEFERRED_TOOL_LIMIT)
}

function optionalRecord(args: Record<string, unknown>, key: string) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (isRecord(value)) return value
  throw new Error(`${key} must be an object`)
}

function deferredToolDescriptors(tools: Record<string, Tool>) {
  return Effect.forEach(
    Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b)),
    ([id, item]) =>
      Effect.gen(function* () {
        const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
        return {
          id,
          description: item.description ?? "",
          inputSchema: schema,
          searchText: [id, item.description ?? "", ...schemaTerms(schema)].join("\n"),
        }
      }),
    { concurrency: "unbounded" },
  )
}

function deferredToolEstimatePayload(descriptor: DeferredToolDescriptor) {
  return { id: descriptor.id, description: descriptor.description, input_schema: descriptor.inputSchema }
}

function searchDeferredTools(descriptors: DeferredToolDescriptor[], query: string, limit: number) {
  const terms = searchTerms(query)
  return descriptors
    .map((descriptor) => ({ descriptor, score: scoreDeferredTool(descriptor, terms) }))
    .filter((item) => terms.length === 0 || item.score > 0)
    .toSorted((a, b) => b.score - a.score || a.descriptor.id.localeCompare(b.descriptor.id))
    .slice(0, limit)
    .map((item) => item.descriptor)
}

function scoreDeferredTool(descriptor: DeferredToolDescriptor, terms: string[]) {
  const id = descriptor.id.toLowerCase()
  const description = descriptor.description.toLowerCase()
  const searchText = descriptor.searchText.toLowerCase()
  return terms.reduce(
    (score, term) =>
      score +
      (id === term ? 20 : 0) +
      (id.includes(term) ? 8 : 0) +
      (description.includes(term) ? 4 : 0) +
      (searchText.includes(term) ? 2 : 0),
    0,
  )
}

function searchTerms(query: string) {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && term !== "*")
}

function schemaTerms(schema: unknown) {
  if (!isRecord(schema) || !isRecord(schema.properties)) return []
  return Object.entries(schema.properties).flatMap(([name, property]) => {
    if (!isRecord(property) || typeof property.description !== "string") return [name]
    return [name, property.description]
  })
}

function mcpToolContent(result: unknown): McpToolContent[] {
  if (!isRecord(result) || !Array.isArray(result.content)) return []
  return result.content.flatMap((item): McpToolContent[] => {
    if (!isRecord(item) || typeof item.type !== "string") return []
    if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }]
    if (item.type === "image" && typeof item.mimeType === "string" && typeof item.data === "string") {
      return [{ type: "image", mimeType: item.mimeType, data: item.data }]
    }
    if (item.type === "resource" && isRecord(item.resource)) return [{ type: "resource", resource: item.resource }]
    return []
  })
}

function mcpToolMetadata(result: unknown) {
  if (!isRecord(result) || !isRecord(result.metadata)) return {}
  return result.metadata
}

function formatMcpResource(resource: MCP.Resource) {
  const result = Object.fromEntries(Object.entries(resource).filter((entry) => entry[0] !== "client"))
  return { ...result, server: resource.client }
}

function formatMcpResourceTemplate(template: Record<string, unknown> & { client: string }) {
  const result = Object.fromEntries(Object.entries(template).filter((entry) => entry[0] !== "client"))
  return { ...result, server: template.client }
}

function formatMcpResourceContent(server: string, uri: string, content: { contents: unknown }) {
  const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
  const text: string[] = []
  const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []

  for (const item of items) {
    const itemUri = typeof item.uri === "string" ? item.uri : uri
    const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
    if (typeof item.text === "string") {
      text.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
      continue
    }
    if (typeof item.blob === "string") {
      const size = base64Size(item.blob)
      if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
        )
        continue
      }
      if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
        text.push(
          `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
        )
        continue
      }
      text.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
      attachments.push({
        type: "file",
        mime,
        url: `data:${mime};base64,${item.blob}`,
        filename: itemUri,
      })
      continue
    }
    text.push(`[MCP resource content without text or blob: ${itemUri}]`)
  }

  return {
    contents: items.length,
    attachments,
    text: text.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
  }
}

function base64Size(value: string) {
  const trimmed = value.replace(/\s/g, "")
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`
  return `${Math.ceil(value / (1024 * 1024))} MB`
}

export * as SessionMcpTools from "./mcp-tools"
