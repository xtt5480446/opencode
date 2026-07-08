export * as Search from "./search"

import { Search } from "@opencode-ai/schema/search"
import { Config as ConfigSchema } from "@opencode-ai/schema/config"
import { Context, Effect, Layer, Schema, Semaphore, Stream } from "effect"
import path from "node:path"
import { Config } from "./config"
import { ConfigGlobal } from "./config/global"
import { ConfigSearch } from "./config/search"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { Form } from "./form"
import { Global } from "./global"
import { Integration } from "./integration"
import { truthy } from "./flag/flag"

export const Input = Search.Input
export type Input = Search.Input

export const ProviderOutput = Search.ProviderOutput
export type ProviderOutput = Search.ProviderOutput

export const Result = Search.Result
export type Result = Search.Result

export class ProviderRequiredError extends Schema.TaggedErrorClass<ProviderRequiredError>()(
  "Search.ProviderRequired",
  {},
) {}

export class ProviderNotFoundError extends Schema.TaggedErrorClass<ProviderNotFoundError>()("Search.ProviderNotFound", {
  providerID: Integration.ID,
}) {}

export class ConnectionRequiredError extends Schema.TaggedErrorClass<ConnectionRequiredError>()(
  "Search.ConnectionRequired",
  { providerID: Integration.ID },
) {}

export class CancelledError extends Schema.TaggedErrorClass<CancelledError>()("Search.Cancelled", {}) {}

export class RequestError extends Schema.TaggedErrorClass<RequestError>()("Search.Request", {
  providerID: Integration.ID,
  cause: Schema.Defect(),
}) {}

export type Error =
  | ProviderRequiredError
  | ProviderNotFoundError
  | ConnectionRequiredError
  | CancelledError
  | RequestError

export interface QueryInput extends Input {
  readonly sessionID?: string
}

export interface Interface {
  readonly selected: () => Effect.Effect<Integration.ID | undefined>
  readonly select: (providerID: Integration.ID) => Effect.Effect<void, ProviderNotFoundError>
  readonly query: (input: QueryInput) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Search") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const configGlobal = yield* ConfigGlobal.Service
    const events = yield* EventV2.Service
    const forms = yield* Form.Service
    const global = yield* Global.Service
    const integrations = yield* Integration.Service
    const onboarding = Semaphore.makeUnsafe(1)
    const decodeOutput = Schema.decodeUnknownEffect(ProviderOutput)
    const globalConfigPath = path.resolve(global.config)
    let pendingProviderID: Integration.ID | undefined

    const requireProvider = (
      providers: Map<Integration.ID, Integration.SearchImplementation>,
      providerID: Integration.ID,
    ) => {
      const provider = providers.get(providerID)
      return provider ? Effect.succeed(provider) : Effect.fail(new ProviderNotFoundError({ providerID }))
    }

    const globalProviderID = Effect.fn("Search.globalProviderID")(function* () {
      const entries = (yield* config.entries()).filter(
        (entry) => entry.type === "document" && entry.path && path.dirname(entry.path) === globalConfigPath,
      )
      return Config.latest(entries, "search")?.provider
    })

    const selected = Effect.fn("Search.selected")(function* () {
      return pendingProviderID ?? (yield* globalProviderID())
    })

    const saveProvider = Effect.fn("Search.saveProvider")(function* (providerID: Integration.ID) {
      pendingProviderID = providerID
      yield* configGlobal.update(["search"], new ConfigSearch.Info({ provider: providerID })).pipe(
        Effect.tapError(() => Effect.sync(() => (pendingProviderID = undefined))),
        Effect.orDie,
      )
    })

    yield* events.subscribe(ConfigSchema.Event.Updated).pipe(
      Stream.runForEach(() =>
        globalProviderID().pipe(
          Effect.tap((providerID) =>
            Effect.sync(() => {
              if (providerID === pendingProviderID) pendingProviderID = undefined
            }),
          ),
          Effect.ignore,
        ),
      ),
      Effect.forkScoped,
    )

    const ask = Effect.fn("Search.ask")(function* (
      providers: Map<Integration.ID, Integration.SearchImplementation>,
      sessionID: string,
    ) {
      if (providers.size === 0) return yield* new ProviderRequiredError()
      const infos = new Map((yield* integrations.list()).map((integration) => [integration.id, integration]))
      const state = yield* forms
        .ask({
          sessionID,
          title: "Choose a web search provider",
          metadata: { kind: "search.provider" },
          mode: "form",
          fields: [
            {
              key: "provider",
              title: "Provider",
              description: "This becomes your default and can be changed later from Connect integration.",
              type: "string",
              required: true,
              custom: false,
              options: Array.from(providers.values())
                .flatMap((provider) => {
                  const info = infos.get(provider.integrationID)
                  if (!info) return []
                  const disconnected = provider.connection === "optional" ? "Keyless available" : "Connection required"
                  return [{ info, description: info.connections.length ? "Connected" : disconnected }]
                })
                .toSorted((a, b) => a.info.name.localeCompare(b.info.name))
                .map(({ info, description }) => ({
                  value: info.id,
                  label: info.name,
                  description,
                })),
            },
          ],
        })
        .pipe(Effect.orDie)
      if (state.status === "cancelled") return yield* new CancelledError()
      const answer = state.answer.provider
      if (typeof answer !== "string") return yield* new ProviderRequiredError()
      return yield* requireProvider(providers, Integration.ID.make(answer))
    })

    const connect = Effect.fn("Search.connect")(function* (
      provider: Integration.SearchImplementation,
      sessionID?: string,
    ) {
      const active = yield* integrations.connection.active(provider.integrationID)
      if (active || provider.connection === "optional") return active
      if (!sessionID) return yield* new ConnectionRequiredError({ providerID: provider.integrationID })
      const state = yield* forms
        .ask({
          sessionID,
          title: `Connect ${provider.integrationID}`,
          metadata: { kind: "integration.connection" },
          mode: "integration",
          integrationID: provider.integrationID,
        })
        .pipe(Effect.orDie)
      if (state.status === "cancelled") return yield* new CancelledError()
      const connected = yield* integrations.connection.active(provider.integrationID)
      if (!connected) return yield* new ConnectionRequiredError({ providerID: provider.integrationID })
      return connected
    })

    const resolve = Effect.fn("Search.resolve")(function* (input: QueryInput) {
      const providers = new Map(
        (yield* integrations.search.list()).map((provider) => [provider.integrationID, provider]),
      )
      if (input.providerID) return yield* requireProvider(providers, input.providerID)
      const configuredProviderID = Config.latest(yield* config.entries(), "search")?.provider
      if (configuredProviderID) return yield* requireProvider(providers, configuredProviderID)
      if (process.env.OPENCODE_WEBSEARCH_PROVIDER) {
        return yield* requireProvider(providers, Integration.ID.make(process.env.OPENCODE_WEBSEARCH_PROVIDER))
      }
      if (truthy("OPENCODE_ENABLE_PARALLEL") || truthy("OPENCODE_EXPERIMENTAL_PARALLEL")) {
        return yield* requireProvider(providers, Integration.ID.make("parallel"))
      }
      if (truthy("OPENCODE_EXPERIMENTAL") || truthy("OPENCODE_ENABLE_EXA") || truthy("OPENCODE_EXPERIMENTAL_EXA")) {
        return yield* requireProvider(providers, Integration.ID.make("exa"))
      }
      const providerID = yield* selected()
      const provider = providerID ? providers.get(providerID) : undefined
      if (provider) return provider
      const sessionID = input.sessionID
      if (!sessionID) return yield* new ProviderRequiredError()
      return yield* onboarding.withPermit(
        Effect.gen(function* () {
          const current = yield* selected()
          const selectedProvider = current ? providers.get(current) : undefined
          if (selectedProvider) return selectedProvider
          const provider = yield* ask(providers, sessionID)
          yield* connect(provider, sessionID)
          yield* saveProvider(provider.integrationID)
          return provider
        }),
      )
    })

    return Service.of({
      selected,
      select: Effect.fn("Search.select")(function* (providerID) {
        const provider = yield* integrations.search.get(providerID)
        if (!provider) return yield* new ProviderNotFoundError({ providerID })
        yield* saveProvider(providerID)
      }),
      query: Effect.fn("Search.query")(function* (input) {
        const provider = yield* resolve(input)
        const connection = yield* connect(provider, input.sessionID)
        const credential = connection
          ? yield* integrations.connection
              .resolve(connection)
              .pipe(Effect.mapError((cause) => new RequestError({ providerID: provider.integrationID, cause })))
          : undefined
        const output = yield* provider.execute(input, { credential, sessionID: input.sessionID }).pipe(
          Effect.flatMap(decodeOutput),
          Effect.mapError((cause) => new RequestError({ providerID: provider.integrationID, cause })),
        )
        return new Result({ providerID: provider.integrationID, ...output })
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, ConfigGlobal.node, EventV2.node, Form.node, Global.node, Integration.node],
})
