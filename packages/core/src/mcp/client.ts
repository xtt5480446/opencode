export * as MCPClient from "./client"

import path from "node:path"
import { pathToFileURL } from "node:url"
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { ConfigMCP } from "../config/mcp"
import { InstallationVersion } from "../installation/version"

const DEFAULT_STARTUP_TIMEOUT = 30_000

export class NeedsAuthError extends Schema.TaggedErrorClass<NeedsAuthError>()("MCP.NeedsAuthError", {
  server: Schema.String,
}) {}

export class ConnectError extends Schema.TaggedErrorClass<ConnectError>()("MCP.ConnectError", {
  server: Schema.String,
  message: Schema.String,
}) {}

/**
 * Connects an MCP client and registers a scoped finalizer that closes it. The
 * returned client is owned by the calling scope; closing that scope tears down
 * the transport (and, for local servers, the spawned process).
 */
export const connect = Effect.fnUntraced(function* (
  server: string,
  config: typeof ConfigMCP.Server.Type,
  directory: string,
) {
  const transport = yield* Effect.gen(function* () {
    if (config.type === "local") {
      const [command, ...args] = config.command
      return new StdioClientTransport({
        command,
        args,
        cwd: config.cwd ? path.resolve(directory, config.cwd) : directory,
        stderr: "pipe",
        env: {
          ...(process.env as Record<string, string>),
          ...(command === "opencode" ? { BUN_BE_BUN: "1" } : {}),
          ...config.environment,
        },
      })
    }
    if (!URL.canParse(config.url)) return yield* new ConnectError({ server, message: `Invalid MCP URL for "${server}"` })
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    })
  })
  const client = new Client(
    { name: "opencode", version: InstallationVersion },
    {
      capabilities: {
        // https://github.com/anomalyco/opencode/issues/2308
        roots: {},
      },
    },
  )
  client.setRequestHandler(ListRootsRequestSchema, () =>
    Promise.resolve({ roots: [{ uri: pathToFileURL(directory).href }] }),
  )

  const exit = yield* Effect.tryPromise({
    try: (signal) => client.connect(transport, { timeout: config.timeout?.startup ?? DEFAULT_STARTUP_TIMEOUT, signal }),
    catch: (error) => error,
  }).pipe(Effect.exit)
  if (Exit.isSuccess(exit)) {
    yield* Effect.addFinalizer(() => Effect.promise(() => client.close()).pipe(Effect.ignore))
    return client
  }

  yield* Effect.promise(() => transport.close()).pipe(Effect.ignore)
  const error = Cause.squash(exit.cause)
  if (error instanceof UnauthorizedError || (error instanceof Error && error.message.includes("OAuth")))
    return yield* new NeedsAuthError({ server })
  return yield* new ConnectError({ server, message: error instanceof Error ? error.message : String(error) })
})
