export * as SearchExa from "./exa"

import { define } from "@opencode-ai/plugin/v2/effect/plugin"
import { Effect, Schema, Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { SearchMcp } from "./mcp"

export const endpoint = "https://mcp.exa.ai/mcp"

const Input = Schema.Struct({
  query: Schema.String,
  numResults: Schema.Number.pipe(Schema.optional),
})

const Output = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("text"),
      text: Schema.String,
      _meta: Schema.Struct({ searchTime: Schema.Number }).pipe(Schema.optional),
    }),
  ),
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
          return SearchMcp.call(
            http,
            url.toString(),
            "web_search_exa",
            { input: Input, output: Output },
            { query: input.query },
          ).pipe(
            Effect.map((result) => {
              const content = result?.content.find((item) => item.text)
              return {
                text: content?.text ?? "",
                ...(content?._meta ? { metadata: content._meta } : {}),
              }
            }),
          )
        },
      },
    })
  }),
})
