import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodeTree } from "@opencode-ai/core/effect/layer-node-tree"
import { ScopedNode } from "@opencode-ai/core/effect/scoped-node"
import { ScopedNodeBuild } from "@opencode-ai/core/effect/scoped-node-build"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Location } from "@opencode-ai/core/location"

class Database extends Context.Service<Database, { readonly name: string }>()("test/GraphDatabase") {}
class Users extends Context.Service<Users, { readonly list: Effect.Effect<string[]> }>()("test/GraphUsers") {}
class App extends Context.Service<App, { readonly run: Effect.Effect<string[]> }>()("test/GraphApp") {}

test("separates, hoists, and compiles tier graphs", async () => {
  const tiers = LayerNode.tiers(["location", "global"])
  const global = tiers.make("global")
  const location = tiers.make("location")
  const database = global({
    service: Database,
    layer: Layer.succeed(Database, Database.of({ name: "Alice" })),
    deps: [],
  })
  const users = location({
    service: Users,
    layer: Layer.effect(
      Users,
      Effect.gen(function* () {
        const db = yield* Database
        return Users.of({ list: Effect.succeed([db.name]) })
      }),
    ),
    deps: [database],
  })
  const app = location({
    service: App,
    layer: Layer.effect(
      App,
      Effect.gen(function* () {
        const service = yield* Users
        return App.of({ run: service.list })
      }),
    ),
    deps: [users],
  })

  const separated = LayerNodeTree.separate(LayerNode.group([app]), tiers)
  expect(separated.location.dependencies).toEqual([app])
  expect(separated.global.dependencies).toEqual([])

  const locationResult = LayerNodeTree.hoist(separated.location, tiers.values.location, tiers)
  const globalResult = LayerNodeTree.hoist(
    { ...separated.global, dependencies: [...separated.global.dependencies, ...locationResult.hoisted.dependencies] },
    tiers.values.global,
    tiers,
  )
  expect(locationResult.node.dependencies[0]?.dependencies[0]?.dependencies[0]).toMatchObject({
    kind: "group",
    dependencies: [],
  })
  expect(locationResult.hoisted.dependencies).toEqual([database])

  const layer = LayerNodeTree.compile(locationResult.node).pipe(
    Layer.provide(LayerNodeTree.compile(globalResult.node)),
  ) as unknown as Layer.Layer<App>
  const program = Effect.gen(function* () {
    return yield* (yield* App).run
  }).pipe(Effect.provide(layer))

  expect(await Effect.runPromise(program)).toEqual(["Alice"])
})

test("rejects conflicting hoisted implementations", () => {
  const tiers = LayerNode.tiers(["location", "global"])
  const global = tiers.make("global")
  const location = tiers.make("location")
  const first = global({ service: Database, layer: Layer.succeed(Database, Database.of({ name: "first" })), deps: [] })
  const second = global({ service: Database, layer: Layer.succeed(Database, Database.of({ name: "second" })), deps: [] })
  const left = location({ service: Users, layer: Layer.effect(Users, Effect.as(Database, Users.of({ list: Effect.succeed([]) }))), deps: [first] })
  const right = location({ service: App, layer: Layer.effect(App, Effect.as(Database, App.of({ run: Effect.succeed([]) }))), deps: [second] })

  const separated = LayerNodeTree.separate(LayerNode.group([left, right]), tiers)
  expect(() => LayerNodeTree.hoist(separated.location, tiers.values.location, tiers)).toThrow(
    "Tier location has conflicting implementations for test/GraphDatabase",
  )
})

test("treats dependency groups as transparent while hoisting", () => {
  const tiers = LayerNode.tiers(["location", "global"])
  const global = tiers.make("global")
  const location = tiers.make("location")
  const database = global({
    service: Database,
    layer: Layer.succeed(Database, Database.of({ name: "Alice" })),
    deps: [],
  })
  const users = location({
    service: Users,
    layer: Layer.effect(Users, Effect.as(Database, Users.of({ list: Effect.succeed([]) }))),
    deps: [LayerNode.group([database])],
  })
  const separated = LayerNodeTree.separate(LayerNode.group([users]), tiers)
  const result = LayerNodeTree.hoist(separated.location, tiers.values.location, tiers)

  expect(result.node.dependencies[0]?.dependencies[0]?.dependencies[0]).toMatchObject({
    kind: "group",
    dependencies: [],
  })
})

test("builds the scoped location and global trees", async () => {
  const database = ScopedNode.makeGlobalNode({
    service: Database,
    layer: Layer.succeed(Database, Database.of({ name: "Alice" })),
    deps: [],
  })
  const app = ScopedNode.makeLocationNode({
    service: App,
    layer: Layer.effect(App, Effect.map(Database, (db) => App.of({ run: Effect.succeed([db.name]) }))),
    deps: [database],
  })
  const serviceLayer = ScopedNodeBuild.build(LayerNode.group([app]))
  const layer = LocationServiceMap.get({ directory: "/tmp" } as Location.Ref).pipe(
    Layer.provide(serviceLayer),
  ) as unknown as Layer.Layer<App>
  const program = Effect.gen(function* () {
    return yield* (yield* App).run
  }).pipe(Effect.provide(layer))

  expect(await Effect.runPromise(program)).toEqual(["Alice"])
})
