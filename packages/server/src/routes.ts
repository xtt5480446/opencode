import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventLogger } from "@opencode-ai/core/event-logger"
import { Observability } from "@opencode-ai/core/observability"
import { Credential } from "@opencode-ai/core/credential"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Project } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { Job } from "@opencode-ai/core/job"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { SessionRestart } from "@opencode-ai/core/session/execution/restart"
import { PluginRuntime } from "@opencode-ai/core/plugin/runtime"
import { SdkPlugins } from "@opencode-ai/core/plugin/sdk"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Context, Effect, Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { layer } from "./location"
import { formLocationLayer } from "./middleware/form-location"
import { sessionLocationLayer } from "./middleware/session-location"
import { ServerInfo } from "./server-info"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "./cors"

const applicationServices = LayerNode.group([
  Database.node,
  EventV2.node,
  EventLogger.node,
  httpClient,
  ToolOutputStore.cleanupNode,
  Job.node,
  MoveSession.node,
  Project.node,
  SessionV2.node,
  PluginRuntime.providerNode,
  SdkPlugins.node,
  PermissionSaved.node,
  PtyTicket.node,
  Credential.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
  SessionRestart.node,
])

export function createRoutes(
  password?: string,
  serviceURLs: () => ReadonlyArray<string> = () => [],
  corsOptions?: CorsOptions,
) {
  return makeRoutes(
    password
      ? ServerAuth.Config.configLayer({ username: "opencode", password: Option.some(password) })
      : ServerAuth.Config.layer,
    serviceURLs,
    corsOptions,
  )
}

export function createEmbeddedRoutes() {
  return makeRoutes(ServerAuth.Config.configLayer({ username: "opencode", password: Option.none() }))
}

function makeRoutes<AuthError, AuthServices>(
  auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>,
  serviceURLs: () => ReadonlyArray<string> = () => [],
  corsOptions?: CorsOptions,
) {
  const pluginRuntimeCell = PluginRuntime.makeCell()
  const replacements: LayerNode.Replacements = [
    [PluginRuntime.node, PluginRuntime.layerWithCell(pluginRuntimeCell)],
    [PluginRuntime.providerNode, PluginRuntime.providerNodeWithCell(pluginRuntimeCell)],
  ]
  const serviceLayer = simulateEnabled()
    ? Layer.unwrap(
        Effect.gen(function* () {
          const { simulationReplacements, startDriveServer } = yield* Effect.promise(
            () => import("@opencode-ai/simulation/backend"),
          )
          if (driveEnabled()) startDriveServer()
          return AppNodeBuilder.build(applicationServices, [
            ...replacements,
            ...(simulateEnabled() ? simulationReplacements : []),
          ])
        }),
      )
    : AppNodeBuilder.build(applicationServices, replacements)

  return serviceLayer.pipe(
    Layer.flatMap((context) => {
      const services = Layer.succeedContext(context)
      const requestServices = Layer.merge(
        Layer.succeedContext(Context.pick(PermissionSaved.Service, Project.Service)(context)),
        ServerInfo.layer(serviceURLs),
      )
      const apiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide(handlers.pipe(Layer.provide(services))),
        Layer.provide(formLocationLayer),
        Layer.provide(sessionLocationLayer),
        Layer.provide(layer),
        Layer.provide(authorizationLayer),
        Layer.provide(schemaErrorLayer),
        Layer.provide(auth),
        Layer.provide(Observability.layer),
        HttpRouter.provideRequest(requestServices),
        Layer.provideMerge(services),
      )
      return Layer.merge(apiRoutes, apiNotFoundRoute(corsOptions)).pipe(
        Layer.provide(cors(corsOptions)),
        Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
        Layer.provideMerge(HttpRouter.layer),
      )
    }),
  )
}

const cors = (options?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, options),
      maxAge: 86_400,
    }),
    { global: true },
  )

const apiNotFoundRoute = (options?: CorsOptions) =>
  HttpRouter.use((router) =>
    router.add("*", "/api/*", (request) => {
      const response = HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })
      const origin = request.headers.origin
      if (!origin || !isAllowedCorsOrigin(origin, options)) return Effect.succeed(response)
      return Effect.succeed(
        HttpServerResponse.setHeader(
          HttpServerResponse.setHeader(response, "access-control-allow-origin", origin),
          "vary",
          "Origin",
        ),
      )
    }),
  )

function simulateEnabled() {
  return !!process.env.OPENCODE_SIMULATE
}

function driveEnabled() {
  return !!process.env.OPENCODE_DRIVE
}

export const routes = createRoutes()

export const webHandler = () => HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)))
