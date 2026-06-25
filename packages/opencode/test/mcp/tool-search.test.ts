import { describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { McpToolSearch } from "../../src/mcp/tool-search"

function target(name: string, description: string, properties: JSONSchema7["properties"] = {}) {
  return tool({
    description,
    inputSchema: jsonSchema({
      type: "object",
      properties,
      additionalProperties: false,
    }),
    async execute(args) {
      return { title: name, metadata: { name }, output: JSON.stringify(args) }
    },
  })
}

async function catalog() {
  return McpToolSearch.create({
    tools: {
      github_create_issue: target("github_create_issue", "Create an issue in a GitHub repository", {
        title: { type: "string" },
      }),
      playwright_take_screenshot: target("playwright_take_screenshot", "Capture the browser page", {
        fullPage: { type: "boolean" },
      }),
    },
    schemas: {
      github_create_issue: {
        type: "object",
        properties: { title: { type: "string" } },
        additionalProperties: false,
      },
      playwright_take_screenshot: {
        type: "object",
        properties: { fullPage: { type: "boolean" } },
        additionalProperties: false,
      },
    },
    transformSchema: (schema) => schema,
  })
}

describe("MCP tool search", () => {
  test("uses direct tools below the token threshold", async () => {
    const tools = {
      github_create_issue: target("github_create_issue", "Create an issue"),
    }
    const schemas = { github_create_issue: { type: "object", properties: {} } } satisfies Record<string, JSONSchema7>
    expect(McpToolSearch.shouldUse(tools, schemas)).toBe(false)
  })

  test("uses search above the token threshold", async () => {
    const tools = {
      large_catalog: target("large_catalog", "x".repeat(60_000)),
    }
    const schemas = { large_catalog: { type: "object", properties: {} } } satisfies Record<string, JSONSchema7>
    expect(McpToolSearch.shouldUse(tools, schemas)).toBe(true)
  })

  test("detects control-name collisions", () => {
    expect(McpToolSearch.collides({ mcp_call: target("mcp_call", "Plugin tool") })).toBe(true)
    expect(McpToolSearch.collides({ other: target("other", "Plugin tool") })).toBe(false)
  })

  test("exposes only the three stable control tools", async () => {
    expect(Object.keys(await catalog())).toEqual(["mcp_search", "mcp_describe", "mcp_call"])
  })

  test("searches names, descriptions, and parameter names", async () => {
    const tools = await catalog()
    const result = (await tools.mcp_search!.execute?.(
      { query: "fullPage" },
      { toolCallId: "search", messages: [], abortSignal: new AbortController().signal },
    )) as { output: string }
    expect(result.output).toContain("playwright_take_screenshot")
    expect(result.output).not.toContain("github_create_issue")
  })

  test("fuzzy matches misspelled tool names", async () => {
    const tools = await catalog()
    const result = (await tools.mcp_search!.execute?.(
      { query: "screeshot" },
      { toolCallId: "search", messages: [], abortSignal: new AbortController().signal },
    )) as { output: string }
    expect(result.output).toContain("playwright_take_screenshot")
  })

  test("describes the full target schema", async () => {
    const tools = await catalog()
    const result = (await tools.mcp_describe!.execute?.(
      { id: "github_create_issue" },
      { toolCallId: "describe", messages: [], abortSignal: new AbortController().signal },
    )) as { output: string }
    expect(result.output).toContain('"title"')
    expect(result.output).toContain('"type": "string"')
  })

  test("describes the original schema before provider transforms", async () => {
    const tools = await McpToolSearch.create({
      tools: { search: target("search", "Search") },
      schemas: {
        search: {
          type: "object",
          properties: { query: { type: "string", pattern: "^[a-z]+$" } },
        },
      },
      transformSchema: (schema) => schema,
    })
    const result = (await tools.mcp_describe!.execute?.(
      { id: "search" },
      { toolCallId: "describe", messages: [], abortSignal: new AbortController().signal },
    )) as { output: string }
    expect(result.output).toContain('"pattern": "^[a-z]+$"')
  })

  test("calls the hidden target with structured arguments", async () => {
    const tools = await catalog()
    const result = (await tools.mcp_call!.execute?.(
      { id: "github_create_issue", args: { title: "Cache bug" } },
      { toolCallId: "call", messages: [], abortSignal: new AbortController().signal },
    )) as { output: string }
    expect(result.output).toBe('{"title":"Cache bug"}')
  })

  test("validates hidden target arguments before execution", async () => {
    let calls = 0
    const tools = McpToolSearch.create({
      tools: {
        create_issue: tool({
          inputSchema: jsonSchema({}),
          async execute() {
            calls++
            return { output: "called" }
          },
        }),
      },
      schemas: {
        create_issue: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
      },
      transformSchema: (schema) => schema,
    })
    expect(
      tools.mcp_call!.execute?.(
        { id: "create_issue", args: {} },
        { toolCallId: "call", messages: [], abortSignal: new AbortController().signal },
      ),
    ).rejects.toThrow('Invalid arguments for MCP tool "create_issue"')
    expect(calls).toBe(0)
  })

  test("suggests but does not execute inexact tool names", async () => {
    const tools = await McpToolSearch.create({
      tools: {
        github___create_issue: target("github___create_issue", "Create an issue"),
      },
      schemas: { github___create_issue: { type: "object", properties: {} } },
      transformSchema: (schema) => schema,
    })
    expect(
      tools.mcp_call!.execute?.(
        { id: "GitHub/create-issue", args: { title: "Cache bug" } },
        { toolCallId: "call", messages: [], abortSignal: new AbortController().signal },
      ),
    ).rejects.toThrow("Did you mean: github___create_issue?")
  })
})
