export * as WebSearchTool from "./websearch"

import type { Context as PluginContext } from "@opencode-ai/plugin/v2/effect/plugin"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Schema } from "effect"
import { Integration } from "../integration"
import { PositiveInt } from "../schema"
import { PermissionV2 } from "../permission"
import { Search } from "../search"
import { SearchExa } from "../plugin/search/exa"
import { SearchMcp } from "../plugin/search/mcp"
import { SearchParallel } from "../plugin/search/parallel"
import { Tool } from "./tool"

export const name = "websearch"
export const NO_RESULTS = "No search results found. Please try a different query."
export const EXA_URL = SearchExa.endpoint
export const PARALLEL_URL = SearchParallel.endpoint
export const MAX_NUM_RESULTS = 20
export const MAX_CONTEXT_CHARACTERS = 50_000
export const MAX_RESPONSE_BYTES = SearchMcp.MAX_RESPONSE_BYTES
export const parseResponse = SearchMcp.parseResponse

export const description = `Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.

Optional controls support result count, live crawling ('fallback' or 'preferred'), search type ('auto', 'fast', or 'deep'), and maximum context characters. Providers apply supported controls and otherwise use their defaults.

The current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`

export const Input = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_NUM_RESULTS))).annotate({
    description: `Number of search results to return (maximum: ${MAX_NUM_RESULTS})`,
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description: "Live crawl preference when supported by the selected provider",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search depth preference when supported by the selected provider",
  }),
  contextMaxCharacters: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_CONTEXT_CHARACTERS))).annotate(
    { description: `Maximum context characters (maximum: ${MAX_CONTEXT_CHARACTERS})` },
  ),
})

const Output = Schema.Struct({
  provider: Integration.ID,
  text: Schema.String,
  metadata: Schema.optional(Schema.Json),
})

export const Plugin = {
  id: "opencode.tool.websearch",
  effect: Effect.fn("WebSearchTool.Plugin")(function* (ctx: PluginContext) {
    const permission = yield* PermissionV2.Service
    const search = yield* Search.Service

    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
            execute: (input, context) =>
              Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [input.query],
                  save: ["*"],
                  metadata: input,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const result = yield* search.query({ ...input, sessionID: context.sessionID })
                return {
                  provider: result.providerID,
                  text: result.text || NO_RESULTS,
                  metadata: result.metadata,
                }
              }).pipe(
                Effect.mapError(
                  (error) => new ToolFailure({ message: `Unable to search the web for ${input.query}`, error }),
                ),
              ),
          }),
        ),
      )
      .pipe(Effect.orDie)
  }),
}
