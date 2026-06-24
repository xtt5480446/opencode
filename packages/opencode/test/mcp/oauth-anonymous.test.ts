import { afterAll, expect } from "bun:test"
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 })

    const message = (await request.json()) as { id?: number; method: string }
    if (message.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "anonymous-oauth-test", version: "1" },
        },
      })
    }
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
    if (message.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [{ name: "protected", inputSchema: { type: "object", properties: {} } }],
        },
      })
    }
    if (message.method === "tools/call") {
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${server.url}.well-known/oauth-protected-resource"` },
      })
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
  },
})

afterAll(() => server.stop(true))

const it = testEffect(MCP.defaultLayer)

it.instance(
  "explicit auth fails when anonymous initialize and catalog emit no OAuth challenge",
  () =>
    MCP.Service.use((mcp) =>
      Effect.gen(function* () {
        const added = yield* mcp.add("anonymous-oauth", { type: "remote", url: server.url.toString() })
        expect(added.status).toEqual({ "anonymous-oauth": { status: "connected" } })
        expect(Object.keys(yield* mcp.tools())).toEqual(["anonymous-oauth_protected"])

        const protectedResponse = yield* Effect.promise(() =>
          fetch(server.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "protected", arguments: {} },
            }),
          }),
        )
        expect(protectedResponse.status).toBe(401)

        const result = yield* mcp.authenticate("anonymous-oauth")
        expect(result).toEqual({
          status: "failed",
          error:
            "The server did not issue a standard OAuth challenge. Anonymous MCP access remains available, but authentication was not completed. Verify the server's OAuth configuration or use credentials supported by the server.",
        })
        expect(yield* mcp.hasStoredTokens("anonymous-oauth")).toBe(false)
        expect(yield* mcp.status()).toEqual({ "anonymous-oauth": { status: "connected" } })
      }),
    ),
  { config: { mcp: { "anonymous-oauth": { type: "remote", url: server.url.toString() } } } },
)
