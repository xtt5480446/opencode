import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk-v1/v2/client"
import { createV1Backend } from "./backend-v1"

function setup(respond: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = []
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return respond(request)
    },
    { preconnect: globalThis.fetch.preconnect },
  ) satisfies typeof globalThis.fetch
  return {
    requests,
    backend: createV1Backend(createOpencodeClient({ baseUrl: "http://localhost", fetch })),
  }
}

function json(data: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  })
}

const session = {
  id: "ses_1",
  slug: "one",
  projectID: "project",
  directory: "/repo",
  title: "Session",
  version: "1",
  time: { created: 1, updated: 2 },
}

describe("createV1Backend", () => {
  test("normalizes session pagination and location", async () => {
    const setupResult = setup(() => json([session], { "x-next-cursor": "456" }))

    const result = await setupResult.backend.common.sessions.list({
      location: { directory: "/repo", workspaceID: "workspace" },
      roots: true,
      limit: 10,
      cursor: "123",
    })

    expect(result).toEqual({
      items: [
        {
          id: "ses_1",
          parentID: undefined,
          projectID: "project",
          location: { directory: "/repo", workspaceID: undefined },
          title: "Session",
          cost: 0,
          tokens: undefined,
          time: { created: 1, updated: 2 },
          share: undefined,
          revert: undefined,
        },
      ],
      next: "456",
    })
    const url = new URL(setupResult.requests[0].url)
    expect(url.pathname).toBe("/experimental/session")
    expect(url.searchParams.get("directory")).toBe("/repo")
    expect(url.searchParams.get("workspace")).toBe("workspace")
    expect(url.searchParams.get("roots")).toBe("true")
    expect(url.searchParams.get("cursor")).toBe("123")
  })

  test("converts normalized prompts to legacy parts", async () => {
    const setupResult = setup(() => new Response(null, { status: 204 }))

    await setupResult.backend.common.sessions.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "hello",
      selection: {
        agent: "build",
        model: { id: "model", providerID: "provider", variant: "high" },
      },
      files: [{ uri: "data:text/plain;base64,aGk=", name: "hi.txt", mime: "text/plain" }],
      agents: [{ name: "explore", text: "@explore", start: 6, end: 14 }],
    })

    const request = setupResult.requests[0]
    expect(new URL(request.url).pathname).toBe("/session/ses_1/prompt_async")
    expect(await request.json()).toEqual({
      messageID: "msg_1",
      model: { providerID: "provider", modelID: "model" },
      agent: "build",
      variant: "high",
      parts: [
        { type: "text", text: "hello" },
        { type: "file", mime: "text/plain", filename: "hi.txt", url: "data:text/plain;base64,aGk=" },
        { type: "agent", name: "explore", source: { value: "@explore", start: 6, end: 14 } },
      ],
    })
  })

  test("combines mixed file search and decodes binary content", async () => {
    const setupResult = setup((request) => {
      const url = new URL(request.url)
      if (url.pathname === "/find/file") {
        return json(url.searchParams.get("type") === "file" ? ["a.txt", "shared"] : ["dir", "shared"])
      }
      return json({ type: "binary", content: "AAEC", encoding: "base64", mimeType: "application/octet-stream" })
    })

    const found = await setupResult.backend.common.files.find({ query: "a" })
    const content = await setupResult.backend.common.files.read({ path: "a.bin" })

    expect(found).toEqual([
      { path: "a.txt", type: "file" },
      { path: "shared", type: "directory" },
      { path: "dir", type: "directory" },
    ])
    expect([...content.bytes]).toEqual([0, 1, 2])
    expect(content.kind).toBe("binary")
    expect(content.mimeType).toBe("application/octet-stream")
  })

  test("merges global config updates with untouched fields", async () => {
    const bodies: unknown[] = []
    const setupResult = setup(async (request) => {
      if (request.method === "GET") return json({ autoupdate: true, model: "old", disabled_providers: ["one"] })
      bodies.push(await request.json())
      return json({})
    })

    await setupResult.backend.capabilities.configuration?.updateGlobal({
      model: "new",
      disabledProviders: ["two"],
    })

    expect(bodies).toEqual([{ autoupdate: true, model: "new", disabled_providers: ["two"] }])
  })
})
