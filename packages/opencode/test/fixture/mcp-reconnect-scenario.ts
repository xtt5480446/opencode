import path from "node:path"
import { expect } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

const it = testEffect(MCP.defaultLayer)

function server() {
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ child: ReturnType<typeof Bun.spawn>; url: string }>((resolve, reject) => {
          const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "mcp-reconnect-server.ts")], {
            cwd: path.join(import.meta.dir, "../.."),
            stdout: "inherit",
            stderr: "inherit",
            ipc(message) {
              if (
                typeof message === "object" &&
                message !== null &&
                "url" in message &&
                typeof message.url === "string"
              ) {
                resolve({ child, url: message.url })
              }
            },
          })
          child.exited.then((code) => reject(new Error(`MCP test server exited before readiness with code ${code}`)))
        }),
    ),
    ({ child }) =>
      Effect.promise(async () => {
        child.kill()
        await child.exited
      }).pipe(Effect.ignore),
  )
}

function control(url: string, action: "block" | "release" | "wait", kind: string, count: number) {
  return Effect.tryPromise(() => fetch(`${url}control/${action}?kind=${kind}&count=${count}`, { method: "POST" })).pipe(
    Effect.filterOrFail(
      (response) => response.ok,
      (response) => new Error(`control request failed: ${response.status}`),
    ),
  )
}

function state(url: string) {
  return Effect.promise(() => fetch(`${url}control/state`).then((response) => response.json())) as Effect.Effect<{
    initialize: number
    list: number
    call: number
  }>
}

it.instance(
  "reconnects once without replaying an ambiguous tool call and publishes the replacement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* server()
        const mcp = yield* MCP.Service
        yield* mcp.add("remote", { type: "remote", url: fixture.url, oauth: false })
        yield* control(fixture.url, "block", "call", 1)

        const execute = (yield* mcp.tools()).remote_probe?.execute
        if (!execute) return yield* Effect.die("initial tool missing")
        const call = yield* Effect.promise(() => execute({}, { toolCallId: "first", messages: [] })).pipe(
          Effect.exit,
          Effect.forkScoped,
        )
        yield* control(fixture.url, "wait", "call", 1)
        const original = (yield* mcp.clients()).remote
        const transport = original?.transport
        if (!transport) return yield* Effect.die("initial client transport missing")
        yield* Effect.promise(() => transport.close())
        yield* control(fixture.url, "release", "call", 1)
        const callExit = yield* Fiber.await(call)
        expect(Exit.isSuccess(callExit) && Exit.isFailure(callExit.value)).toBe(true)

        yield* control(fixture.url, "wait", "list", 2)
        const replacement = (yield* mcp.clients()).remote
        expect(replacement).toBeDefined()
        expect(replacement).not.toBe(original)
        const executeLater = (yield* mcp.tools()).remote_probe?.execute
        if (!executeLater) return yield* Effect.die("replacement tool missing")
        const result = yield* Effect.promise(() => executeLater({}, { toolCallId: "later", messages: [] }))
        expect(result).toMatchObject({ content: [{ text: "call-2-initialize-2" }] })
        expect(yield* state(fixture.url)).toEqual({ initialize: 2, list: 2, call: 2 })
      }),
    ),
  { config: { mcp: {} } },
)

it.instance(
  "disconnect fences a reconnect that finishes late",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* server()
        const mcp = yield* MCP.Service
        yield* mcp.add("remote", { type: "remote", url: fixture.url, oauth: false })
        yield* control(fixture.url, "block", "initialize", 2)

        const transport = (yield* mcp.clients()).remote?.transport
        if (!transport) return yield* Effect.die("initial client transport missing")
        yield* Effect.promise(() => transport.close())
        yield* control(fixture.url, "wait", "initialize", 2)
        yield* mcp.disconnect("remote")
        yield* control(fixture.url, "release", "initialize", 2)
        yield* control(fixture.url, "wait", "list", 2)

        expect((yield* mcp.status()).remote).toEqual({ status: "disabled" })
        expect((yield* mcp.clients()).remote).toBeUndefined()
        expect(yield* state(fixture.url)).toEqual({ initialize: 2, list: 2, call: 0 })
      }),
    ),
  { config: { mcp: {} } },
)
