import { describe, expect, test } from "bun:test"
import { coalesceServerEvents, enqueueServerEvent, resumeStreamAfterPageShow } from "./server-sdk"
import type { AppEvent } from "./backend"

describe("resumeStreamAfterPageShow", () => {
  test("restarts a stream only after a back-forward cache restore", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(1)
  })
})

describe("coalesceServerEvents", () => {
  const delta = (value: string, field = "text", partID = "part") => ({
    directory: "/repo",
    payload: {
      type: "timeline.delta",
      sessionID: "ses",
      itemID: "msg",
      contentID: partID,
      field,
      delta: value,
    } as AppEvent,
  })

  test("merges adjacent deltas for the same field", () => {
    const first = delta("hello ")
    const second = delta("world")
    const result = coalesceServerEvents([first, second])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload).toMatchObject({ delta: "hello world" })
  })

  test("preserves event boundaries and distinct fields", () => {
    const status = {
      directory: "/repo",
      payload: { type: "session.activity", sessionID: "ses", activity: { type: "idle" } } as AppEvent,
    }
    const result = coalesceServerEvents([delta("a"), delta("b", "metadata"), status, delta("c")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "timeline.delta",
      "timeline.delta",
      "session.activity",
      "timeline.delta",
    ])
  })

  test("preserves event ID order across interleaved deltas", () => {
    const first = delta("a")
    const other = delta("b", "text", "other")
    const last = delta("c")
    const result = coalesceServerEvents([first, other, last])

    expect(result.map((event) => event.payload.type)).toEqual(["timeline.delta", "timeline.delta", "timeline.delta"])
  })
})

describe("enqueueServerEvent", () => {
  const partUpdated = (text: string) =>
    ({
      type: "timeline.updated",
      item: {
        type: "user",
        id: "message",
        sessionID: "session",
        created: 1,
        content: [{ id: "part", type: "text", text }],
      },
    }) as AppEvent

  test("preserves part updates across message remove and re-add barriers", () => {
    const events: Array<{ directory: string; payload: AppEvent }> = []
    const enqueue = (payload: AppEvent) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({ type: "timeline.removed", sessionID: "session", itemID: "message" })
    enqueue({
      type: "timeline.updated",
      item: {
        type: "user",
        created: 1,
        content: [],
        sessionID: "session",
        id: "message",
      },
    })
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "timeline.updated",
      "timeline.removed",
      "timeline.updated",
    ])
  })

  test("preserves deltas after a replacement snapshot", () => {
    const events: Array<{ directory: string; payload: AppEvent }> = []
    const enqueue = (payload: AppEvent) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("a"))
    enqueue(partUpdated("ab"))
    enqueue({
      type: "timeline.delta",
      sessionID: "session",
      itemID: "message",
      contentID: "part",
      field: "text",
      delta: "c",
    })

    const result = coalesceServerEvents(events)
    expect(result.map((event) => event.payload.type)).toEqual(["timeline.updated", "timeline.delta"])
    expect(result[0]?.payload).toMatchObject({ item: { content: [{ text: "ab" }] } })
    expect(result[1]?.payload).toMatchObject({ delta: "c" })
  })

  test("preserves updates after session deletion", () => {
    const events: Array<{ directory: string; payload: AppEvent }> = []
    const enqueue = (payload: AppEvent) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({
      type: "session.deleted",
      sessionID: "session",
    })
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "timeline.updated",
      "session.deleted",
      "timeline.updated",
    ])
  })

  test("does not coalesce edge-triggered session statuses", () => {
    const events: Array<{ directory: string; payload: AppEvent }> = []
    const enqueue = (status: "retry" | "busy") =>
      enqueueServerEvent(events, {
        directory: "/repo",
        payload: {
          type: "session.activity",
          sessionID: "session",
          activity: status === "retry" ? { type: "retry", attempt: 1, message: "retry", next: 1 } : { type: "running" },
        },
      })

    enqueue("retry")
    enqueue("busy")

    expect(events).toHaveLength(2)
  })
})
