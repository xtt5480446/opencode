export * as WorkspaceV2 from "./workspace"

import { Context, Effect, Equal, Exit, Layer, RcMap, Schema, Scope } from "effect"
import { Workspace } from "@opencode-ai/schema/workspace"
import { eq } from "drizzle-orm"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { AbsolutePath } from "./schema"
import { WorkspaceTable } from "./control-plane/workspace.sql"
import { Sandbox } from "./workspace/sandbox"
import type { WorkspaceEnvironment } from "./workspace/environment"

export const ID = Workspace.ID
export type ID = typeof ID.Type

export const Info = Workspace.Info
export type Info = Workspace.Info

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Workspace.NotFoundError", {
  id: ID,
}) {}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("Workspace.InvalidError", {
  id: ID,
  message: Schema.String,
}) {}

export interface Interface {
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidError>
  readonly borrow: (
    id: ID,
  ) => Effect.Effect<
    WorkspaceEnvironment.Interface,
    NotFoundError | InvalidError | Sandbox.Error | Sandbox.ProviderNotFoundError,
    Scope.Scope
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Workspace") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const registry = yield* Sandbox.RegistryService

    const row = Effect.fn("Workspace.row")(function* (id: ID) {
      const value = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get().pipe(Effect.orDie)
      if (!value) return yield* new NotFoundError({ id })
      if (!value.directory) return yield* new InvalidError({ id, message: "Workspace has no directory" })
      return { ...value, directory: value.directory }
    })

    const get = Effect.fn("Workspace.get")(function* (id: ID) {
      const value = yield* row(id)
      const directory = AbsolutePath.make(value.directory)
      return Info.make({
        id,
        name: value.name,
        directory,
        project: { id: value.project_id, directory },
      })
    })

    const persistBinding = Effect.fnUntraced(function* (id: ID, previous: Sandbox.Binding, next: Sandbox.Binding) {
      if (Equal.equals(previous, next)) return
      yield* db
        .update(WorkspaceTable)
        .set({ extra: Sandbox.Placement.make({ kind: "sandbox", version: 1, binding: next }) })
        .where(eq(WorkspaceTable.id, id))
        .run()
        .pipe(Effect.orDie)
    })

    const connections = yield* RcMap.make({
      idleTimeToLive: "1 minute",
      lookup: Effect.fn("Workspace.connect")(function* (id: ID) {
        const placement = yield* row(id)
        if (!Schema.is(Sandbox.Placement)(placement.extra)) {
          return yield* new InvalidError({ id, message: "Workspace has no sandbox binding" })
        }
        const provider = yield* registry.get(placement.type)
        const binding = yield* provider.decode(placement.extra.binding)
        const connection = yield* provider.connect(binding)
        yield* persistBinding(id, binding, connection.binding)
        yield* persistBinding(id, connection.binding, yield* provider.reconcile(connection.binding))
        return connection
      }),
    })

    return Service.of({
      get,
      borrow: (id) =>
        RcMap.get(connections, id).pipe(
          Effect.onExit((exit) => (Exit.isFailure(exit) ? RcMap.invalidate(connections, id) : Effect.void)),
          Effect.map((connection) => connection.environment),
        ),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, Sandbox.registryNode],
})
