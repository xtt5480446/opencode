import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("config HttpApi", () => {
  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-opencode-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
    }),
  )

  it.live(
    "redacts resolved provider and MCP secrets",
    Effect.gen(function* () {
      const secrets = [
        "CANARY_PROVIDER_API_KEY",
        "CANARY_PROVIDER_CLIENT_SECRET",
        "CANARY_PROVIDER_NESTED_TOKEN",
        "CANARY_MCP_ENV",
        "CANARY_MCP_HEADER",
        "CANARY_MCP_CLIENT_SECRET",
      ]
      const tmp = yield* tmpdirEffect({
        init: (dir) =>
          Promise.all(secrets.map((secret, index) => Bun.write(path.join(dir, `secret-${index}`), secret))),
        config: {
          formatter: false,
          lsp: false,
          provider: {
            canary: {
              name: "Canary Provider",
              options: {
                apiKey: "{file:secret-0}",
                clientSecret: "{file:secret-1}",
                nested: { accessToken: "{file:secret-2}", temperature: 0.5 },
                baseURL: "https://provider.example.com",
              },
            },
          },
          mcp: {
            local: {
              type: "local",
              command: ["canary-command"],
              environment: { TOKEN: "{file:secret-3}" },
              enabled: false,
            },
            remote: {
              type: "remote",
              url: "https://mcp.example.com",
              headers: { Authorization: "{file:secret-4}" },
              oauth: { clientId: "canary-client", clientSecret: "{file:secret-5}", scope: "read" },
              enabled: false,
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )
      const text = yield* Effect.promise(() => response.text())
      const body = JSON.parse(text)

      expect(response.status).toBe(200)
      secrets.forEach((secret) => expect(text).not.toContain(secret))
      expect(body).toMatchObject({
        provider: {
          canary: {
            name: "Canary Provider",
            options: {
              apiKey: "[redacted]",
              clientSecret: "[redacted]",
              nested: { accessToken: "[redacted]", temperature: 0.5 },
              baseURL: "https://provider.example.com",
            },
          },
        },
        mcp: {
          local: {
            command: ["canary-command"],
            environment: { TOKEN: "[redacted]" },
          },
          remote: {
            url: "https://mcp.example.com",
            headers: { Authorization: "[redacted]" },
            oauth: { clientId: "canary-client", clientSecret: "[redacted]", scope: "read" },
          },
        },
      })
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-opencode-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )
})
