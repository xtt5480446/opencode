import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Fiber, Option, Schema, Stream } from "effect"

test("embedded client uses the real router and handlers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-embedded-"))
  const database = Flag.OPENCODE_DB
  Flag.OPENCODE_DB = join(directory, "opencode.sqlite")
  const { AbsolutePath, Agent, Location, Model, OpenCode, Prompt, Provider, Session, Tool } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)
  const model = Model.Ref.make({ id: Model.ID.make("embedded"), providerID: Provider.ID.make("test") })

  try {
    const program = Effect.gen(function* () {
      const opencode = yield* OpenCode.create()
      yield* opencode.tools.register({
        embedded_tool: Tool.make({
          description: "Embedded test tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      })

      const created = yield* opencode.sessions.create({
        id: sessionID,
        agent: Agent.ID.make("build"),
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* opencode.sessions.switchModel({ sessionID, model })
      const selected = yield* opencode.sessions.get({ sessionID })
      const page = yield* opencode.sessions.list({ directory: AbsolutePath.make(directory) })
      const active = yield* opencode.sessions.active()
      const admitted = yield* opencode.sessions.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not run" }),
        resume: false,
      })
      const context = yield* opencode.sessions.context({ sessionID })
      const wake = yield* opencode.sessions.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Promote this input" }),
      })
      const prompted = yield* opencode.sessions.events({ sessionID }).pipe(
        Stream.filter((event) => event.type === "session.next.prompted" && event.data.messageID === wake.id),
        Stream.runHead,
        Effect.timeout("10 seconds"),
        Effect.map(Option.getOrThrow),
      )
      const wakeContext = yield* opencode.sessions.context({ sessionID })
      const event = yield* opencode.sessions
        .events({ sessionID })
        .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrUndefined))
      const modelMessage = Option.fromNullishOr(context.find((message) => message.type === "model-switched")).pipe(
        Option.getOrThrow,
      )
      const message = yield* opencode.sessions.message({ sessionID, messageID: modelMessage.id })
      yield* opencode.sessions.interrupt({ sessionID })
      const other = yield* opencode.sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const missingSessionID = Session.ID.make(`ses_missing_${crypto.randomUUID()}`)
      const missing = yield* Effect.all(
        [
          opencode.sessions.events({ sessionID: missingSessionID }).pipe(Stream.runHead, Effect.flip),
          opencode.sessions.interrupt({ sessionID: missingSessionID }).pipe(Effect.flip),
          opencode.sessions.message({ sessionID: missingSessionID, messageID: modelMessage.id }).pipe(Effect.flip),
        ],
        { concurrency: "unbounded" },
      )
      const missingMessage = yield* Effect.flip(
        opencode.sessions.message({
          sessionID: other.id,
          messageID: modelMessage.id,
        }),
      )

      expect(created.id).toBe(sessionID)
      expect(selected.model?.id).toBe(model.id)
      expect(selected.model?.providerID).toBe(model.providerID)
      expect(page.data.some((session) => session.id === sessionID)).toBe(true)
      expect(active).toEqual({})
      expect(admitted.sessionID).toBe(sessionID)
      expect(prompted.type).toBe("session.next.prompted")
      expect(wakeContext).toContainEqual(expect.objectContaining({ id: wake.id, type: "user" }))
      expect(context.some((message) => message.type === "model-switched")).toBe(true)
      expect(event).toMatchObject({ type: "session.next.model.switched", durable: { seq: 1 } })
      expect(message).toEqual(modelMessage)
      expect(missing.map((error) => error._tag)).toEqual([
        "SessionNotFoundError",
        "SessionNotFoundError",
        "SessionNotFoundError",
      ])
      expect(missingMessage._tag).toBe("MessageNotFoundError")
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.OPENCODE_DB = database
    await rm(directory, { recursive: true, force: true })
  }
})

test("embedded session events live-tail location-owned durable rows through provider failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-embedded-live-tail-"))
  const database = Flag.OPENCODE_DB
  Flag.OPENCODE_DB = join(directory, "opencode.sqlite")
  let requests = 0
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = await request.json()
      if (JSON.stringify(body).includes("Generate a title for this conversation")) {
        return new Response(
          [
            'data: {"choices":[{"delta":{"role":"assistant"}}]}',
            'data: {"choices":[{"delta":{"content":"Live tail"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      requests++
      if (requests > 1) {
        return Response.json({ error: { message: "Provider failed on turn B", type: "server_error" } }, { status: 500 })
      }
      return new Response(
        [
          'data: {"choices":[{"delta":{"role":"assistant"}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_live_tail","type":"function","function":{"name":"live_tail_tool","arguments":""}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"value\\":\\"A\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })

  try {
    const git = Bun.spawn(["git", "init"], { cwd: directory, stdout: "ignore", stderr: "ignore" })
    expect(await git.exited).toBe(0)
    await Bun.write(
      join(directory, "opencode.json"),
      JSON.stringify({
        formatter: false,
        lsp: false,
        providers: {
          test: {
            name: "Test",
            api: {
              type: "aisdk",
              package: "@ai-sdk/openai-compatible",
              url: `http://127.0.0.1:${server.port}/v1`,
              settings: {},
            },
            request: { body: { apiKey: "test-key" } },
            models: {
              "test-model": {
                name: "Test Model",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                limit: { context: 100_000, output: 10_000 },
              },
            },
          },
        },
      }),
    )
    const { AbsolutePath, Agent, Location, Model, OpenCode, Prompt, Provider, Session, Tool } = await import("../src")
    const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)
    const executions: string[] = []

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const opencode = yield* OpenCode.create()
          yield* opencode.tools.register({
            live_tail_tool: Tool.make({
              description: "Record step A",
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: ({ value }) =>
                Effect.sync(() => {
                  executions.push(value)
                  return { value }
                }),
            }),
          })
          yield* opencode.sessions.create({
            id: sessionID,
            agent: Agent.ID.make("build"),
            model: Model.Ref.make({ id: Model.ID.make("test-model"), providerID: Provider.ID.make("test") }),
            location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
          })

          let observedActive = false
          const streamed = yield* opencode.sessions.events({ sessionID }).pipe(
            Stream.takeUntil((event) => {
              if (event.type !== "session.activity") return false
              if (event.data.active) {
                observedActive = true
                return false
              }
              return observedActive
            }),
            Stream.runCollect,
            Effect.timeout("10 seconds"),
            Effect.forkScoped,
          )
          yield* Effect.yieldNow
          yield* opencode.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Run step A, then fail B" }) })
          const received = Array.from(yield* Fiber.join(streamed))
          const durable = received.filter((event) => event.durable !== undefined)

          expect(executions).toEqual(["A"])
          expect(requests).toBeGreaterThanOrEqual(2)
          expect(durable.at(-1)?.type).toBe("session.next.step.failed")
          expect(durable.map((event) => event.durable!.seq)).toEqual(
            Array.from({ length: durable.length }, (_, index) => durable[0]!.durable!.seq + index),
          )
          expect(durable.map((event) => event.type)).toEqual(
            expect.arrayContaining([
              "session.next.tool.called",
              "session.next.tool.success",
              "session.next.step.ended",
              "session.next.step.failed",
            ]),
          )
          expect(received.at(-2)?.type).toBe("session.next.step.failed")
          expect(received.at(-1)).toMatchObject({ type: "session.activity", data: { active: false } })
        }),
      ),
    )
  } finally {
    server.stop(true)
    Flag.OPENCODE_DB = database
    await rm(directory, { recursive: true, force: true })
  }
}, 20_000)

test("embedded client is available as a Layer service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-embedded-layer-"))
  const database = Flag.OPENCODE_DB
  Flag.OPENCODE_DB = join(directory, "opencode.sqlite")
  const { AbsolutePath, Location, OpenCode, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const opencode = yield* OpenCode.Service
        return yield* opencode.sessions.create({
          id: sessionID,
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })
      }).pipe(Effect.provide(OpenCode.layer), Effect.scoped),
    )

    expect(created.id).toBe(sessionID)
  } finally {
    Flag.OPENCODE_DB = database
    await rm(directory, { recursive: true, force: true })
  }
})
