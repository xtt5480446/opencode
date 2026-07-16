import { OpenCode } from "@opencode-ai/client"
import { createOpencodeClient } from "@opencode-ai/sdk-v1/v2/client"
import type { ServerHealth } from "@/utils/server-health"
import { authTokenFromCredentials } from "@/utils/server"
import type { ServerConnection } from "./server"
import type { LocationRef } from "./backend"
import { createV1Backend } from "./backend-v1"
import { createV2Backend } from "./backend-v2"

function options(server: ServerConnection.HttpBase, fetch: typeof globalThis.fetch) {
  return {
    baseUrl: server.url,
    fetch,
    headers: server.password
      ? {
          Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
        }
      : undefined,
  }
}

export function createV1RawClient(server: ServerConnection.HttpBase, fetch: typeof globalThis.fetch) {
  return createOpencodeClient(options(server, fetch))
}

export function createV2RawClient(server: ServerConnection.HttpBase, fetch: typeof globalThis.fetch) {
  return OpenCode.make(options(server, fetch))
}

export function backendIdentity(server: ServerConnection.Any) {
  return `${server.type}\n${server.http.url}\n${server.http.username ?? ""}\n${server.http.password ?? ""}\n${
    server.type === "http" && server.authToken === true ? "token" : ""
  }`
}

export async function createBackendForServer(input: {
  server: ServerConnection.Any
  browserUrl: string
  fetch: typeof globalThis.fetch
  eventFetch?: typeof globalThis.fetch
  health: Promise<ServerHealth>
  defaultLocation?: LocationRef
}) {
  const health = await input.health
  const eventFetch = input.eventFetch ?? input.fetch
  const transport = {
    baseUrl: input.server.http.url,
    fetch: input.fetch,
    username: input.server.http.username,
    password: input.server.http.password,
    sameOrigin: new URL(input.server.http.url, input.browserUrl).origin === new URL(input.browserUrl).origin,
    authToken: input.server.type === "http" && input.server.authToken === true,
  }
  if (health.version === "v2")
    return createV2Backend(
      createV2RawClient(input.server.http, input.fetch),
      transport,
      input.defaultLocation,
      createV2RawClient(input.server.http, eventFetch),
    )
  const legacy = createV1RawClient(input.server.http, input.fetch)
  const eventLegacy = eventFetch === input.fetch ? legacy : createV1RawClient(input.server.http, eventFetch)
  return createV1Backend(legacy, input.defaultLocation, eventLegacy, transport)
}
