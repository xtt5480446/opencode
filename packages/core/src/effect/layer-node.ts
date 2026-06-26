import { Brand, Context, Layer } from "effect"

type AnyNode = Node<unknown, unknown, any>
type NodeList<Item extends AnyNode = AnyNode> = readonly [] | readonly [Item, ...Item[]]
type Output<Item> = [Item] extends [never] ? never : Item extends Node<infer A, unknown, any> ? A : never
type Error<Item> = [Item] extends [never] ? never : Item extends Node<unknown, infer E, any> ? E : never
type Missing<Required, Dependencies extends NodeList> = Exclude<Required, Output<Dependencies[number]>>
type CheckDependencies<Implementation extends Layer.Any, Dependencies extends NodeList> = [
  Missing<Layer.Services<Implementation>, Dependencies>,
] extends [never]
  ? unknown
  : { readonly "Missing dependencies": Missing<Layer.Services<Implementation>, Dependencies> }
declare const $OutputType: unique symbol
declare const $ErrorType: unique symbol

export type Tier<Name extends string = string> = Name & Brand.Brand<"LayerNode.Tier">

const makeTier = Brand.nominal<Tier>()

export interface Node<A, E = never, T extends Tier | undefined = undefined> {
  readonly kind: "layer" | "unbound" | "group"
  readonly name: string
  readonly service?: Context.Service.Any
  readonly implementation?: Layer.Any
  readonly dependencies: readonly AnyNode[]
  readonly tier?: T
  readonly [$OutputType]?: () => A
  readonly [$ErrorType]?: () => E
}

type NodeIdentity =
  | { readonly service: Context.Service.Any; readonly name?: never }
  | { readonly name: string; readonly service?: never }
type DistributiveOmit<A, K extends PropertyKey> = A extends unknown ? Omit<A, K> : never

type MakeInput<
  Implementation extends Layer.Any,
  Items extends NodeList,
  T extends Tier | undefined = undefined,
> = NodeIdentity & {
  readonly layer: Implementation
  readonly deps: Items & CheckDependencies<Implementation, NoInfer<Items>>
  readonly tier?: T
}

export function make<
  const Implementation extends Layer.Any,
  const Items extends NodeList,
  const T extends Tier | undefined = undefined,
>(
  input: MakeInput<Implementation, Items, T>,
): Node<
  Layer.Success<Implementation>,
  Layer.Error<Implementation> | Error<Items[number]>,
  T
> {
  return {
    kind: "layer",
    name: input.service !== undefined ? input.service.key : input.name,
    service: input.service,
    implementation: input.layer,
    dependencies: input.deps,
    tier: input.tier,
  }
}

export function unbound<R, Shape, const T extends Tier>(
  service: Context.Key<R, Shape>,
  tier: T,
): Node<R, never, T> {
  return {
    kind: "unbound",
    name: service.key,
    service,
    dependencies: [],
    tier,
  }
}

export function group<const Items extends readonly AnyNode[]>(
  dependencies: Items,
): Node<Output<Items[number]>, Error<Items[number]>> {
  return { kind: "group", name: "group", dependencies }
}

type AllowedTierNames<Names extends readonly string[], Name extends Names[number]> = Names extends readonly [
  infer Head extends string,
  ...infer Tail extends readonly string[],
]
  ? Head extends Name
    ? Head | Tail[number]
    : AllowedTierNames<Tail, Name>
  : never

type NodeInTiers<Names extends string> = Node<unknown, unknown, Tier<Names> | undefined>
type CheckTiers<Items extends NodeList, Names extends string> = [Exclude<Items[number], NodeInTiers<Names>>] extends [
  never,
]
  ? unknown
  : { readonly "Invalid tier dependencies": Exclude<Items[number], NodeInTiers<Names>> }

export interface Tiers<Names extends readonly [string, ...string[]]> {
  readonly names: Names
  readonly values: { readonly [K in Names[number]]: Tier<K> }
  readonly make: <Name extends Names[number]>(
    name: Name,
  ) => <const Implementation extends Layer.Any, const Items extends NodeList>(
    input: DistributiveOmit<MakeInput<Implementation, Items, Tier<Name>>, "tier"> &
      CheckTiers<Items, AllowedTierNames<Names, Name>>,
  ) => Node<
    Layer.Success<Implementation>,
    Layer.Error<Implementation> | Error<Items[number]>,
    Tier<Name>
  >
}

export function tiers<const Names extends readonly [string, ...string[]]>(names: Names): Tiers<Names> {
  const values = Object.fromEntries(names.map((name) => [name, makeTier(name)])) as Tiers<Names>["values"]
  return {
    names,
    values,
    make: ((name: Names[number]) => (input: DistributiveOmit<MakeInput<Layer.Any, NodeList, Tier>, "tier">) =>
      make({ ...input, tier: values[name] })) as Tiers<Names>["make"],
  }
}

export type Replacement = {
  readonly source: Layer.Any
  readonly replacement: Layer.Any
}

type CheckReplacementErrors<SourceError, ReplacementError> = [Exclude<ReplacementError, SourceError>] extends [never]
  ? unknown
  : { readonly "New replacement errors": Exclude<ReplacementError, SourceError> }

export function replace<A, E, R, E2>(
  source: Layer.Layer<A, E, R>,
  replacement: Layer.Layer<NoInfer<A>, E2, never> & CheckReplacementErrors<E, NoInfer<E2>>,
): Replacement {
  return { source, replacement }
}

export * as LayerNode from "./layer-node"
