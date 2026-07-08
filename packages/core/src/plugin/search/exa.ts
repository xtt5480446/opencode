export * as SearchExa from "./exa"

import { define } from "@opencode-ai/plugin/v2/effect/plugin"
import { Effect, Schema, Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { SearchMcp } from "./mcp"

export const endpoint = "https://mcp.exa.ai/mcp"

const Args = Schema.Struct({
  query: Schema.String,
  type: Schema.String,
  numResults: Schema.Number,
  livecrawl: Schema.String,
  contextMaxCharacters: Schema.optional(Schema.Number),
})

export const Plugin = define<HttpClient.HttpClient | Scope.Scope>({
  id: "opencode.search.exa",
  effect: Effect.fn("SearchExa.Plugin")(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    yield* ctx.integration.register({
      id: "exa",
      name: "Exa",
      methods: [
        { type: "key", label: "API key (optional)" },
        { type: "env", names: ["EXA_API_KEY"] },
      ],
      search: {
        connection: "optional",
        execute: (input, context) => {
          const url = new URL(endpoint)
          if (context.credential?.type === "key") url.searchParams.set("exaApiKey", context.credential.key)
          return SearchMcp.call(http, url.toString(), "web_search_exa", Args, {
            query: input.query,
            type: input.type ?? "auto",
            numResults: input.numResults ?? 8,
            livecrawl: input.livecrawl ?? "fallback",
            contextMaxCharacters: input.contextMaxCharacters,
          }).pipe(Effect.map((text) => ({ text: text ?? "" })))
        },
      },
    })
  }),
})
