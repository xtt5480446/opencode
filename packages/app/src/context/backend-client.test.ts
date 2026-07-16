import { describe, expect, test } from "bun:test"
import type { ServerHealth } from "@/utils/server-health"
import { backendIdentity, createBackendForServer } from "./backend-client"

const server = {
  type: "http" as const,
  http: {
    url: "http://localhost:4096",
    username: "user",
    password: "secret",
  },
  authToken: false,
}

function setup(health: ServerHealth) {
  const requests: Request[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push(request)
    if (new URL(request.url).pathname === "/project")
      return new Response("[]", { headers: { "content-type": "application/json" } })
    return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
      headers: { "content-type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return {
    requests,
    fetch,
    backend: createBackendForServer({ server, browserUrl: "https://app.example.test", fetch, health: Promise.resolve(health) }),
  }
}

describe("createBackendForServer", () => {
  test("changes backend identity when credentials for the same URL change", () => {
    expect(backendIdentity(server)).not.toBe(
      backendIdentity({ ...server, http: { ...server.http, password: "replacement" } }),
    )
  })

  test("selects v2 and configures fetch and authentication", async () => {
    const result = setup({ healthy: true, version: "v2" })
    const backend = await result.backend

    expect(backend.version).toBe("v2")
    expect(result.requests).toHaveLength(0)
    await backend.common.health.get()
    expect(new URL(result.requests[0].url).pathname).toBe("/api/health")
    expect(result.requests[0].headers.get("authorization")).toBe(`Basic ${btoa("user:secret")}`)

    expect(backend.capabilities.projectList).toBeUndefined()
    expect(backend.capabilities.vcs).toBeUndefined()
    expect(backend.capabilities.mcp).toBeUndefined()
    expect(result.requests).toHaveLength(1)
    expect(backend.version).toBe("v2")
  })

  test("selects v1 after fallback detection", async () => {
    const result = setup({ healthy: true, version: "v1", installationVersion: "1.2.3" })
    const backend = await result.backend

    expect(backend.version).toBe("v1")
    expect(result.requests).toHaveLength(0)
    await backend.common.health.get()
    expect(new URL(result.requests[0].url).pathname).toBe("/global/health")
    expect(result.requests[0].headers.get("authorization")).toBe(`Basic ${btoa("user:secret")}`)
    expect(backend.capabilities.projectList).toBeDefined()
    expect(backend.capabilities.vcs).toBeDefined()
    expect(backend.capabilities.mcp).toBeDefined()
  })
})
