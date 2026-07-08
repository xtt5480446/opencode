import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Integration } from "@opencode-ai/core/integration"
import { Search } from "@opencode-ai/core/search"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { WebSearchTool } from "@opencode-ai/core/tool/websearch"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const webSearchToolNode = makeLocationNode({
  name: "test/websearch-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(WebSearchTool.Plugin)),
  deps: [ToolRegistry.toolsNode, PermissionV2.node, Search.node],
})

const sessionID = SessionV2.ID.make("ses_websearch_test")
const assertions: PermissionV2.AssertInput[] = []
const queries: Search.QueryInput[] = []
let result = new Search.Result({ providerID: Integration.ID.make("exa"), text: "search results" })

beforeEach(() => {
  assertions.length = 0
  queries.length = 0
  result = new Search.Result({ providerID: Integration.ID.make("exa"), text: "search results" })
})

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const search = Layer.succeed(
  Search.Service,
  Search.Service.of({
    selected: () => Effect.succeed(undefined),
    select: () => Effect.die("unused"),
    query: (input) =>
      Effect.sync(() => {
        queries.push(input)
        return result
      }),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, Search.node, webSearchToolNode]), [
    [PermissionV2.node, permission],
    [Search.node, search],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ]),
)

describe("WebSearchTool registration", () => {
  it.effect("asserts permission before delegating to Search", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["websearch"])
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-search",
            name: "websearch",
            input: { query: "effect typescript" },
          },
        }),
      ).toEqual({ type: "text", value: "search results" })
      expect(assertions).toMatchObject([
        {
          sessionID,
          action: "websearch",
          resources: ["effect typescript"],
          save: ["*"],
          metadata: { query: "effect typescript" },
        },
      ])
      expect(queries).toEqual([
        {
          sessionID,
          query: "effect typescript",
        },
      ])
    }),
  )

  it.effect("keeps provider metadata in structured output", () =>
    Effect.gen(function* () {
      result = new Search.Result({
        providerID: Integration.ID.make("parallel"),
        text: "parallel results",
        metadata: { requestID: "req_1" },
      })
      const registry = yield* ToolRegistry.Service

      expect(
        yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-parallel", name: "websearch", input: { query: "effect layers" } },
        }),
      ).toEqual({
        result: { type: "text", value: "parallel results" },
        output: {
          structured: { provider: "parallel", text: "parallel results", metadata: { requestID: "req_1" } },
          content: [{ type: "text", text: "parallel results" }],
        },
      })
    }),
  )

  it.effect("uses the concise no-results fallback", () =>
    Effect.gen(function* () {
      result = new Search.Result({ providerID: Integration.ID.make("exa"), text: "" })
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-empty", name: "websearch", input: { query: "nothing" } },
        }),
      ).toEqual({ type: "text", value: WebSearchTool.NO_RESULTS })
    }),
  )
})
