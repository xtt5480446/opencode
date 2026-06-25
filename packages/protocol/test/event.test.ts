import { describe, expect, test } from "bun:test"
import { Event } from "@opencode-ai/schema/event"
import { Schema } from "effect"
import { EventSchema } from "../src/groups/event"

describe("EventSchema", () => {
  test("requires durable metadata on durable events", () => {
    expect(
      Schema.is(EventSchema)({
        id: Event.ID.create(),
        type: "session.created",
        data: { sessionID: "session" },
      }),
    ).toBe(false)
  })

  test("rejects durable metadata on live events", () => {
    expect(
      Schema.is(EventSchema)({
        id: Event.ID.create(),
        type: "server.connected",
        durable: { aggregateID: "aggregate", seq: 0, version: 1 },
        data: {},
      }),
    ).toBe(false)
  })
})
