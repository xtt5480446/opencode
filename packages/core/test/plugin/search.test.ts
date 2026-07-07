import { beforeEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { SearchExa } from "@opencode-ai/core/plugin/search/exa"
import { SearchParallel } from "@opencode-ai/core/plugin/search/parallel"
import { host, integrationHost } from "./host"
import { requests, resetSearchFixture, searchIntegrationTest } from "./search-fixture"

beforeEach(() => {
  resetSearchFixture(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: "search results" }] },
    }),
  )
})

const it = searchIntegrationTest

describe("built-in search integrations", () => {
  it.effect("registers and disposes an atomic search integration", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const registration = yield* integrationHost(integrations).register({
        id: "test-search",
        name: "Test Search",
        methods: [{ type: "key", label: "API key" }],
        search: {
          connection: "required",
          execute: (input) => Effect.succeed({ text: input.query }),
        },
      })

      expect(yield* integrations.get(Integration.ID.make("test-search"))).toMatchObject({
        name: "Test Search",
        methods: [{ type: "key", label: "API key" }],
        capabilities: [{ type: "search", connection: "required" }],
      })
      yield* registration.dispose
      expect(yield* integrations.get(Integration.ID.make("test-search"))).toBeUndefined()
    }),
  )

  it.effect("registers Exa and maps search hints to its MCP tool", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      yield* SearchExa.Plugin.effect(host({ integration: integrationHost(integrations) }))

      const info = yield* integrations.get(Integration.ID.make("exa"))
      expect(info).toMatchObject({
        id: "exa",
        name: "Exa",
        methods: [{ type: "key" }, { type: "env", names: ["EXA_API_KEY"] }],
        capabilities: [{ type: "search", connection: "optional", selected: false }],
      })
      const provider = yield* integrations.capability.search.get(Integration.ID.make("exa"))
      if (!provider) return yield* Effect.die("Expected Exa search provider")
      expect(
        yield* provider.execute(
          {
            query: "effect typescript",
            numResults: 3,
            livecrawl: "preferred",
            type: "fast",
            contextMaxCharacters: 2500,
          },
          { credential: Credential.Key.make({ type: "key", key: "exa secret" }) },
        ),
      ).toEqual({ text: "search results" })
      expect(requests).toEqual([
        {
          url: `${SearchExa.endpoint}?exaApiKey=exa+secret`,
          headers: expect.any(Object),
          body: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "web_search_exa",
              arguments: {
                query: "effect typescript",
                type: "fast",
                numResults: 3,
                livecrawl: "preferred",
                contextMaxCharacters: 2500,
              },
            },
          },
        },
      ])
    }),
  )

  it.effect("registers Parallel and keeps its credential in the authorization header", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      yield* SearchParallel.Plugin.effect(host({ integration: integrationHost(integrations) }))
      const provider = yield* integrations.capability.search.get(Integration.ID.make("parallel"))
      if (!provider) return yield* Effect.die("Expected Parallel search provider")

      const output = yield* provider.execute(
        { query: "effect layers" },
        {
          sessionID: "ses_parallel",
          credential: Credential.Key.make({ type: "key", key: "parallel-secret" }),
        },
      )
      expect(output).toEqual({ text: "search results" })
      expect(requests[0]).toMatchObject({
        url: SearchParallel.endpoint,
        headers: { authorization: "Bearer parallel-secret" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "web_search",
            arguments: {
              objective: "effect layers",
              search_queries: ["effect layers"],
              session_id: "ses_parallel",
            },
          },
        },
      })
      expect(JSON.stringify(output)).not.toContain("parallel-secret")
    }),
  )
})
