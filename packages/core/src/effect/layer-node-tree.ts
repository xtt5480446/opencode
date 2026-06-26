import { Layer } from "effect"
import { LayerNode } from "./layer-node"

type AnyNode = LayerNode.Node<unknown, unknown, any>
type RuntimeLayer = Layer.Layer<never, unknown, unknown>

type Separated<N, Names extends readonly [string, ...string[]]> = {
  readonly [Name in Names[number]]: N extends LayerNode.Node<infer A, infer E, any>
    ? LayerNode.Node<A, E>
    : never
}

export function separate<const Root extends AnyNode, const Names extends readonly [string, ...string[]]>(
  root: Root,
  tiers: LayerNode.Tiers<Names>,
): Separated<Root, Names> {
  const roots = new Map<LayerNode.Tier, AnyNode[]>()
  const serviceTiers = new Map<string, LayerNode.Tier>()
  const visited = new Set<AnyNode>()

  const validate = (node: AnyNode) => {
    if (node.kind === "group") {
      node.dependencies.forEach(validate)
      return
    }
    if (visited.has(node)) return
    visited.add(node)
    const tier = requireTier(node, tiers)
    const existing = serviceTiers.get(node.name)
    if (existing && existing !== tier) {
      throw new Error(`Service ${node.name} belongs to both tier ${existing} and tier ${tier}`)
    }
    serviceTiers.set(node.name, tier)
    node.dependencies.forEach(validate)
  }
  validate(root)

  for (const node of flatten(root)) {
    const tier = requireTier(node, tiers)
    const current = roots.get(tier) ?? []
    roots.set(tier, current)
    current.push(node)
  }

  return Object.fromEntries(
    tiers.names.map((name) => [name, LayerNode.group(roots.get(tiers.values[name as Names[number]]) ?? [])]),
  ) as Separated<Root, Names>
}

export function hoist<A, E, T extends LayerNode.Tier>(
  root: LayerNode.Node<A, E, any>,
  tier: T,
  tiers: LayerNode.Tiers<readonly [string, ...string[]]>,
): {
  readonly node: LayerNode.Node<A, E>
  readonly hoisted: LayerNode.Node<unknown, unknown>
} {
  const indexes = new Map(tiers.names.map((name, index) => [tiers.values[name], index]))
  const current = indexes.get(tier)
  if (current === undefined) throw new Error(`Tier ${tier} is not in the tier configuration`)
  const visited = new Map<AnyNode, AnyNode>()
  const hoisted = new Map<string, AnyNode>()
  let hoistedTier: LayerNode.Tier | undefined
  const visiting = new Set<AnyNode>()
  const stack: AnyNode[] = []

  const visit = (node: AnyNode): AnyNode => {
    if (node.kind === "group") {
      return { ...node, dependencies: node.dependencies.map(visit) }
    }

    const existingNode = visited.get(node)
    if (existingNode) return existingNode

    const dependencyTier = requireTier(node, tiers)
    const index = indexes.get(dependencyTier)!
    if (index < current) throw new Error(`Tier ${tier} cannot depend on lower tier ${dependencyTier}`)
    if (index > current) {
      if (hoistedTier && hoistedTier !== dependencyTier) {
        throw new Error(`Tree ${tier} hoists dependencies into multiple tiers`)
      }
      hoistedTier = dependencyTier
      const existing = hoisted.get(node.name)
      if (existing && existing !== node) {
        throw new Error(`Tier ${tier} has conflicting implementations for ${node.name}`)
      }
      hoisted.set(node.name, node)
      const empty = LayerNode.group([])
      visited.set(node, empty)
      return empty
    }
    if (node.kind === "unbound") {
      return node
    }

    if (visiting.has(node)) {
      const start = stack.indexOf(node)
      throw new Error(
        `Cycle detected in layer tree: ${[...stack.slice(start), node].map((item) => item.name).join(" -> ")}`,
      )
    }
    visiting.add(node)
    stack.push(node)
    try {
      const dependencies = node.dependencies.map(visit)
      const clone = { ...node, dependencies }
      visited.set(node, clone)
      return clone
    } finally {
      stack.pop()
      visiting.delete(node)
    }
  }

  return {
    node: visit(root) as LayerNode.Node<A, E>,
    hoisted: LayerNode.group(Array.from(hoisted.values())),
  }
}

export function compile(
  root: LayerNode.Node<unknown, unknown, any>,
  replacements?: ReadonlyMap<Layer.Any, Layer.Any>,
): Layer.Layer<never, unknown> {
  const cache = new Map<AnyNode, RuntimeLayer>()
  const compileNode = (node: AnyNode): RuntimeLayer => {
    if (node.kind === "unbound") throw new Error(`Unbound layer node: ${node.name}`)
    const cached = cache.get(node)
    if (cached) return cached
    const dependencies = node.dependencies.flatMap(flatten).map(compileNode)
    const implementation = (replacements?.get(node.implementation!) ?? node.implementation!) as RuntimeLayer
    const layer =
      dependencies.length === 0
        ? implementation
        : implementation.pipe(Layer.provide(dependencies as [RuntimeLayer, ...RuntimeLayer[]]))
    cache.set(node, layer)
    return layer
  }
  const layers = flatten(root).map((node) => compileNode(node))
  const layer = layers.reduce<RuntimeLayer>((result, layer) => layer.pipe(Layer.provideMerge(result)), Layer.empty)
  return layer as Layer.Layer<never, unknown>
}

export function bind<A, E, T extends LayerNode.Tier | undefined>(
  root: LayerNode.Node<A, E, T>,
  source: AnyNode,
  replacement: AnyNode,
): LayerNode.Node<A, E, T> {
  if (source.kind !== "unbound") throw new Error(`Cannot bind non-unbound layer node: ${source.name}`)
  if (source.name !== replacement.name) {
    throw new Error(`Cannot bind ${source.name} to ${replacement.name}`)
  }
  if (source.tier !== replacement.tier) {
    throw new Error(`Cannot bind ${source.name} across tiers`)
  }
  const visited = new Map<AnyNode, AnyNode>()
  const visit = (node: AnyNode): AnyNode => {
    if (node === source) return replacement
    const existing = visited.get(node)
    if (existing) return existing
    if (node.kind === "unbound") return node
    const clone = { ...node, dependencies: node.dependencies.map(visit) }
    visited.set(node, clone)
    return clone
  }
  return visit(root) as LayerNode.Node<A, E, T>
}

function flatten(node: AnyNode): readonly AnyNode[] {
  return node.kind === "group" ? node.dependencies.flatMap(flatten) : [node]
}

function requireTier(node: AnyNode, tiers: LayerNode.Tiers<readonly [string, ...string[]]>): LayerNode.Tier {
  const tier =
    node.tier ?? (tiers.names.length === 1 && tiers.names[0] === "untiered" ? tiers.values.untiered : undefined)
  if (!tier || !tiers.names.some((name) => tiers.values[name] === tier)) {
    throw new Error(`Node ${node.name} is not in the tier configuration`)
  }
  return tier
}

export * as LayerNodeTree from "./layer-node-tree"
