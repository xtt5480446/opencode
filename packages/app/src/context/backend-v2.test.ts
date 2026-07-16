import { describe, expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client"
import { credentialConnectionIDs, type PtyTransportConfig } from "./backend"
import { createV2Backend } from "./backend-v2"

function setup(
  respond: (request: Request) => Response | Promise<Response>,
  transport?: Partial<Pick<PtyTransportConfig, "sameOrigin" | "authToken" | "password">>,
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
  const client = OpenCode.make({ baseUrl: "http://localhost", fetch })
  return {
    requests,
    backend: createV2Backend(
      client,
      {
        baseUrl: "http://localhost",
        fetch,
        username: "user",
        password: transport && "password" in transport ? transport.password : "secret",
        sameOrigin: transport?.sameOrigin ?? false,
        authToken: transport?.authToken ?? false,
      },
      { directory: "/default", workspaceID: "default-workspace" },
      client,
    ),
  }
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
}

const session = {
  id: "ses_1",
  projectID: "project",
  cost: 1.5,
  tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
  time: { created: 10, updated: 20 },
  title: "Session",
  location: { directory: "/repo", workspaceID: "workspace" },
}

describe("createV2Backend", () => {
  test("uses no legacy endpoints for bootstrap and common reads", async () => {
    const setupResult = setup((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/health") return json({ healthy: true, version: "v2" })
      if (path === "/api/location")
        return json({
          directory: "/default",
          workspaceID: "default-workspace",
          project: { id: "project", directory: "/default" },
        })
      return json({ location: { directory: "/default" }, data: [] })
    })

    await Promise.all([
      setupResult.backend.common.health.get(),
      setupResult.backend.common.projects.current(),
      setupResult.backend.common.catalog.providers(),
      setupResult.backend.common.catalog.agents(),
      setupResult.backend.common.commands.list(),
      setupResult.backend.common.references.list(),
      setupResult.backend.common.files.list({}),
      setupResult.backend.common.files.find({ query: "src" }),
      setupResult.backend.common.permissions.pending(),
      setupResult.backend.common.questions.pending(),
      setupResult.backend.common.pty.list(),
    ])

    const paths = setupResult.requests.map((request) => new URL(request.url).pathname)
    expect(paths.every((path) => path.startsWith("/api/"))).toBe(true)
    expect(paths.some((path) => path === "/project" || path.startsWith("/vcs") || path.startsWith("/mcp"))).toBe(
      false,
    )
  })

  test("normalizes session pages and preserves location precedence", async () => {
    const setupResult = setup(() => json({ data: [session], cursor: { previous: "before", next: "after" } }))

    const result = await setupResult.backend.common.sessions.list({
      location: { directory: "/explicit", workspaceID: "explicit-workspace" },
      limit: 10,
      cursor: "cursor",
    })

    expect(result).toEqual({
      items: [
        {
          id: "ses_1",
          slug: "ses_1",
          version: "",
          parentID: undefined,
          projectID: "project",
          location: { directory: "/repo", workspaceID: "workspace" },
          directory: "/repo",
          workspaceID: "workspace",
          title: "Session",
          cost: 1.5,
          tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
          time: { created: 10, updated: 20 },
          revert: undefined,
        },
      ],
      newer: "before",
      older: "after",
    })
    const url = new URL(setupResult.requests[0].url)
    expect(url.pathname).toBe("/api/session")
    expect(url.searchParams.get("directory")).toBe("/explicit")
    expect(url.searchParams.get("workspace")).toBe("explicit-workspace")
    expect(url.searchParams.has("parentID")).toBe(false)
    expect(url.searchParams.get("cursor")).toBe("cursor")
  })

  test("paginates native sessions until roots:true contains only the requested roots", async () => {
    const child = { ...session, id: "child", parentID: "root_1" }
    const root1 = { ...session, id: "root_1" }
    const root2 = { ...session, id: "root_2" }
    const setupResult = setup((request) => {
      const cursor = new URL(request.url).searchParams.get("cursor")
      if (!cursor) return json({ data: [child], cursor: { next: "one" } })
      if (cursor === "one") return json({ data: [root1], cursor: { next: "two" } })
      return json({ data: [root2], cursor: { next: "three" } })
    })

    const result = await setupResult.backend.common.sessions.list({ roots: true, limit: 2 })

    expect(result.items.map((item) => item.id)).toEqual(["root_1", "root_2"])
    expect(result.older).toBe("three")
    expect(setupResult.requests.map((request) => new URL(request.url).searchParams.get("limit"))).toEqual(["1", "1", "1"])
  })

  test("uses only native endpoints for bootstrap operations and binary file reads", async () => {
    const setupResult = setup((request) => {
      if (new URL(request.url).pathname === "/api/fs/read/dir%2Fa.txt")
        return new Response(Uint8Array.from([0, 1, 255]), { headers: { "content-type": "application/octet-stream" } })
      return json({ location: { directory: "/default" }, data: [] })
    })

    await setupResult.backend.common.files.list({ path: "dir" })
    const content = await setupResult.backend.common.files.read({ path: "dir/a.txt" })

    const url = new URL(setupResult.requests[0].url)
    expect(url.pathname).toBe("/api/fs/list")
    expect(url.searchParams.get("location[directory]")).toBe("/default")
    expect(url.searchParams.get("location[workspace]")).toBe("default-workspace")
    expect(content).toEqual({
      bytes: Uint8Array.from([0, 1, 255]),
      kind: "binary",
      mimeType: "application/octet-stream",
    })
    const readURL = new URL(setupResult.requests[1].url)
    expect(readURL.pathname).toBe("/api/fs/read/dir%2Fa.txt")
    expect(readURL.searchParams.get("location[directory]")).toBe("/default")
    expect(readURL.searchParams.get("location[workspace]")).toBe("default-workspace")
    expect(setupResult.requests[1].headers.get("authorization")).toBe(`Basic ${btoa("user:secret")}`)
    expect(setupResult.requests.every((request) => new URL(request.url).pathname.startsWith("/api/"))).toBe(true)
    expect(setupResult.backend.version).toBe("v2")
    expect(Object.keys(setupResult.backend.capabilities).sort()).toEqual([
      "integrationsV2",
      "projectCopiesV2",
      "ptyTransport",
      "savedPermissionsV2",
      "sessionExtrasV2",
    ])
    expect(setupResult.backend.capabilities.providerAuthV1).toBeUndefined()
    expect(setupResult.backend.capabilities.worktreesV1).toBeUndefined()
    expect(setupResult.backend.capabilities.sessionExtrasV1).toBeUndefined()
    expect(setupResult.backend.capabilities.runtimeV1).toBeUndefined()
    expect(setupResult.backend.capabilities.projectList).toBeUndefined()
    expect(setupResult.backend.capabilities.vcs).toBeUndefined()
    expect(setupResult.backend.capabilities.mcp).toBeUndefined()
    expect(setupResult.backend.capabilities.sessionExtrasV2?.move).toBeUndefined()
    expect(setupResult.backend.capabilities.projectCopiesV2?.directories).toBeUndefined()
  })

  test("uses native PTY endpoints and preserves status through the v2 adapter", async () => {
    const setupResult = setup((request) =>
      request.method === "GET" ? new Response(null, { status: 404 }) : new Response(null, { status: 403 }),
    )
    const transport = setupResult.backend.capabilities.ptyTransport

    const ticket = await transport?.connectToken({
      ptyID: "pty_1",
      location: { directory: "/explicit", workspaceID: "workspace" },
    })
    const exists = await transport?.exists({
      ptyID: "pty_1",
      location: { directory: "/explicit", workspaceID: "workspace" },
    })

    expect(ticket).toEqual({ status: 403, ticket: undefined })
    expect(exists).toBe(false)
    expect(setupResult.requests[0].headers.get("x-opencode-ticket")).toBe("1")
    const tokenURL = new URL(setupResult.requests[0].url)
    const existsURL = new URL(setupResult.requests[1].url)
    expect(tokenURL.pathname).toBe("/api/pty/pty_1/connect-token")
    expect(existsURL.pathname).toBe("/api/pty/pty_1")
    expect(tokenURL.searchParams.get("location[directory]")).toBe("/explicit")
    expect(tokenURL.searchParams.get("location[workspace]")).toBe("workspace")
    expect(setupResult.requests[0].headers.get("authorization")).toBe(`Basic ${btoa("user:secret")}`)

    expect(() =>
      transport?.connectURL({
        ptyID: "pty/1",
        location: { directory: "/explicit", workspaceID: "workspace" },
        cursor: 8,
      }),
    ).toThrow("require a ticket")

    const ticketURL = transport?.connectURL({
      ptyID: "pty_1",
      location: { directory: "/explicit" },
      cursor: 0,
      ticket: "ticket value",
    })
    expect(ticketURL?.searchParams.get("ticket")).toBe("ticket value")
    expect(ticketURL?.searchParams.has("auth_token")).toBe(false)
  })

  test("allows ticketless same-origin native PTY URLs without credential queries", () => {
    const transport = setup(() => new Response(), { sameOrigin: true, password: undefined }).backend.capabilities
      .ptyTransport
    const url = transport?.connectURL({ ptyID: "pty_1", location: { directory: "/repo" }, cursor: 0 })

    expect(url?.searchParams.has("auth_token")).toBe(false)
    expect(url?.pathname).toBe("/api/pty/pty_1/connect")
  })

  test("preserves native provider integration IDs", async () => {
    const setupResult = setup((request) => {
      const path = new URL(request.url).pathname
      if (path === "/api/provider")
        return json({
          location: { directory: "/default" },
          data: [
            {
              id: "provider",
              integrationID: "integration",
              name: "Provider",
              api: { type: "native", settings: {} },
              request: { headers: {}, body: {} },
            },
          ],
        })
      return json({ location: { directory: "/default" }, data: [] })
    })

    const result = await setupResult.backend.common.catalog.providers()

    expect(result.providers.get("provider")?.integrationID).toBe("integration")
  })

  test("preserves integration connection kinds", async () => {
    const setupResult = setup(() =>
      json({
        location: { directory: "/default" },
        data: [
          {
            id: "integration",
            name: "Integration",
            methods: [],
            connections: [
              { type: "credential", id: "credential", label: "Saved" },
              { type: "environment", name: "TOKEN" },
            ],
          },
        ],
      }),
    )

    const integrations = await setupResult.backend.capabilities.integrationsV2?.list()
    expect(integrations).toEqual([
      {
        id: "integration",
        name: "Integration",
        methods: [],
        connections: [
          { id: "credential", label: "Saved", kind: "credential" },
          { id: "TOKEN", label: "TOKEN", kind: "environment" },
        ],
      },
    ])
    expect(credentialConnectionIDs(integrations?.[0]?.connections ?? [])).toEqual(["credential"])
  })

  test("switches prompt selection before admission", async () => {
    const setupResult = setup((request) =>
      request.url.endsWith("/prompt")
        ? json({
            data: {
              admittedSeq: 1,
              id: "msg_1",
              sessionID: "ses_1",
              timeCreated: 1,
              type: "user",
              data: { text: "hello" },
              delivery: "steer",
            },
          })
        : new Response(null, { status: 204 }),
    )

    await setupResult.backend.common.sessions.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "hello",
      selection: { agent: "build", model: { id: "model", providerID: "provider", variant: "high" } },
      files: [{ uri: "data:text/plain;base64,aGk=", name: "hi.txt", source: { text: "hi", start: 0, end: 2 } }],
    })

    expect(setupResult.requests.map((item) => new URL(item.url).pathname)).toEqual([
      "/api/session/ses_1/agent",
      "/api/session/ses_1/model",
      "/api/session/ses_1/prompt",
    ])
    expect(await setupResult.requests[2].json()).toEqual({
      id: "msg_1",
      prompt: {
        text: "hello",
        files: [
          {
            uri: "data:text/plain;base64,aGk=",
            mime: "application/octet-stream",
            name: "hi.txt",
            source: { start: 0, end: 2, text: "hi" },
          },
        ],
      },
    })
  })

  test("serializes selection and prompt admission per session", async () => {
    const firstPrompt = Promise.withResolvers<void>()
    const firstPromptStarted = Promise.withResolvers<void>()
    const setupResult = setup(async (request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith("/prompt") && setupResult.requests.filter((item) => item.url.endsWith("/prompt")).length === 1) {
        firstPromptStarted.resolve()
        await firstPrompt.promise
      }
      return path.endsWith("/prompt")
        ? json({ data: { id: "msg", sessionID: "ses_1", timeCreated: 1, type: "user", data: { text: "" } } })
        : new Response(null, { status: 204 })
    })

    const first = setupResult.backend.common.sessions.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "first",
      selection: { agent: "build" },
    })
    await firstPromptStarted.promise
    const second = setupResult.backend.common.sessions.prompt({
      sessionID: "ses_1",
      id: "msg_2",
      text: "second",
      selection: { agent: "plan" },
    })

    expect(setupResult.requests.map((item) => new URL(item.url).pathname)).toEqual([
      "/api/session/ses_1/agent",
      "/api/session/ses_1/prompt",
    ])
    firstPrompt.resolve()
    await Promise.all([first, second])
    expect(setupResult.requests.map((item) => new URL(item.url).pathname)).toEqual([
      "/api/session/ses_1/agent",
      "/api/session/ses_1/prompt",
      "/api/session/ses_1/agent",
      "/api/session/ses_1/prompt",
    ])
  })

  test("does not switch a selection already present in session state", async () => {
    const setupResult = setup((request) =>
      request.url.endsWith("/prompt")
        ? json({ data: { id: "msg", sessionID: "ses_1", timeCreated: 1, type: "user", data: { text: "" } } })
        : json({ data: { ...session, agent: "build", model: { id: "model", providerID: "provider" } } }),
    )
    await setupResult.backend.common.sessions.get({ sessionID: "ses_1" })
    await setupResult.backend.common.sessions.prompt({
      sessionID: "ses_1",
      id: "msg_1",
      text: "hello",
      selection: { agent: "build", model: { id: "model", providerID: "provider" } },
    })

    expect(setupResult.requests.map((item) => new URL(item.url).pathname)).toEqual([
      "/api/session/ses_1",
      "/api/session/ses_1/prompt",
    ])
  })

  test("requests file staging when selected revert files are present", async () => {
    const setupResult = setup(() => json({ data: { messageID: "msg_1", files: [] } }))

    await setupResult.backend.capabilities.sessionExtrasV2?.stageRevert({
      sessionID: "ses_1",
      messageID: "msg_1",
      files: ["a.txt"],
    })

    expect(await setupResult.requests[0].json()).toEqual({ messageID: "msg_1", files: true })
  })

  test("maps ordered app prompt parts to the native prompt shape", async () => {
    const setupResult = setup(() =>
      json({ data: { admittedSeq: 1, id: "msg_1", sessionID: "ses_1", timeCreated: 1, type: "user", data: {} } }),
    )

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

    expect(await setupResult.requests[0].json()).toEqual({
      id: "msg_1",
      prompt: {
        text: "visiblenote",
        files: [{ uri: "file:///repo/a.ts", mime: "text/plain", name: "a.ts" }],
        agents: [{ name: "build", source: { text: "@build", start: 7, end: 13 } }],
      },
    })
  })

  test("commits a staged revert through the V2 capability", async () => {
    const setupResult = setup(() => new Response(null, { status: 204 }))

    await setupResult.backend.capabilities.sessionExtrasV2?.commitRevert({ sessionID: "ses_1" })

    expect(new URL(setupResult.requests[0].url).pathname).toBe("/api/session/ses_1/revert/commit")
  })

  test("normalizes current session activity events without projection refresh", async () => {
    const setupResult = setup(
      () =>
        new Response(
          `data: ${JSON.stringify({
            id: "evt_started",
            type: "session.next.step.started",
            durable: { aggregateID: "ses_1", seq: 3, version: 1 },
            location: { directory: "/repo" },
            data: {
              timestamp: 1,
              sessionID: "ses_1",
              assistantMessageID: "msg_1",
              agent: "build",
              model: { id: "model", providerID: "provider" },
            },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    )

    const result = await setupResult.backend.common.events.subscribe()[Symbol.asyncIterator]().next()

    expect(result.value).toMatchObject({
      location: { directory: "/repo" },
      event: {
        type: "session.activity",
        sessionID: "ses_1",
        activity: { type: "running" },
      },
    })
    expect(setupResult.requests).toHaveLength(1)
  })

  test("maps completed native steps to idle activity", async () => {
    const setupResult = setup(
      () =>
        new Response(
          `data: ${JSON.stringify({
            id: "evt_ended",
            type: "session.next.step.ended",
            data: {
              timestamp: 2,
              sessionID: "ses_1",
              assistantMessageID: "msg_1",
              finish: "stop",
              cost: 1,
              tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    )

    const result = await setupResult.backend.common.events.subscribe()[Symbol.asyncIterator]().next()

    expect(result.value?.event).toEqual({
      type: "session.activity",
      sessionID: "ses_1",
      activity: { type: "idle" },
    })
  })

  test("projects failed steps as completed assistant errors and clears running", async () => {
    const events = [
      {
        id: "start",
        type: "session.next.step.started",
        data: { timestamp: 1, sessionID: "ses_1", assistantMessageID: "msg_1", agent: "build", model: { id: "m", providerID: "p" } },
      },
      { id: "text", type: "session.next.text.started", data: { timestamp: 2, sessionID: "ses_1", assistantMessageID: "msg_1", textID: "text_1" } },
      { id: "delta", type: "session.next.text.delta", data: { timestamp: 3, sessionID: "ses_1", assistantMessageID: "msg_1", textID: "text_1", delta: "partial" } },
      { id: "failed", type: "session.next.step.failed", data: { timestamp: 4, sessionID: "ses_1", assistantMessageID: "msg_1", error: { type: "unknown", message: "boom" } } },
    ]
    const setupResult = setup(() => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }))
    const iterator = setupResult.backend.common.events.subscribe()[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    await iterator.next()

    expect((await iterator.next()).value?.event).toMatchObject({
      type: "session.activity",
      activity: { type: "idle" },
      item: { completed: 4, error: { data: { message: "boom" } }, content: [{ id: "text_1", text: "partial" }] },
    })
  })

  test("does not infer assistant parents across history pages or direct fetches", async () => {
    const assistant = { id: "assistant", type: "assistant", time: { created: 2 }, agent: "build", model: { id: "m", providerID: "p" }, content: [] }
    const user = { id: "user", type: "user", time: { created: 1 }, text: "hello" }
    const setupResult = setup((request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/message/assistant")) return json({ data: assistant })
      if (url.searchParams.get("cursor")) return json({ data: [user], cursor: {} })
      return json({ data: [assistant], cursor: { next: "older" } })
    })

    const first = await setupResult.backend.common.sessions.history({ sessionID: "ses_1" })
    await setupResult.backend.common.sessions.history({ sessionID: "ses_1", cursor: first.older })
    const direct = await setupResult.backend.common.sessions.message({ sessionID: "ses_1", messageID: "assistant" })

    expect(first.items[0]).toMatchObject({ type: "assistant", parentID: undefined })
    expect(direct).toMatchObject({ type: "assistant", parentID: undefined })
  })

  test("normalizes lifecycle and provider refresh events without HTTP fallbacks", async () => {
    const events = [
      { id: "moved", type: "session.next.moved", data: { timestamp: 1, sessionID: "ses_1", location: { directory: "/next" } } },
      { id: "revert", type: "session.next.revert.staged", data: { timestamp: 2, sessionID: "ses_1", revert: { messageID: "msg_1" } } },
      { id: "integration", type: "integration.updated", data: {} },
      { id: "unknown", type: "session.next.context.updated", data: { timestamp: 3, sessionID: "ses_1", messageID: "msg_1", text: "x" } },
    ]
    const setupResult = setup(() => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }))
    const iterator = setupResult.backend.common.events.subscribe()[Symbol.asyncIterator]()

    expect((await iterator.next()).value?.event).toEqual({ type: "session.moved", sessionID: "ses_1", location: { directory: "/next" } })
    expect((await iterator.next()).value?.event).toEqual({ type: "session.revert", sessionID: "ses_1", revert: { messageID: "msg_1" } })
    expect((await iterator.next()).value?.event).toEqual({ type: "provider.updated" })
    expect((await iterator.next()).value?.event.type).toBe("unknown")
    expect(setupResult.requests).toHaveLength(1)
  })

  test("normalizes native session create, update, and delete lifecycle events", async () => {
    const info = {
      id: "ses_1",
      slug: "one",
      version: "2",
      projectID: "project",
      directory: "/repo",
      title: "Session",
      time: { created: 1, updated: 2 },
    }
    const events = [
      { id: "created", type: "session.created", data: { sessionID: "ses_1", info } },
      { id: "updated", type: "session.updated", data: { sessionID: "ses_1", info: { ...info, title: "Renamed" } } },
      { id: "deleted", type: "session.deleted", data: { sessionID: "ses_1", info } },
    ]
    const setupResult = setup(() => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }))
    const iterator = setupResult.backend.common.events.subscribe()[Symbol.asyncIterator]()

    expect((await iterator.next()).value?.event).toMatchObject({ type: "session.created", session: { id: "ses_1", title: "Session" } })
    expect((await iterator.next()).value?.event).toMatchObject({ type: "session.updated", session: { id: "ses_1", title: "Renamed" } })
    expect((await iterator.next()).value?.event).toEqual({ type: "session.deleted", sessionID: "ses_1" })
  })

  test("normalizes durable session log events through the event mapper", async () => {
    const setupResult = setup(
      () =>
        new Response(
          `data: ${JSON.stringify({
            id: "evt_started",
            type: "session.next.step.started",
            durable: { aggregateID: "ses_1", seq: 7, version: 1 },
            data: {
              timestamp: 1,
              sessionID: "ses_1",
              assistantMessageID: "msg_1",
              agent: "build",
              model: { id: "model", providerID: "provider" },
            },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    )
    const capability = setupResult.backend.capabilities.sessionExtrasV2
    if (!capability) throw new Error("Missing V2 session capability")

    const result = await capability.log({ sessionID: "ses_1" })[Symbol.asyncIterator]().next()

    expect(result.value).toMatchObject({
      sequence: 7,
      event: { type: "session.activity", sessionID: "ses_1", activity: { type: "running" } },
    })
    expect(new URL(setupResult.requests[0].url).pathname).toBe("/api/session/ses_1/event")
  })

  test("normalizes native todo and part removal events", async () => {
    const events = [
      {
        id: "evt_todo",
        type: "todo.updated",
        data: { sessionID: "ses_1", todos: [{ content: "Ship", status: "pending", priority: "high" }] },
      },
      {
        id: "evt_removed",
        type: "message.part.removed",
        data: { sessionID: "ses_1", messageID: "msg_1", partID: "part_1" },
      },
    ]
    const setupResult = setup(
      () =>
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    )
    const iterator = setupResult.backend.common.events.subscribe()[Symbol.asyncIterator]()

    expect((await iterator.next()).value?.event).toEqual({
      type: "todo.updated",
      sessionID: "ses_1",
      todos: [{ content: "Ship", status: "pending", priority: "high" }],
    })
    expect((await iterator.next()).value?.event).toEqual({
      type: "timeline.part.removed",
      sessionID: "ses_1",
      itemID: "msg_1",
      contentID: "part_1",
    })
  })

  test("preserves streamed V2 timeline deltas without projection refresh", async () => {
    const setupResult = setup((request) => {
      if (new URL(request.url).pathname === "/api/event") {
        return new Response(
          `data: ${JSON.stringify({
            id: "evt_1",
            type: "session.next.text.delta",
            location: { directory: "/repo" },
            data: {
              timestamp: 1,
              sessionID: "ses_1",
              assistantMessageID: "msg_1",
              textID: "text_1",
              delta: "hi",
            },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return json({
        data: {
          id: "msg_1",
          type: "assistant",
          time: { created: 1 },
          agent: "build",
          model: { id: "model", providerID: "provider" },
          content: [{ type: "text", id: "text_1", text: "hello" }],
        },
      })
    })

    const result = await setupResult.backend.common.events.subscribe()[Symbol.asyncIterator]().next()

    expect(result.value).toEqual({
      location: { directory: "/repo" },
      event: {
        type: "timeline.delta",
        sessionID: "ses_1",
        itemID: "msg_1",
        contentID: "text_1",
        field: "text",
        delta: "hi",
      },
    })
    expect(setupResult.requests).toHaveLength(1)
  })

  test("projects native fragment starts without blocking the event stream on HTTP", async () => {
    const events = [
      {
        id: "evt_step",
        type: "session.next.step.started",
        data: {
          timestamp: 1,
          sessionID: "ses_1",
          assistantMessageID: "msg_1",
          agent: "build",
          model: { id: "model", providerID: "provider" },
        },
      },
      {
        id: "evt_text",
        type: "session.next.text.started",
        data: { timestamp: 2, sessionID: "ses_1", assistantMessageID: "msg_1", textID: "text_1" },
      },
    ]
    const setupResult = setup(
      () =>
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    )
    const iterator = setupResult.backend.common.events.subscribe()[Symbol.asyncIterator]()

    await iterator.next()
    expect((await iterator.next()).value?.event).toEqual({
      type: "timeline.content.updated",
      sessionID: "ses_1",
      itemID: "msg_1",
      content: { type: "text", id: "text_1", text: "" },
    })
    expect(setupResult.requests).toHaveLength(1)
  })
})
