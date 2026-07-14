import { describe, expect, test } from "bun:test"
import { resolveServerStatus } from "./server-status-icon"

describe("resolveServerStatus", () => {
  test("prioritizes a disconnected server over stream reconnection", () => {
    expect(resolveServerStatus(false, "reconnecting")).toBe("disconnected")
  })

  test("shows reconnection while the server remains reachable", () => {
    expect(resolveServerStatus(true, "reconnecting")).toBe("reconnecting")
  })

  test("stays hidden for healthy and initial connections", () => {
    expect(resolveServerStatus(true, "connected")).toBeUndefined()
    expect(resolveServerStatus(undefined, "connecting")).toBeUndefined()
  })
})
