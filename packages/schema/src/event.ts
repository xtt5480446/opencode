export * as Event from "./event"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { Location } from "./location"
import { statics } from "./schema"

export const ID = Schema.String.check(Schema.isStartsWith("evt_")).pipe(
  Schema.brand("Event.ID"),
  statics((schema) => ({ create: () => schema.make("evt_" + ascending()) })),
)
export type ID = typeof ID.Type

export type DurableOptions = {
  readonly version: number
  readonly aggregate: string
}

export type DurableEnvelope = {
  readonly aggregateID: string
  readonly seq: number
  readonly version: number
}

const PublishedDurableEnvelope = Schema.Struct({
  aggregateID: Schema.String,
  seq: Schema.Number,
  version: Schema.Number,
})
const NoDurableEnvelope = Schema.optional(Schema.Never)

export type LiveDefinition<
  Type extends string = string,
  DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
> = Schema.Top & {
  readonly type: Type
  readonly data: DataSchema
  readonly durable?: never
}

export type DurableDefinition<
  Type extends string = string,
  DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
  Durability extends DurableOptions = DurableOptions,
> = Schema.Top & {
  readonly type: Type
  readonly data: DataSchema
  readonly durable: Durability
}

export type Definition<
  Type extends string = string,
  DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
> = LiveDefinition<Type, DataSchema> | DurableDefinition<Type, DataSchema>

export type Data<D extends Definition> = Schema.Schema.Type<D["data"]>

export type UncommittedPayload<D extends Definition = Definition> = D extends Definition
  ? {
      readonly id: ID
      readonly type: D["type"]
      readonly data: Data<D>
      readonly location?: Location.Ref
      readonly metadata?: Record<string, unknown>
    }
  : never

export type PublishedPayload<D extends Definition = Definition> = D extends DurableDefinition
  ? UncommittedPayload<D> & { readonly durable: DurableEnvelope }
  : D extends LiveDefinition
    ? UncommittedPayload<D> & { readonly durable?: never }
    : never

export type Payload<D extends Definition = Definition> = PublishedPayload<D>

type LiveEventSchema<
  Type extends string,
  Fields extends Readonly<Record<PropertyKey, Schema.Codec<unknown, unknown>>>,
> = Schema.Schema<PublishedPayload<LiveDefinition<Type, Schema.Struct<Fields>>>> &
  LiveDefinition<Type, Schema.Struct<Fields>>

type DurableEventSchema<
  Type extends string,
  Fields extends Readonly<Record<PropertyKey, Schema.Codec<unknown, unknown>>>,
  Durability extends DurableOptions,
> = Schema.Schema<PublishedPayload<DurableDefinition<Type, Schema.Struct<Fields>, Durability>>> &
  DurableDefinition<Type, Schema.Struct<Fields>, Durability>

export function define<
  const Type extends string,
  Fields extends Readonly<Record<PropertyKey, Schema.Codec<unknown, unknown>>>,
>(input: { readonly type: Type; readonly durable?: never; readonly schema: Fields }): LiveEventSchema<Type, Fields>
export function define<
  const Type extends string,
  Fields extends Readonly<Record<PropertyKey, Schema.Codec<unknown, unknown>>>,
  const Durability extends DurableOptions,
>(input: {
  readonly type: Type
  readonly durable: Durability
  readonly schema: Fields
}): DurableEventSchema<Type, Fields, Durability>
export function define(input: {
  readonly type: string
  readonly durable?: DurableOptions
  readonly schema: Readonly<Record<PropertyKey, Schema.Codec<unknown, unknown>>>
}): Schema.Top {
  const data = Schema.Struct(input.schema)
  const fields = {
    id: ID,
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    type: Schema.Literal(input.type),
    location: Schema.optional(Location.Ref),
    data,
  }
  if (input.durable) {
    return Object.assign(
      Schema.Struct({ ...fields, durable: PublishedDurableEnvelope }).annotate({
        identifier: input.type,
      }),
      { type: input.type, durable: input.durable, data },
    )
  }
  return Object.assign(Schema.Struct({ ...fields, durable: NoDurableEnvelope }).annotate({ identifier: input.type }), {
    type: input.type,
    data,
  })
}

export function inventory<const Definitions extends ReadonlyArray<Definition>>(...definitions: Definitions) {
  return Object.freeze(definitions)
}

export function latest(definitions: ReadonlyArray<Definition>) {
  return readonlyMap(
    definitions.reduce((result, definition) => {
      const existing = result.get(definition.type)
      if (!existing) {
        result.set(definition.type, definition)
        return result
      }
      if (definition.durable && existing.durable && definition.durable.version !== existing.durable.version) {
        if (definition.durable.version > existing.durable.version) result.set(definition.type, definition)
        return result
      }
      if (definition !== existing) throw new Error(`Duplicate latest event definition for ${definition.type}`)
      return result
    }, new Map<string, Definition>()),
  )
}

export function versionedType(type: string, version: number) {
  return `${type}.${version}`
}

export function durable(definitions: ReadonlyArray<Definition>) {
  return readonlyMap(
    definitions.reduce((result, definition) => {
      if (!definition.durable) return result
      const key = versionedType(definition.type, definition.durable.version)
      if (result.has(key)) throw new Error(`Duplicate durable event definition for ${key}`)
      result.set(key, definition)
      return result
    }, new Map<string, DurableDefinition>()),
  )
}

function readonlyMap<Key, Value>(map: Map<Key, Value>): ReadonlyMap<Key, Value> {
  const result: ReadonlyMap<Key, Value> = Object.freeze({
    get size() {
      return map.size
    },
    entries: () => map.entries(),
    forEach: (callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown) =>
      map.forEach((value, key) => callback.call(thisArg, value, key, result)),
    get: (key: Key) => map.get(key),
    has: (key: Key) => map.has(key),
    keys: () => map.keys(),
    values: () => map.values(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
  })
  return result
}
