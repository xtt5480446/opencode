import { describe, expect, test, vi } from "bun:test"
import { createScrollPersistence } from "./layout-scroll"

describe("createScrollPersistence", () => {
  test("debounces persisted scroll writes", () => {
    vi.useFakeTimers()
    try {
      const snapshot = {
        session: {
          review: { x: 0, y: 0 },
        },
      } as Record<string, Record<string, { x: number; y: number }>>
      const writes: Array<Record<string, { x: number; y: number }>> = []
      const scroll = createScrollPersistence({
        debounceMs: 10,
        getSnapshot: (sessionKey) => snapshot[sessionKey],
        onFlush: (sessionKey, next) => {
          snapshot[sessionKey] = next
          writes.push(next)
        },
      })

      for (const i of Array.from({ length: 30 }, (_, n) => n + 1)) {
        scroll.setScroll("session", "review", { x: 0, y: i })
      }

      vi.advanceTimersByTime(9)
      expect(writes).toHaveLength(0)

      vi.advanceTimersByTime(1)

      expect(writes).toHaveLength(1)
      expect(writes[0]?.review).toEqual({ x: 0, y: 30 })

      scroll.setScroll("session", "review", { x: 0, y: 30 })
      vi.advanceTimersByTime(20)

      expect(writes).toHaveLength(1)
      scroll.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test("reseeds empty cache after persisted snapshot loads", () => {
    const snapshot = {
      session: {},
    } as Record<string, Record<string, { x: number; y: number }>>

    const scroll = createScrollPersistence({
      getSnapshot: (sessionKey) => snapshot[sessionKey],
      onFlush: () => {},
    })

    expect(scroll.scroll("session", "review")).toBeUndefined()

    snapshot.session = {
      review: { x: 12, y: 34 },
    }

    expect(scroll.scroll("session", "review")).toEqual({ x: 12, y: 34 })
    scroll.dispose()
  })

  test("persists semantic scroll anchors", () => {
    vi.useFakeTimers()
    try {
      let snapshot: Record<string, { x: number; y: number; anchor?: { id: string; key?: string; offset: number } }> = {}
      const scroll = createScrollPersistence({
        debounceMs: 10,
        getSnapshot: () => snapshot,
        onFlush: (_sessionKey, next) => {
          snapshot = next
        },
      })

      scroll.setScroll("session", "timeline", {
        x: 1_000,
        y: 400,
        anchor: { id: "message-1", key: "assistant-part:message-1:part-2", offset: 24 },
      })
      vi.advanceTimersByTime(10)

      expect(snapshot.timeline).toEqual({
        x: 1_000,
        y: 400,
        anchor: { id: "message-1", key: "assistant-part:message-1:part-2", offset: 24 },
      })
      scroll.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
