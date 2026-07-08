import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { Search } from "@opencode-ai/core/search"
import { InvalidRequestError, ServiceUnavailableError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const SearchHandler = HttpApiBuilder.group(Api, "server.search", (handlers) =>
  Effect.gen(function* () {
    const awaitPlugins = Effect.fn("server.search.awaitPlugins")(function* () {
      const plugins = yield* PluginSupervisor.Service
      yield* plugins.ready.pipe(
        Effect.timeoutOrElse({
          duration: "5 seconds",
          orElse: () =>
            Effect.fail(
              new ServiceUnavailableError({
                message: "Search integration initialization timed out",
                service: "search",
              }),
            ),
        }),
      )
    })
    return handlers
      .handle(
        "search.provider.get",
        Effect.fn("server.search.provider.get")(function* () {
          const search = yield* Search.Service
          return yield* response(search.selected())
        }),
      )
      .handle(
        "search.provider.select",
        Effect.fn("server.search.provider.select")(function* (request) {
          yield* awaitPlugins()
          const search = yield* Search.Service
          yield* search.select(request.payload.providerID).pipe(
            Effect.mapError(
              (error) =>
                new InvalidRequestError({
                  message: `Search provider not found: ${error.providerID}`,
                  kind: "search_provider_not_found",
                  field: "providerID",
                }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "search.query",
        Effect.fn("server.search.query")(function* (request) {
          yield* awaitPlugins()
          const search = yield* Search.Service
          return yield* response(
            search.query(request.payload).pipe(
              Effect.catchTags({
                "Search.ProviderRequired": () =>
                  new InvalidRequestError({
                    message: "Search provider is required",
                    kind: "search_provider_required",
                    field: "providerID",
                  }),
                "Search.ProviderNotFound": (error) =>
                  new InvalidRequestError({
                    message: `Search provider not found: ${error.providerID}`,
                    kind: "search_provider_not_found",
                    field: "providerID",
                  }),
                "Search.ConnectionRequired": (error) =>
                  new InvalidRequestError({
                    message: `Search provider requires a connection: ${error.providerID}`,
                    kind: "search_connection_required",
                    field: "providerID",
                  }),
                "Search.Cancelled": () =>
                  new InvalidRequestError({ message: "Search cancelled", kind: "search_cancelled" }),
                "Search.Request": (error) =>
                  new ServiceUnavailableError({
                    message: `Search request failed: ${error.providerID}`,
                    service: error.providerID,
                  }),
              }),
            ),
          )
        }),
      )
  }),
)
