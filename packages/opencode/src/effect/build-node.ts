import { Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodeTree } from "@opencode-ai/core/effect/layer-node-tree"

export function buildNode<A, E>(
  root: LayerNode.Node<A, E, any>,
  replacements?: readonly LayerNode.Replacement[],
): Layer.Layer<A, E> {
  return LayerNodeTree.compile(
    root,
    new Map(replacements?.map((item) => [item.source, item.replacement])),
  ) as Layer.Layer<A, E>
}
