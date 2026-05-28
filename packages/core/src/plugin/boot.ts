export * as PluginBoot from "./boot"

import { Context, Deferred, Effect, Layer } from "effect"
import { AccountV2 } from "../account"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { ConfigProvider } from "../config/provider"
import { EventV2 } from "../event"
import { Npm } from "../npm"
import { PluginV2 } from "../plugin"
import { AccountPlugin } from "./account"
import { EnvPlugin } from "./env"
import { ModelsDevPlugin } from "./models-dev"
import { ProviderPlugins } from "./provider"

type Plugin = {
  id: PluginV2.ID
  effect: PluginV2.Effect<
    Catalog.Service | AccountV2.Service | Npm.Service | EventV2.Service | PluginV2.Service | Config.Service
  >
}

export interface Interface {
  readonly wait: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/PluginBoot") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const plugin = yield* PluginV2.Service
    const accounts = yield* AccountV2.Service
    const config = yield* Config.Service
    const npm = yield* Npm.Service
    const events = yield* EventV2.Service
    const done = yield* Deferred.make<void>()

    const add = Effect.fn("PluginBoot.add")(function* (input: Plugin) {
      yield* plugin.add({
        id: input.id,
        effect: input.effect.pipe(
          Effect.provideService(Catalog.Service, catalog),
          Effect.provideService(AccountV2.Service, accounts),
          Effect.provideService(Config.Service, config),
          Effect.provideService(Npm.Service, npm),
          Effect.provideService(EventV2.Service, events),
          Effect.provideService(PluginV2.Service, plugin),
        ),
      })
    })

    const boot = Effect.gen(function* () {
      yield* add(EnvPlugin)
      yield* add(AccountPlugin)
      for (const item of ProviderPlugins) {
        yield* add(item)
      }
      yield* add(ModelsDevPlugin)
      yield* add(ConfigProvider.Plugin)
    }).pipe(Effect.withSpan("PluginBoot.boot"))

    yield* boot.pipe(
      Effect.exit,
      Effect.flatMap((exit) => Deferred.done(done, exit)),
      Effect.forkScoped,
    )

    return Service.of({
      wait: () => Deferred.await(done),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Catalog.defaultLayer),
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(PluginV2.defaultLayer),
  Layer.provide(AccountV2.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Npm.defaultLayer),
)
