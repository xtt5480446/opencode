import { Agent } from "@/agent/agent"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Truncate } from "@/tool/truncate"
import { isRecord } from "@/util/record"
import { Token } from "@/util/token"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { asSchema, jsonSchema, tool, type Tool, type ToolExecutionOptions } from "ai"
import { Effect, Schema } from "effect"
import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import type { Context } from "@/tool/tool"
import { Session } from "./session"
import { SessionProcessor } from "./processor"
import { PartID } from "./schema"

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
- \`search_deferred_tools\` returns full schemas by default. For broad searches, omit schemas and search again with schemas if needed.
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
}

interface DeferredToolDescriptor {
  id: string
  description: string
  inputSchema: unknown
  searchText: string
}

const SearchDeferredToolsParameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "Words describing the external capability to find. Use an empty string to list the top deferred tools.",
  }),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_DEFERRED_TOOL_LIMIT)),
  ).annotate({
    description: `Maximum number of matches to return. Defaults to ${DEFAULT_DEFERRED_TOOL_LIMIT}; maximum ${MAX_DEFERRED_TOOL_LIMIT}.`,
  }),
  include_schema: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether to include input_schema for each match. Defaults to true. Set false for broad searches to return only tool_id and description.",
  }),
})

const CallDeferredToolParameters = Schema.Struct({
  tool_id: Schema.String.annotate({
    description: "Exact deferred tool_id copied from search_deferred_tools results.",
  }),
  arguments: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description: "JSON arguments for the deferred tool, matching its input_schema from search_deferred_tools.",
  }),
})
const decodeSearchDeferredToolsParameters = Schema.decodeUnknownEffect(SearchDeferredToolsParameters)
const decodeCallDeferredToolParameters = Schema.decodeUnknownEffect(CallDeferredToolParameters)

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
        ...(isRecord(rawResult) && isRecord(rawResult.metadata) ? rawResult.metadata : {}),
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
    deferredDescriptors.length > 0 && deferredToolSchemaTokens(deferredDescriptors) >= MIN_DEFERRED_MCP_SCHEMA_TOKENS

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

export const systemPrompt = Effect.fn("SessionMcpTools.systemPrompt")(function* (input: {
  agent: Agent.Info
  session: Session.Info
}) {
  const mcp = yield* MCP.Service
  const flags = yield* RuntimeFlags.Service
  if (!flags.experimentalToolSearch) return undefined

  const mcpTools = yield* mcp.tools()
  const mcpDisabled = Permission.disabled(
    Object.keys(mcpTools),
    Permission.merge(input.agent.permission, input.session.permission ?? []),
  )
  const allowedTools = Object.fromEntries(Object.entries(mcpTools).filter(([key]) => !mcpDisabled.has(key)))
  if (Object.keys(allowedTools).length === 0) return undefined

  const deferredDescriptors = yield* deferredToolDescriptors(allowedTools)
  if (deferredToolSchemaTokens(deferredDescriptors) < MIN_DEFERRED_MCP_SCHEMA_TOKENS) {
    return undefined
  }

  const servers = deferredServerSummaries(Object.keys(allowedTools), Object.keys(yield* mcp.clients()))
  return [
    DEFERRED_TOOL_SYSTEM_PROMPT,
    servers.length === 0
      ? undefined
      : [
          "Deferred MCP servers available through `search_deferred_tools`:",
          ...servers.map((server) => `- ${server.name}: ${server.count} tool${server.count === 1 ? "" : "s"}`),
        ].join("\n"),
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n")
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
  const addListTool = (spec: {
    id: string
    description: string
    serverDescription: string
    title: string
    resultKey: "resources" | "resourceTemplates"
    sortKey: "uri" | "uriTemplate"
    list: (server?: string) => Effect.Effect<Record<string, Record<string, unknown> & { client: string; name: string }>>
  }) => {
    tools[spec.id] = tool({
      description: spec.description,
      inputSchema: jsonSchema(
        ProviderTransform.schema(deps.input.model, {
          type: "object",
          properties: { server: { type: "string", description: spec.serverDescription } },
          additionalProperties: false,
        }),
      ),
      execute(args, opts) {
        return deps.run.promise(
          Effect.gen(function* () {
            const server = optionalString(toRecord(args), "server")
            const ctx = deps.context(toRecord(args), opts)
            const resourceServers = Object.entries(yield* deps.mcp.clients())
              .filter((entry) => !!entry[1].getServerCapabilities()?.resources)
              .map((entry) => entry[0])
              .sort((a, b) => a.localeCompare(b))
            if (server && !resourceServers.includes(server)) {
              throw new Error(
                resourceServers.length === 0
                  ? `MCP server "${server}" does not support resources`
                  : `MCP server "${server}" does not support resources. Available resource servers: ${resourceServers.join(", ")}`,
              )
            }
            const permissionPatterns = server ? [`mcp:${server}:*`] : resourceServers.map((item) => `mcp:${item}:*`)
            yield* deps.plugin.trigger(
              "tool.execute.before",
              { tool: spec.id, sessionID: ctx.sessionID, callID: opts.toolCallId },
              { args },
            )
            yield* ctx.ask({
              permission: "read",
              metadata: server ? { server } : {},
              patterns: permissionPatterns,
              always: permissionPatterns,
            })

            const filtered = Object.values(yield* spec.list(server))
              .filter((item) => !server || item.client === server)
              .toSorted((a, b) =>
                (a.client + "\u0000" + a.name + "\u0000" + String(a[spec.sortKey] ?? "")).localeCompare(
                  b.client + "\u0000" + b.name + "\u0000" + String(b[spec.sortKey] ?? ""),
                ),
              )
            const truncated = yield* deps.truncate.output(
              JSON.stringify(
                {
                  [spec.resultKey]: filtered.map((item) => {
                    const result = Object.fromEntries(Object.entries(item).filter((entry) => entry[0] !== "client"))
                    return { ...result, server: item.client }
                  }),
                },
                null,
                2,
              ),
              {},
              deps.input.agent,
            )
            const output = {
              title: server ? `${spec.title}: ${server}` : spec.title,
              metadata: {
                count: filtered.length,
                servers: resourceServers,
                ...(server ? { server } : {}),
                truncated: truncated.truncated,
                ...(truncated.truncated && { outputPath: truncated.outputPath }),
              },
              output: truncated.content,
            }
            yield* deps.plugin.trigger(
              "tool.execute.after",
              { tool: spec.id, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
              output,
            )
            if (opts.abortSignal?.aborted) yield* deps.input.processor.completeToolCall(opts.toolCallId, output)
            return output
          }),
        )
      },
    })
  }

  addListTool({
    id: "list_mcp_resources",
    description:
      "Lists resources provided by connected MCP servers. Resources provide context such as files, database schemas, or application-specific information.",
    serverDescription: "Optional MCP server name. When omitted, lists resources from every connected server.",
    title: "MCP resources",
    resultKey: "resources",
    sortKey: "uri",
    list: deps.mcp.resources,
  })
  addListTool({
    id: "list_mcp_resource_templates",
    description:
      "Lists resource templates provided by connected MCP servers. Resource templates are parameterized resources that can be read after filling in their URI template.",
    serverDescription: "Optional MCP server name. When omitted, lists resource templates from every connected server.",
    title: "MCP resource templates",
    resultKey: "resourceTemplates",
    sortKey: "uriTemplate",
    list: deps.mcp.resourceTemplates,
  })

  tools.read_mcp_resource = tool({
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
          const argRecord = toRecord(args)
          const server = requiredString(argRecord, "server")
          const uri = requiredString(argRecord, "uri")
          const ctx = deps.context(argRecord, opts)
          const client = (yield* deps.mcp.clients())[server]
          if (!client) throw new Error(`MCP server "${server}" is not connected`)
          if (!client.getServerCapabilities()?.resources)
            throw new Error(`MCP server "${server}" does not support resources`)
          yield* deps.plugin.trigger(
            "tool.execute.before",
            { tool: "read_mcp_resource", sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          yield* ctx.ask({
            permission: "read",
            metadata: { server, uri },
            patterns: [`mcp:${server}:${uri}`],
            always: [`mcp:${server}:*`],
          })

          const content = yield* deps.mcp.readResource(server, uri)
          if (!content) throw new Error(`Failed to read MCP resource: ${server}/${uri}`)

          const items = (Array.isArray(content.contents) ? content.contents : [content.contents]).filter(isRecord)
          const textParts: string[] = []
          const attachments: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const item of items) {
            const itemUri = typeof item.uri === "string" ? item.uri : uri
            const mime = typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream"
            if ("text" in item && typeof item.text === "string") {
              textParts.push(`Resource: ${itemUri}\nMIME: ${mime}\n${item.text}`)
              continue
            }
            if (!("blob" in item) || typeof item.blob !== "string") {
              textParts.push(`[MCP resource content without text or blob: ${itemUri}]`)
              continue
            }
            const size = base64Size(item.blob)
            if (!SUPPORTED_MCP_RESOURCE_ATTACHMENT_MIMES.has(mime)) {
              textParts.push(
                `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) is not a supported attachment type]`,
              )
              continue
            }
            if (size > MAX_MCP_RESOURCE_BLOB_BYTES) {
              textParts.push(
                `[Binary MCP resource omitted: ${itemUri} (${mime}, ${formatBytes(size)}) exceeds ${formatBytes(MAX_MCP_RESOURCE_BLOB_BYTES)}]`,
              )
              continue
            }
            textParts.push(`[Binary MCP resource attached: ${itemUri} (${mime})]`)
            attachments.push({
              type: "file",
              mime,
              url: `data:${mime};base64,${item.blob}`,
              filename: itemUri,
            })
          }

          const truncated = yield* deps.truncate.output(
            textParts.join("\n\n") || `MCP resource ${uri} from ${server} returned no contents.`,
            {},
            deps.input.agent,
          )
          const output = {
            title: `MCP resource: ${uri}`,
            metadata: {
              server,
              uri,
              contents: items.length,
              attachments: attachments.length,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: deps.input.processor.message.id,
            })),
          }
          yield* deps.plugin.trigger(
            "tool.execute.after",
            { tool: "read_mcp_resource", sessionID: ctx.sessionID, callID: opts.toolCallId, args },
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
      ProviderTransform.schema(deps.input.model, ToolJsonSchema.fromSchema(SearchDeferredToolsParameters)),
    ),
    execute(args, opts) {
      return deps.run.promise(
        Effect.gen(function* () {
          const params = yield* decodeSearchDeferredToolsParameters(args)
          const ctx = deps.context(toRecord(args), opts)
          yield* deps.plugin.trigger(
            "tool.execute.before",
            { tool: DEFERRED_TOOL_TOOLS.search, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const matches = searchDeferredTools(
            deps.deferredDescriptors,
            params.query,
            params.limit ?? DEFAULT_DEFERRED_TOOL_LIMIT,
          )
          const truncated = yield* deps.truncate.output(
            JSON.stringify(
              {
                tools: matches.map((descriptor) => ({
                  tool_id: descriptor.id,
                  description: descriptor.description,
                  ...((params.include_schema ?? true) ? { input_schema: descriptor.inputSchema } : {}),
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
              query: params.query,
              includeSchema: params.include_schema ?? true,
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
      ProviderTransform.schema(deps.input.model, ToolJsonSchema.fromSchema(CallDeferredToolParameters)),
    ),
    execute(args, opts) {
      return deps.run.promise(
        Effect.gen(function* () {
          const params = yield* decodeCallDeferredToolParameters(args)
          const item = deps.allowedMcpTools[params.tool_id]
          const execute = item?.execute
          if (!item || !execute) {
            throw new Error(
              `Deferred tool "${params.tool_id}" is not available. Use search_deferred_tools and copy a tool_id from the results.`,
            )
          }
          return yield* deps.executeMcpTool(params.tool_id, execute, params.arguments, opts)
        }),
      )
    },
  })
}

function toRecord(value: unknown) {
  if (isRecord(value)) return value
  return {}
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
          searchText: [
            id,
            item.description ?? "",
            ...(isRecord(schema) && isRecord(schema.properties)
              ? Object.entries(schema.properties).flatMap(([name, property]) =>
                  isRecord(property) && typeof property.description === "string"
                    ? [name, property.description]
                    : [name],
                )
              : []),
          ].join("\n"),
        }
      }),
    { concurrency: "unbounded" },
  )
}

function deferredToolSchemaTokens(descriptors: DeferredToolDescriptor[]) {
  return Token.estimate(
    JSON.stringify(
      descriptors.map((descriptor) => ({
        id: descriptor.id,
        description: descriptor.description,
        input_schema: descriptor.inputSchema,
      })),
    ),
  )
}

function deferredServerSummaries(toolIDs: string[], serverNames: string[]) {
  const prefixes = serverNames
    .map((name) => ({ name, prefix: McpCatalog.sanitize(name) + "_" }))
    .toSorted((a, b) => b.prefix.length - a.prefix.length || a.name.localeCompare(b.name))
  const counts = new Map<string, number>()
  for (const toolID of toolIDs) {
    const server = prefixes.find((candidate) => toolID.startsWith(candidate.prefix))
    if (!server) continue
    counts.set(server.name, (counts.get(server.name) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

function searchDeferredTools(descriptors: DeferredToolDescriptor[], query: string, limit: number) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && term !== "*")
  return descriptors
    .map((descriptor) => {
      const id = descriptor.id.toLowerCase()
      const description = descriptor.description.toLowerCase()
      const searchText = descriptor.searchText.toLowerCase()
      return {
        descriptor,
        score: terms.reduce(
          (score, term) =>
            score +
            (id === term ? 20 : 0) +
            (id.includes(term) ? 8 : 0) +
            (description.includes(term) ? 4 : 0) +
            (searchText.includes(term) ? 2 : 0),
          0,
        ),
      }
    })
    .filter((item) => terms.length === 0 || item.score > 0)
    .toSorted((a, b) => b.score - a.score || a.descriptor.id.localeCompare(b.descriptor.id))
    .slice(0, limit)
    .map((item) => item.descriptor)
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
