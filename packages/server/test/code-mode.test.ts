import { expect, test } from "bun:test"
import { CodeMode } from "@opencode-ai/codemode"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { ServerCodeMode } from "../src/code-mode"

test("exposes the authenticated server API through CodeMode", async () => {
  const requests: Array<{ readonly url: string; readonly authorization?: string }> = []
  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push({ url: request.url, authorization: request.headers.authorization })
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json(
            { healthy: true, version: "test", pid: 1 },
            { headers: { "content-type": "application/json" } },
          ),
        ),
      )
    }),
  )
  const result = await CodeMode.make({ tools: ServerCodeMode.makeTools(client, "secret") })
    .execute("return await tools.opencode.v2.health.get({})")
    .pipe(Effect.runPromise)

  expect(result).toEqual({
    ok: true,
    value: { healthy: true, version: "test", pid: 1 },
    toolCalls: [{ name: "opencode.v2.health.get" }],
  })
  expect(requests).toEqual([
    {
      url: "http://opencode.local/api/health",
      authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    },
  ])
})
