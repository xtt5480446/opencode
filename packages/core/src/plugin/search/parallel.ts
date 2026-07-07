export * as SearchParallel from "./parallel"

import { define } from "@opencode-ai/plugin/v2/effect"
import { Effect, Schema, Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { InstallationVersion } from "../../installation/version"
import { SearchMcp } from "./mcp"

export const endpoint = "https://search.parallel.ai/mcp"

const Args = Schema.Struct({
  objective: Schema.String,
  search_queries: Schema.Array(Schema.String),
  session_id: Schema.String,
})

export const Plugin = define<HttpClient.HttpClient | Scope.Scope>({
  id: "opencode.search.parallel",
  effect: Effect.fn("SearchParallel.Plugin")(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    yield* ctx.integration.register({
      id: "parallel",
      name: "Parallel",
      methods: [
        { type: "key", label: "API key (optional)" },
        { type: "env", names: ["PARALLEL_API_KEY"] },
      ],
      search: {
        connection: "optional",
        execute: (input, context) =>
          SearchMcp.call(
            http,
            endpoint,
            "web_search",
            Args,
            {
              objective: input.query,
              search_queries: [input.query],
              session_id: context.sessionID ?? "opencode",
            },
            {
              "User-Agent": `opencode/${InstallationVersion}`,
              ...(context.credential?.type === "key" ? { Authorization: `Bearer ${context.credential.key}` } : {}),
            },
          ).pipe(Effect.map((text) => ({ text: text ?? "" }))),
      },
    })
  }),
})
