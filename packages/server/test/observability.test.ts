import { expect, test } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { Context, Effect, Layer, References } from "effect"
import { HttpMiddleware, HttpServer, HttpServerRequest } from "effect/unstable/http"

test("route construction retains the server tracing policy", async () => {
  const database = process.env.OPENCODE_DB
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  process.env.OPENCODE_DB = ":memory:"

  try {
    const { createEmbeddedRoutes } = await import("../src/routes")
    await Effect.gen(function* () {
      const context = yield* Layer.build(
        createEmbeddedRoutes().pipe(
          Layer.provide(HttpServer.layerServices),
          Layer.provide(NodeServices.layer),
        ),
      )
      const request = HttpServerRequest.fromWeb(new Request("http://opencode.local/api/session"))

      expect(Context.get(context, References.TracerEnabled)).toBeFalse()
      expect(Context.get(context, HttpMiddleware.TracerDisabledWhen)(request)).toBeTrue()
    }).pipe(Effect.scoped, Effect.runPromise)
  } finally {
    if (database === undefined) delete process.env.OPENCODE_DB
    else process.env.OPENCODE_DB = database
    if (endpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint
  }
})
