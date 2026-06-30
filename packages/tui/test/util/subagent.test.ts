import { describe, expect, test } from "bun:test"
import { foregroundSubagentCount, subagentDisplayState } from "../../src/util/subagent"

describe("foregroundSubagentCount", () => {
  test("counts running subagent timeline rows before child session output is available", () => {
    expect(
      foregroundSubagentCount({
        sessionID: "parent",
        sessions: [],
        messages: [
          {
            type: "assistant",
            content: [
              { type: "tool", name: "subagent", state: { status: "running", structured: {} } },
              { type: "tool", name: "task", state: { status: "running", structured: {} } },
            ],
          },
        ],
        status: () => "idle",
      }),
    ).toBe(2)
  })

  test("does not double-count running rows that match known child sessions", () => {
    expect(
      foregroundSubagentCount({
        sessionID: "parent",
        sessions: [{ id: "child-1", parentID: "parent", title: "Audit slow path" }],
        messages: [
          {
            type: "assistant",
            content: [
              {
                type: "tool",
                name: "subagent",
                state: { status: "running", input: { description: "Audit slow path" }, structured: {} },
              },
            ],
          },
        ],
        status: () => "running",
      }),
    ).toBe(1)
  })

  test("counts mixed timeline-only and session-only foreground subagents", () => {
    expect(
      foregroundSubagentCount({
        sessionID: "parent",
        sessions: [{ id: "child-1", parentID: "parent", title: "Known child" }],
        messages: [
          {
            type: "assistant",
            content: [
              {
                type: "tool",
                name: "subagent",
                state: { status: "running", input: { description: "New child" }, structured: {} },
              },
            ],
          },
        ],
        status: () => "running",
      }),
    ).toBe(2)
  })

  test("does not undercount duplicate descriptions when only one child session is synced", () => {
    expect(
      foregroundSubagentCount({
        sessionID: "parent",
        sessions: [{ id: "child-1", parentID: "parent", title: "Same task" }],
        messages: [
          {
            type: "assistant",
            content: [
              {
                type: "tool",
                name: "subagent",
                state: { status: "running", input: { description: "Same task" }, structured: {} },
              },
              {
                type: "tool",
                name: "subagent",
                state: { status: "running", input: { description: "Same task" }, structured: {} },
              },
            ],
          },
        ],
        status: () => "running",
      }),
    ).toBe(2)
  })

  test("counts running child sessions", () => {
    expect(
      foregroundSubagentCount({
        sessionID: "parent",
        sessions: [
          { id: "child-1", parentID: "parent" },
          { id: "child-2", parentID: "parent" },
          { id: "child-3", parentID: "other" },
        ],
        messages: [],
        status: (sessionID) => (sessionID === "child-1" || sessionID === "child-3" ? "running" : "idle"),
      }),
    ).toBe(1)
  })

  test("excludes running subagents already marked as backgrounded in the timeline", () => {
    expect(
      foregroundSubagentCount({
        sessionID: "parent",
        sessions: [
          { id: "child-1", parentID: "parent" },
          { id: "child-2", parentID: "parent" },
        ],
        messages: [
          {
            type: "assistant",
            content: [
              {
                type: "tool",
                name: "subagent",
                state: {
                  status: "completed",
                  structured: { sessionID: "child-1", background: true },
                },
              },
              {
                type: "tool",
                name: "task",
                state: {
                  status: "completed",
                  structured: { sessionId: "child-2", background: false },
                },
              },
            ],
          },
        ],
        status: () => "running",
      }),
    ).toBe(1)
  })
})

describe("subagentDisplayState", () => {
  test("keeps a backgrounded subagent spinning while the child session is running", () => {
    expect(
      subagentDisplayState({
        toolStatus: "completed",
        metadata: { sessionID: "child", status: "running", background: true },
        sessionStatus: () => "running",
      }),
    ).toEqual({ background: true, running: true, icon: "│" })
  })

  test("shows a checkmark once a backgrounded child session is no longer running", () => {
    expect(
      subagentDisplayState({
        toolStatus: "completed",
        metadata: { sessionID: "child", status: "running", background: true },
        sessionStatus: () => "idle",
      }),
    ).toEqual({ background: true, running: false, icon: "✓" })
  })

  test("does not spin forever from stale background metadata without a child session ID", () => {
    expect(
      subagentDisplayState({
        toolStatus: "completed",
        metadata: { status: "running", background: true },
        sessionStatus: () => "idle",
      }),
    ).toEqual({ background: true, running: false, icon: "✓" })
  })

  test("does not show a checkmark for errored subagent rows", () => {
    expect(
      subagentDisplayState({
        toolStatus: "error",
        metadata: { background: true },
        sessionStatus: () => "idle",
      }),
    ).toEqual({ background: true, running: false, icon: "│" })
  })
})
