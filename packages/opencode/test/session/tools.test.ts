import { describe, expect } from "bun:test"
import { jsonSchema, tool, type ToolExecutionOptions } from "ai"
import { Effect, Layer } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionTools } from "@/session/tools"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Plugin } from "@/plugin"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const model = ProviderTest.model()
const sessionID = SessionID.make("ses_deferred-tools")
const largeSchemaDescription = "analytics trends schema ".repeat(10_000)
const mcpClient = Object.assign(new Client({ name: "test", version: "0.0.0" }), {
  getServerCapabilities: () => ({}),
})
const agent = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
} satisfies Agent.Info
const session = {
  id: sessionID,
  slug: "deferred-tools",
  projectID: ProjectV2.ID.make("proj_deferred-tools"),
  directory: "/tmp/project",
  title: "Deferred tools",
  version: "0.0.0",
  time: { created: 0, updated: 0 },
} satisfies Session.Info
const assistant = {
  id: MessageID.make("msg_assistant"),
  parentID: MessageID.make("msg_user"),
  role: "assistant",
  mode: agent.name,
  agent: agent.name,
  path: { cwd: session.directory, root: session.directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: ModelV2.ID.make(model.id),
  providerID: ProviderV2.ID.make(model.providerID),
  time: { created: 0 },
  sessionID,
} satisfies SessionV1.Assistant
const processor = {
  message: assistant,
  updateToolCall: () => Effect.succeed(undefined),
  completeToolCall: () => Effect.void,
}
const promptOps = {
  cancel: () => Effect.void,
  resolvePromptParts: () => Effect.succeed([]),
  prompt: () => Effect.die(new Error("unexpected task prompt")),
}
const toolExecutionOptions = {
  toolCallId: "call_deferred",
  abortSignal: new AbortController().signal,
  messages: [],
} satisfies ToolExecutionOptions

const makeIt = (input: { flags: Parameters<typeof RuntimeFlags.layer>[0]; queryDescription: string }) =>
  testEffect(
    Layer.mergeAll(
      Layer.mock(MCP.Service, {
        clients: () => Effect.succeed({ posthog: mcpClient }),
        tools: () =>
          Effect.succeed({
            posthog_query_trends: tool({
              description: "Query product analytics trends and charts",
              inputSchema: jsonSchema({
                type: "object",
                properties: {
                  query: { type: "string", description: input.queryDescription },
                  date_range: { type: "string", description: "Date range for the trends query" },
                },
                required: ["query"],
              }),
              execute: async () => ({ content: [{ type: "text", text: "trend result" }] }),
            }),
            posthog_feature_flags: tool({
              description: "List and manage feature flags",
              inputSchema: jsonSchema({ type: "object", properties: {} }),
              execute: async () => ({ content: [{ type: "text", text: "flag result" }] }),
            }),
          }),
      }),
      Layer.mock(ToolRegistry.Service, {
        tools: () => Effect.succeed([]),
      }),
      Layer.mock(Permission.Service, {
        ask: () => Effect.void,
      }),
      Layer.mock(Truncate.Service, {
        output: (text) => Effect.succeed({ content: text, truncated: false as const }),
      }),
      Layer.succeed(
        Plugin.Service,
        Plugin.Service.of({
          init: () => Effect.void,
          list: () => Effect.succeed([]),
          trigger: ((_name, _input, output) => Effect.succeed(output)) as Plugin.Interface["trigger"],
        }),
      ),
      RuntimeFlags.layer(input.flags),
    ),
  )

const deferredIt = makeIt({ flags: { experimentalToolSearch: true }, queryDescription: largeSchemaDescription })
const directIt = makeIt({ flags: { experimentalToolSearch: false }, queryDescription: largeSchemaDescription })
const belowThresholdIt = makeIt({
  flags: { experimentalToolSearch: true },
  queryDescription: "Natural language analytics query",
})

function resolveTools() {
  return SessionTools.resolve({
    agent,
    model,
    session,
    processor,
    bypassAgentCheck: false,
    messages: [],
    promptOps,
  })
}

describe("session.tools", () => {
  deferredIt.instance("defers MCP tools behind fixed search and call tools", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()

      expect(Object.keys(tools).sort()).toEqual(["call_deferred_tool", "search_deferred_tools"])

      const search = tools.search_deferred_tools.execute
      if (!search) throw new Error("missing search_deferred_tools executor")
      const searchResult = yield* Effect.promise(() =>
        Promise.resolve(search({ query: "analytics trends" }, toolExecutionOptions)),
      )
      const parsed = JSON.parse(searchResult.output) as { tools: Array<{ tool_id: string; input_schema?: unknown }> }
      expect(parsed.tools.map((item) => item.tool_id)).toContain("posthog_query_trends")
      expect(parsed.tools.find((item) => item.tool_id === "posthog_query_trends")?.input_schema).toBeDefined()

      const conciseResult = yield* Effect.promise(() =>
        Promise.resolve(search({ query: "analytics trends", include_schema: false }, toolExecutionOptions)),
      )
      const concise = JSON.parse(conciseResult.output) as { tools: Array<{ tool_id: string; input_schema?: unknown }> }
      expect(concise.tools.map((item) => item.tool_id)).toContain("posthog_query_trends")
      expect(concise.tools.find((item) => item.tool_id === "posthog_query_trends")?.input_schema).toBeUndefined()

      const call = tools.call_deferred_tool.execute
      if (!call) throw new Error("missing call_deferred_tool executor")
      const callResult = yield* Effect.promise(() =>
        Promise.resolve(
          call({ tool_id: "posthog_query_trends", arguments: { query: "signups over time" } }, toolExecutionOptions),
        ),
      )
      expect(callResult.output).toBe("trend result")
    }),
  )

  deferredIt.instance("lists deferred MCP servers in the system prompt", () =>
    Effect.gen(function* () {
      const prompt = yield* SessionTools.deferredSystemPrompt({ agent, session })

      expect(prompt).toContain("Deferred MCP servers available through `search_deferred_tools`:")
      expect(prompt).toContain("- posthog: 2 tools")
    }),
  )

  directIt.instance("keeps MCP tools direct when tool search is disabled", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()

      expect(Object.keys(tools).sort()).toEqual(["posthog_feature_flags", "posthog_query_trends"])
    }),
  )

  belowThresholdIt.instance("keeps MCP tools direct below the fixed deferral threshold", () =>
    Effect.gen(function* () {
      const tools = yield* resolveTools()

      expect(Object.keys(tools).sort()).toEqual(["posthog_feature_flags", "posthog_query_trends"])
    }),
  )
})
