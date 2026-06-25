import { jsonSchema, tool, type JSONSchema7, type Tool, type ToolExecutionOptions } from "ai"
import fuzzysort from "fuzzysort"
import { Token } from "@opencode-ai/core/util/token"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type { JsonSchemaType, JsonSchemaValidator } from "@modelcontextprotocol/sdk/validation"

// Match Hermes defaults. OpenClaw independently uses the same maximum.
const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 20
const MAX_SEARCH_DESCRIPTION = 400
const SEARCH_THRESHOLD_TOKENS = 15_000
const CONTROL_NAMES = ["mcp_search", "mcp_describe", "mcp_call"]
const controls = new WeakSet<Tool>()
const validator = new AjvJsonSchemaValidator()

type Entry = {
  id: string
  description: string
  parameters: string
  schema: JSONSchema7
  validate: JsonSchemaValidator<Record<string, unknown>>
  tool: Tool
}

export function shouldUse(tools: Record<string, Tool>, schemas: Record<string, JSONSchema7>) {
  const catalog = Object.entries(tools)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, item]) => JSON.stringify({ name, description: item.description, inputSchema: schemas[name] }))
    .join("\n")
  return Token.estimate(catalog) > SEARCH_THRESHOLD_TOKENS
}

export function isControl(item: Tool) {
  return controls.has(item)
}

export function collides(tools: Record<string, Tool>) {
  return CONTROL_NAMES.some((name) => tools[name])
}

export function create(input: {
  tools: Record<string, Tool>
  schemas: Record<string, JSONSchema7>
  transformSchema: (schema: JSONSchema7) => JSONSchema7
}): Record<string, Tool> {
  const entries = new Map<string, Entry>(
    Object.entries(input.tools)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([id, item]) => {
        const schema = input.schemas[id]
        return [
          id,
          {
            id,
            description: item.description ?? "",
            parameters: Object.keys(schema.properties ?? {}).join(" "),
            schema,
            validate: validator.getValidator<Record<string, unknown>>(schema as JsonSchemaType),
            tool: item,
          },
        ] as const
      }),
  )

  if (entries.size === 0) return {}

  const result = {
    mcp_search: tool({
      description:
        "Search connected MCP tools by capability. Returns matching tool IDs and short descriptions. Use mcp_describe to inspect a tool before calling it.",
      inputSchema: jsonSchema<{ query: string; limit?: number }>(
        input.transformSchema({
          type: "object",
          properties: {
            query: { type: "string", description: "Capability, tool name, or keywords to search for." },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_SEARCH_LIMIT,
              description: `Maximum results to return (default ${DEFAULT_SEARCH_LIMIT}, maximum ${MAX_SEARCH_LIMIT}).`,
            },
          },
          required: ["query"],
          additionalProperties: false,
        }),
      ),
      async execute(args: { query: string; limit?: number }) {
        const query = args.query.trim()
        if (!query) throw new Error("query must be a non-empty string")
        const limit = Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(args.limit ?? DEFAULT_SEARCH_LIMIT)))
        const matches = search([...entries.values()], query, limit)
        return {
          title: `MCP tools matching ${args.query}`,
          metadata: { query: args.query, count: matches.length },
          output: JSON.stringify(
            {
              query,
              totalAvailable: entries.size,
              tools: matches.map((entry) => ({
                id: entry.id,
                description: entry.description.slice(0, MAX_SEARCH_DESCRIPTION),
              })),
            },
            null,
            2,
          ),
        }
      },
    }),
    mcp_describe: tool({
      description: "Return the full description and input schema for one MCP tool found with mcp_search.",
      inputSchema: jsonSchema<{ id: string }>(
        input.transformSchema({
          type: "object",
          properties: {
            id: { type: "string", description: "Exact MCP tool ID returned by mcp_search." },
          },
          required: ["id"],
          additionalProperties: false,
        }),
      ),
      async execute(args: { id: string }) {
        const entry = resolve(entries, args.id)
        return {
          title: entry.id,
          metadata: { id: entry.id },
          output: JSON.stringify({ id: entry.id, description: entry.description, inputSchema: entry.schema }, null, 2),
        }
      },
    }),
    mcp_call: tool({
      description:
        "Call an MCP tool by exact ID. Inspect unfamiliar tools with mcp_describe first. The underlying MCP tool's permissions and lifecycle hooks still apply.",
      inputSchema: jsonSchema<{ id: string; args?: Record<string, unknown> }>(
        input.transformSchema({
          type: "object",
          properties: {
            id: { type: "string", description: "Exact MCP tool ID returned by mcp_search." },
            args: {
              type: "object",
              description: "Arguments matching the input schema returned by mcp_describe.",
              additionalProperties: true,
            },
          },
          required: ["id"],
          additionalProperties: false,
        }),
      ),
      async execute(args: { id: string; args?: Record<string, unknown> }, options: ToolExecutionOptions) {
        const entry = resolve(entries, args.id)
        if (!entry.tool.execute) throw new Error(`MCP tool "${entry.id}" is not executable`)
        const result = entry.validate(args.args ?? {})
        if (!result.valid) throw new Error(`Invalid arguments for MCP tool "${entry.id}": ${result.errorMessage}`)
        return entry.tool.execute(result.data, options)
      },
    }),
  }
  for (const item of Object.values(result)) controls.add(item)
  return result
}

function resolve(entries: Map<string, Entry>, id: string) {
  const requested = id.trim()
  const entry = entries.get(requested)
  if (entry) return entry
  const suggestions = search([...entries.values()], requested.replaceAll(/[^a-zA-Z0-9]+/g, "_"), 3).map(
    (item) => item.id,
  )
  const hint = suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
  throw new Error(`Unknown MCP tool "${id}".${hint}`)
}

function search(entries: Entry[], query: string, limit: number) {
  return fuzzysort.go(query, entries, { keys: ["id", "description", "parameters"], limit }).map((item) => item.obj)
}

export * as McpToolSearch from "./tool-search"
