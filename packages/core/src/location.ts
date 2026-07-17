import { Context, Effect, Layer } from "effect"
import { Info, Ref, response } from "@opencode-ai/schema/location"
import path from "path"
import { Project } from "./project"
import { LayerNode } from "./effect/layer-node"
import { makeLocationNode, tags } from "./effect/app-node"
import { WorkspaceV2 } from "./workspace"

export * as Location from "./location"

export { Info, Ref, response }

export interface Interface extends Info {
  readonly vcs?: Project.Vcs
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Location") {}

export const node = LayerNode.unbound(Service, tags.values.location)

const localLayer = (ref: Ref) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const project = yield* Project.Service
      const resolved = yield* project.resolve(ref.directory)
      return Service.of({
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        project: { id: resolved.id, directory: resolved.directory },
        vcs: resolved.vcs,
      })
    }),
  )

const hostedLayer = (ref: Ref & { readonly workspaceID: WorkspaceV2.ID }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const workspace = yield* WorkspaceV2.Service
      const info = yield* workspace.get(ref.workspaceID)
      const relative = path.posix.relative(info.directory, ref.directory)
      if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
        return yield* new WorkspaceV2.InvalidError({
          id: ref.workspaceID,
          message: `Location directory is outside Workspace root: ${ref.directory}`,
        })
      }
      return Service.of({
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        project: info.project,
      })
    }),
  ).pipe(Layer.orDie)

export const boundNode = (ref: Ref) => {
  if (ref.workspaceID) {
    return makeLocationNode({
      service: Service,
      layer: hostedLayer({ ...ref, workspaceID: ref.workspaceID }),
      deps: [WorkspaceV2.node],
    })
  }
  return makeLocationNode({
    service: Service,
    layer: localLayer(ref),
    deps: [Project.node],
  })
}
