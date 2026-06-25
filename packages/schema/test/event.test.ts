import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Event } from "../src/event"

describe("public event schemas", () => {
  test("definition is pure", () => {
    const definitions = Event.inventory()
    Event.define({ type: "test.pure", schema: { value: Schema.String } })
    expect(definitions).toEqual([])
  })

  test("latest selection is independent of declaration order", () => {
    const historical = Event.define({
      type: "test.versioned",
      durable: { aggregate: "id", version: 1 },
      schema: { id: Schema.String },
    })
    const current = Event.define({
      type: "test.versioned",
      durable: { aggregate: "id", version: 2 },
      schema: { id: Schema.String, value: Schema.String },
    })

    expect(Event.latest([historical, current]).get(current.type)).toBe(current)
    expect(Event.latest([current, historical]).get(current.type)).toBe(current)
  })

  test("durable definitions are indexed by type and version", () => {
    const definition = Event.define({
      type: "test.durable",
      durable: { aggregate: "id", version: 1 },
      schema: { id: Schema.String },
    })

    expect(Event.durable([definition]).get("test.durable.1")).toBe(definition)
  })

  test("durable definitions require published commit metadata", () => {
    const definition = Event.define({
      type: "test.durable",
      durable: { aggregate: "id", version: 1 },
      schema: { id: Schema.String },
    })
    const payload: typeof definition.Type = {
      id: Event.ID.create(),
      type: definition.type,
      durable: { aggregateID: "aggregate", seq: 0, version: 1 },
      data: { id: "aggregate" },
    }

    expect(Schema.is(definition)(payload)).toBe(true)
    expect(
      Schema.is(definition)({
        id: Event.ID.create(),
        type: definition.type,
        data: { id: "aggregate" },
      }),
    ).toBe(false)
    // @ts-expect-error Published durable payloads require commit metadata.
    const missing: typeof definition.Type = { id: Event.ID.create(), type: definition.type, data: { id: "aggregate" } }
    void missing
  })

  test("live definitions reject durable commit metadata", () => {
    const definition = Event.define({
      type: "test.live",
      schema: { value: Schema.String },
    })
    const payload: typeof definition.Type = {
      id: Event.ID.create(),
      type: definition.type,
      data: { value: "value" },
    }

    expect(Schema.is(definition)(payload)).toBe(true)
    expect(
      Schema.is(definition)({
        ...payload,
        durable: { aggregateID: "aggregate", seq: 0, version: 1 },
      }),
    ).toBe(false)

    const invalid: typeof definition.Type = {
      ...payload,
      // @ts-expect-error Live payloads cannot carry durable commit metadata.
      durable: { aggregateID: "aggregate", seq: 0, version: 1 },
    }
    void invalid
  })

  test("mixed definition payloads preserve durability correlation", () => {
    const durable = Event.define({
      type: "test.mixed.durable",
      durable: { aggregate: "id", version: 2 },
      schema: { id: Schema.String },
    })
    const live = Event.define({
      type: "test.mixed.live",
      schema: { value: Schema.String },
    })
    type Mixed = Event.Payload<typeof durable | typeof live>

    const committed: Mixed = {
      id: Event.ID.create(),
      type: durable.type,
      durable: { aggregateID: "aggregate", seq: 0, version: 2 },
      data: { id: "aggregate" },
    }
    const ephemeral: Mixed = {
      id: Event.ID.create(),
      type: live.type,
      data: { value: "value" },
    }
    void committed
    void ephemeral

    // @ts-expect-error Durable union members require commit metadata.
    const uncommitted: Mixed = { id: Event.ID.create(), type: durable.type, data: { id: "aggregate" } }
    // @ts-expect-error Live union members cannot carry durable commit metadata.
    const falselyCommitted: Mixed = {
      id: Event.ID.create(),
      type: live.type,
      durable: { aggregateID: "aggregate", seq: 0, version: 2 },
      data: { value: "value" },
    }
    void uncommitted
    void falselyCommitted
  })
})
