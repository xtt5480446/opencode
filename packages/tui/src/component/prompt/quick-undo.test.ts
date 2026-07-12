import { describe, expect, test } from "bun:test"
import { createQuickUndo } from "./quick-undo"

describe("quick undo", () => {
  test("returns the submitted message on a second escape within two seconds", () => {
    const undo = createQuickUndo<string>()
    undo.submitted("msg_1", "hello", 1_000)

    expect(undo.escape(1_500)).toBeUndefined()
    expect(undo.escape(1_750)).toEqual({ messageID: "msg_1", value: "hello" })
    expect(undo.escape(1_800)).toBeUndefined()
  })

  test("expires two seconds after submission", () => {
    const undo = createQuickUndo<string>()
    undo.submitted("msg_1", "hello", 1_000)

    expect(undo.escape(2_500)).toBeUndefined()
    expect(undo.escape(3_001)).toBeUndefined()
  })
})
