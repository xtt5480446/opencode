import { Layer } from "effect"
import { buildLocationServiceMap, type LocationError, type LocationServices } from "../location-layer"
import { LocationServiceMap, node as locationServiceMapNode } from "../location-service-map"
import { LayerNode } from "./layer-node"
import { LayerNodeTree } from "./layer-node-tree"
import { makeGlobalNode, tiers } from "./scoped-node"

export function build<A, E>(
  root: LayerNode.Node<A, E, any>,
  replacements?: readonly LayerNode.Replacement[],
): Layer.Layer<LocationServiceMap | A, LocationError | E> {
  const separated = LayerNodeTree.separate(root, tiers)

  const location = LayerNodeTree.hoist(separated.location, tiers.values.location, tiers)

  const replacementMap = new Map(replacements?.map((item) => [item.source, item.replacement]))

  const locationMap = buildLocationServiceMap(
    location.node as unknown as LayerNode.Node<LocationServices, LocationError, any>,
    replacementMap,
  ).pipe(Layer.provide(LayerNodeTree.compile(location.hoisted, replacementMap)))

  const locationMapNode = makeGlobalNode({ service: LocationServiceMap, layer: locationMap, deps: [] })
  const globalNode = LayerNodeTree.bind(separated.global, locationServiceMapNode, locationMapNode)

  return LayerNodeTree.compile(globalNode, replacementMap).pipe(Layer.provideMerge(locationMap)) as Layer.Layer<
    LocationServiceMap | A,
    LocationError | E
  >
}

export * as ScopedNodeBuild from "./scoped-node-build"
