import { describe, expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client"
import { createV2Backend } from "./backend-v2"

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
    backend: createV2Backend(OpenCode.make({ baseUrl: "http://localhost", fetch }), {
      directory: "/default",
      workspaceID: "default-workspace",
    }),
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
  test("normalizes session pages and preserves location precedence", async () => {
    const setupResult = setup(() => json({ data: [session], cursor: { previous: "before", next: "after" } }))

    const result = await setupResult.backend.common.sessions.list({
      location: { directory: "/explicit", workspaceID: "explicit-workspace" },
      roots: true,
      limit: 10,
      cursor: "cursor",
    })

    expect(result).toEqual({
      items: [
        {
          id: "ses_1",
          parentID: undefined,
          projectID: "project",
          location: { directory: "/repo", workspaceID: "workspace" },
          title: "Session",
          cost: 1.5,
          tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
          time: { created: 10, updated: 20 },
          revert: undefined,
        },
      ],
      previous: "before",
      next: "after",
    })
    const url = new URL(setupResult.requests[0].url)
    expect(url.pathname).toBe("/api/session")
    expect(url.searchParams.get("directory")).toBe("/explicit")
    expect(url.searchParams.get("workspace")).toBe("explicit-workspace")
    expect(url.searchParams.get("parentID")).toBe("null")
    expect(url.searchParams.get("cursor")).toBe("cursor")
  })

  test("uses the default location and maps binary file responses", async () => {
    const setupResult = setup(() => new Response(Uint8Array.from([0, 1, 2])))

    const result = await setupResult.backend.common.files.read({ path: "dir/a.bin" })

    expect([...result.bytes]).toEqual([0, 1, 2])
    const url = new URL(setupResult.requests[0].url)
    expect(url.pathname).toBe("/api/fs/read/dir/a.bin")
    expect(url.searchParams.get("location[directory]")).toBe("/default")
    expect(url.searchParams.get("location[workspace]")).toBe("default-workspace")
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
      text: "hello",
      files: [
        {
          uri: "data:text/plain;base64,aGk=",
          name: "hi.txt",
          mention: { start: 0, end: 2, text: "hi" },
        },
      ],
    })
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

  test("normalizes retry events before message projection refresh", async () => {
    const setupResult = setup(() =>
      new Response(
        `data: ${JSON.stringify({
          id: "evt_retry",
          created: 1,
          type: "session.retry.scheduled",
          durable: { aggregateID: "ses_1", seq: 3, version: 1 },
          location: { directory: "/repo" },
          data: {
            sessionID: "ses_1",
            assistantMessageID: "msg_1",
            attempt: 2,
            at: 1234,
            error: { type: "rate_limit", message: "try again" },
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    )

    const result = await setupResult.backend.common.events.subscribe()[Symbol.asyncIterator]().next()

    expect(result.value).toEqual({
      location: { directory: "/repo" },
      event: {
        type: "session.activity",
        sessionID: "ses_1",
        activity: { type: "retry", attempt: 2, message: "try again", next: 1234 },
      },
    })
    expect(setupResult.requests).toHaveLength(1)
  })

  test("normalizes durable session log events through the event mapper", async () => {
    const setupResult = setup(() =>
      new Response(
        `data: ${JSON.stringify({
          id: "evt_started",
          created: 1,
          type: "session.execution.started",
          durable: { aggregateID: "ses_1", seq: 7, version: 1 },
          data: { sessionID: "ses_1" },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    const capability = setupResult.backend.capabilities.sessionExtrasV2
    if (!capability) throw new Error("Missing V2 session capability")

    const result = await capability.log({ sessionID: "ses_1" })[Symbol.asyncIterator]().next()

    expect(result.value).toEqual({
      sequence: 7,
      event: { type: "session.activity", sessionID: "ses_1", activity: { type: "running" } },
    })
    expect(new URL(setupResult.requests[0].url).pathname).toBe("/api/experimental/session/ses_1/log")
  })

  test("refreshes message projections for streamed V2 fragments", async () => {
    const setupResult = setup((request) => {
      if (new URL(request.url).pathname === "/api/event") {
        return new Response(
          `data: ${JSON.stringify({
            id: "evt_1",
            created: 1,
            type: "session.text.delta",
            location: { directory: "/repo" },
            data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta: "hi" },
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
          content: [{ type: "text", text: "hello" }],
        },
      })
    })

    const result = await setupResult.backend.common.events.subscribe()[Symbol.asyncIterator]().next()

    expect(result.value).toEqual({
      location: { directory: "/repo" },
      event: {
        type: "timeline.updated",
        item: {
          type: "assistant",
          id: "msg_1",
          sessionID: "ses_1",
          created: 1,
          completed: undefined,
          content: [{ type: "text", id: "msg_1:text:0", text: "hello" }],
          agent: "build",
          model: { id: "model", providerID: "provider" },
          tokens: undefined,
          error: undefined,
          raw: {
            id: "msg_1",
            type: "assistant",
            time: { created: 1 },
            agent: "build",
            model: { id: "model", providerID: "provider" },
            content: [{ type: "text", text: "hello" }],
          },
        },
      },
    })
    expect(new URL(setupResult.requests[1].url).pathname).toBe("/api/session/ses_1/message/msg_1")
  })
})
