export * as ServerCodeMode from "./code-mode"

import { NodeHttpClient } from "@effect/platform-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { OpenAPI, Tool } from "@opencode-ai/codemode"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import type { Server } from "node:http"
import { Api } from "./api"
import { ServerAuth } from "./auth"

export function replacement(server: Server, password: string): LayerNode.Replacement {
  return ToolRegistry.codeModeReplacement(makeTools(client(server), password))
}

export function makeTools(client: Layer.Layer<HttpClient.HttpClient>, password: string): ToolRegistry.CodeModeTools {
  return {
    opencode: bindTools(
      OpenAPI.fromSpec({
        spec: { ...OpenApi.fromApi(Api) },
        baseUrl: "http://opencode.local",
        headers: ServerAuth.headers({ username: "opencode", password }),
      }).tools,
      client,
    ),
  }
}

function client(server: Server) {
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      return HttpClient.mapRequest(client, (request) => {
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("OpenCode server is not listening")
        const local =
          address.address === "0.0.0.0" ? "127.0.0.1" : address.address === "::" ? "::1" : address.address
        const host = local.includes(":") && !local.startsWith("[") ? `[${local}]` : local
        const url = new URL(request.url)
        return HttpClientRequest.setUrl(
          request,
          new URL(`${url.pathname}${url.search}${url.hash}`, `http://${host}:${address.port}`),
        )
      })
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerNodeHttp))
}

function bindTools(tools: OpenAPI.Tools, client: Layer.Layer<HttpClient.HttpClient>): ToolRegistry.CodeModeTools {
  return Object.fromEntries(
    Object.entries(tools).map(([name, value]) => [
      name,
      Tool.isDefinition<HttpClient.HttpClient>(value)
        ? Tool.make({
            description: value.description,
            input: value.input,
            output: value.output,
            run: (input) => value.run(input).pipe(Effect.provide(client)),
          })
        : bindTools(value, client),
    ]),
  )
}
