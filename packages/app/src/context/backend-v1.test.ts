import { describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk-v1/v2/client"
import type { PtyTransportConfig } from "./backend"
import { createV1Backend } from "./backend-v1"

function setup(
  respond: (request: Request) => Response | Promise<Response>,
  withDefault = false,
  transport?: Partial<Pick<PtyTransportConfig, "sameOrigin" | "authToken">>,
) {
  const requests: Request[] = []
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push(request)
      return respond(request)
    },
    { preconnect: globalThis.fetch.preconnect },
  ) satisfies typeof globalThis.fetch
  const client = createOpencodeClient({ baseUrl: "http://localhost", fetch })
  return {
    requests,
    backend: createV1Backend(
      client,
      withDefault ? { directory: "/default", workspaceID: "default-workspace" } : undefined,
      client,
      {
        baseUrl: "http://localhost",
        fetch,
        username: "user",
        password: "secret",
        sameOrigin: transport?.sameOrigin ?? false,
        authToken: transport?.authToken ?? false,
      },
    ),
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
  test("preserves location in OAuth callbacks", async () => {
    const setupResult = setup(() => json({}))

    await setupResult.backend.capabilities.providerAuthV1?.callback({
      providerID: "provider",
      method: 1,
      code: "code",
      location: { directory: "/repo", workspaceID: "workspace" },
    })

    const url = new URL(setupResult.requests[0].url)
    expect(url.searchParams.get("directory")).toBe("/repo")
    expect(url.searchParams.get("workspace")).toBe("workspace")
  })

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
          slug: "one",
          version: "1",
          parentID: undefined,
          projectID: "project",
          location: { directory: "/repo", workspaceID: undefined },
          directory: "/repo",
          workspaceID: undefined,
          title: "Session",
          cost: 0,
          tokens: undefined,
          time: { created: 1, updated: 2 },
          share: undefined,
          revert: undefined,
        },
      ],
      older: "456",
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
      location: { directory: "/explicit", workspaceID: "explicit-workspace" },
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
    expect(new URL(request.url).searchParams.get("directory")).toBe("/explicit")
    expect(new URL(request.url).searchParams.get("workspace")).toBe("explicit-workspace")
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

  test("preserves ordered prompt part IDs and metadata", async () => {
    const setupResult = setup(() => new Response(null, { status: 204 }))

    await setupResult.backend.common.sessions.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "visible",
      parts: [
        { id: "part_text", type: "text", text: "visible" },
        { id: "part_note", type: "text", text: "note", synthetic: true, metadata: { source: "review" } },
        { id: "part_file", type: "file", mime: "text/plain", url: "file:///repo/a.ts", filename: "a.ts" },
        { id: "part_agent", type: "agent", name: "build", source: { value: "@build", start: 7, end: 13 } },
      ],
    })

    expect((await setupResult.requests[0].json()).parts).toEqual([
      { id: "part_text", type: "text", text: "visible" },
      { id: "part_note", type: "text", text: "note", synthetic: true, metadata: { source: "review" } },
      { id: "part_file", type: "file", mime: "text/plain", url: "file:///repo/a.ts", filename: "a.ts" },
      { id: "part_agent", type: "agent", name: "build", source: { value: "@build", start: 7, end: 13 } },
    ])
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

  test("preserves project, provider, and file metadata", async () => {
    const setupResult = setup((request) => {
      const path = new URL(request.url).pathname
      if (path === "/project")
        return json([
          { id: "project", worktree: "/repo", vcs: "git", time: { created: 1, initialized: 2 }, sandboxes: [] },
        ])
      if (path === "/provider")
        return json({
          all: [{ id: "provider", name: "Provider", source: "config", env: [], options: {}, models: {} }],
          connected: [],
          default: {},
        })
      return json([{ name: "a.txt", path: "a.txt", absolute: "/repo/a.txt", type: "file", ignored: false }])
    })

    const projectList = setupResult.backend.capabilities.projectList
    if (!projectList) throw new Error("Missing project list capability")
    const projects = await projectList.list()
    const providers = await setupResult.backend.common.catalog.providers()
    const files = await setupResult.backend.common.files.list({})

    expect(projects[0]).toMatchObject({ vcs: "git", time: { created: 1, initialized: 2 } })
    expect(providers.providers.get("provider")?.source).toBe("config")
    expect(files).toEqual([{ name: "a.txt", path: "a.txt", absolute: "/repo/a.txt", type: "file", ignored: false }])
  })

  test("uses explicit session locations and preserves mutation confirmations", async () => {
    const setupResult = setup((request) => {
      const path = new URL(request.url).pathname
      if (request.method === "DELETE" || path.startsWith("/experimental/worktree")) return json(true)
      if (request.method === "GET" && path === "/session/ses_1/message") return json([], { "x-next-cursor": "older" })
      return json(session)
    }, true)

    const history = await setupResult.backend.common.sessions.history({
      sessionID: "ses_1",
      location: { directory: "/explicit", workspaceID: "explicit-workspace" },
    })
    const removed = await setupResult.backend.capabilities.sessionActionsV1?.remove({ sessionID: "ses_1" })
    const reverted = await setupResult.backend.capabilities.sessionExtrasV1?.revert({
      sessionID: "ses_1",
      messageID: "msg_1",
    })
    const cleared = await setupResult.backend.capabilities.sessionExtrasV1?.clearRevert({ sessionID: "ses_1" })
    const worktreeRemoved = await setupResult.backend.capabilities.worktreesV1?.remove({ directory: "/copy" })
    const worktreeReset = await setupResult.backend.capabilities.worktreesV1?.reset({ directory: "/copy" })

    expect(history.older).toBe("older")
    expect(removed).toBe(true)
    expect(reverted?.id).toBe("ses_1")
    expect(cleared?.id).toBe("ses_1")
    expect(worktreeRemoved).toBe(true)
    expect(worktreeReset).toBe(true)
    const urls = setupResult.requests.map((request) => new URL(request.url))
    expect(urls[0].searchParams.get("directory")).toBe("/explicit")
    expect(urls[1].searchParams.get("directory")).toBe("/default")
  })

  test("normalizes idle and compatibility events", async () => {
    const events = [
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } },
      {
        type: "todo.updated",
        properties: { sessionID: "ses_1", todos: [{ content: "Ship", status: "pending", priority: "high" }] },
      },
      {
        type: "message.part.delta",
        properties: { sessionID: "ses_1", messageID: "msg_1", partID: "part_1", field: "text", delta: "hi" },
      },
      { type: "message.part.removed", properties: { sessionID: "ses_1", messageID: "msg_1", partID: "part_1" } },
      { type: "worktree.ready", properties: { name: "copy", branch: "copy" } },
      { type: "lsp.updated", properties: {} },
      { type: "reference.updated", properties: {} },
      { type: "mcp.tools.changed", properties: { server: "docs" } },
      { type: "server.instance.disposed", properties: { directory: "/repo" } },
    ]
    const setupResult = setup(
      () =>
        new Response(events.map((payload) => `data: ${JSON.stringify({ directory: "/repo", payload })}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    )
    const iterator = setupResult.backend.common.events.subscribe()[Symbol.asyncIterator]()
    const result = await Promise.all(events.map(() => iterator.next()))

    expect(result.map((item) => item.value?.event.type)).toEqual([
      "session.activity",
      "todo.updated",
      "timeline.delta",
      "timeline.part.removed",
      "worktree.ready",
      "lsp.updated",
      "reference.updated",
      "mcp.updated",
      "instance.disposed",
    ])
    expect(result[0].value?.event).toEqual({ type: "session.activity", sessionID: "ses_1", activity: { type: "idle" } })
    expect(result[1].value?.event).toMatchObject({ todos: [{ priority: "high" }] })
  })

  test("updates the V1 projection cache for deltas and removals", async () => {
    const info = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "p", modelID: "m" },
    }
    const part = { id: "part_1", sessionID: "ses_1", messageID: "msg_1", type: "text", text: "a" }
    const events = [
      { type: "message.updated", properties: { info } },
      { type: "message.part.updated", properties: { sessionID: "ses_1", part } },
      { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_1", partID: "part_1", field: "text", delta: "b" } },
      { type: "message.updated", properties: { info } },
      { type: "message.part.removed", properties: { sessionID: "ses_1", messageID: "msg_1", partID: "part_1" } },
      { type: "message.updated", properties: { info } },
    ]
    const setupResult = setup(() => new Response(events.map((payload) => `data: ${JSON.stringify({ directory: "/repo", payload })}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }))
    const iterator = setupResult.backend.common.events.subscribe()[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    await iterator.next()
    const afterDelta = await iterator.next()
    await iterator.next()
    const afterRemoval = await iterator.next()

    expect(afterDelta.value?.event).toMatchObject({ item: { content: [{ id: "part_1", text: "ab" }] } })
    expect(afterRemoval.value?.event).toMatchObject({ item: { content: [] } })
    expect(setupResult.requests).toHaveLength(1)
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

  test("uses legacy PTY endpoints, location queries, status, tickets, and auth fallback", async () => {
    const setupResult = setup((request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith("/connect-token")) return new Response(null, { status: 405 })
      if (request.method === "GET") return new Response(null, { status: 404 })
      return new Response(null, { status: 204 })
    })

    await setupResult.backend.common.permissions.reply({
      sessionID: "ses_1",
      requestID: "per_1",
      reply: "once",
      location: { directory: "/explicit", workspaceID: "workspace" },
    })
    await setupResult.backend.common.questions.reject({
      sessionID: "ses_1",
      requestID: "que_1",
      location: { directory: "/explicit", workspaceID: "workspace" },
    })
    const transport = setupResult.backend.capabilities.ptyTransport
    const ticket = await transport?.connectToken({
      ptyID: "pty_1",
      location: { directory: "/explicit", workspaceID: "workspace" },
    })
    const exists = await transport?.exists({
      ptyID: "pty_1",
      location: { directory: "/explicit", workspaceID: "workspace" },
    })

    expect(ticket).toEqual({ status: 405, ticket: undefined })
    expect(exists).toBe(false)
    expect(setupResult.requests.map((request) => new URL(request.url).searchParams.get("directory"))).toEqual([
      "/explicit",
      "/explicit",
      "/explicit",
      "/explicit",
    ])
    expect(setupResult.requests[2].headers.get("x-opencode-ticket")).toBe("1")

    const fallback = transport?.connectURL({
      ptyID: "pty/1",
      location: { directory: "/explicit", workspaceID: "workspace" },
      cursor: 12,
    })
    expect(fallback?.pathname).toBe("/pty/pty%2F1/connect")
    expect(fallback?.protocol).toBe("ws:")
    expect(fallback?.searchParams.get("directory")).toBe("/explicit")
    expect(fallback?.searchParams.get("workspace")).toBe("workspace")
    expect(fallback?.searchParams.get("cursor")).toBe("12")
    expect(fallback?.searchParams.get("auth_token")).toBe(btoa("user:secret"))

    const ticketURL = transport?.connectURL({
      ptyID: "pty_1",
      location: { directory: "/explicit" },
      cursor: -1,
      ticket: "ticket value",
    })
    expect(ticketURL?.searchParams.get("ticket")).toBe("ticket value")
    expect(ticketURL?.searchParams.has("auth_token")).toBe(false)
  })

  test("preserves same-origin auth-token policy for PTY URLs", () => {
    const saved = setup(() => new Response(), false, { sameOrigin: true }).backend.capabilities.ptyTransport
    const token = setup(() => new Response(), false, { sameOrigin: true, authToken: true }).backend.capabilities
      .ptyTransport
    const input = { ptyID: "pty_1", location: { directory: "/repo" }, cursor: 0 }

    expect(saved?.connectURL(input).searchParams.has("auth_token")).toBe(false)
    expect(token?.connectURL(input).searchParams.get("auth_token")).toBe(btoa("user:secret"))
  })
})
