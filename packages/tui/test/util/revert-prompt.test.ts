import { describe, expect, test } from "bun:test"
import type { SessionMessageUser } from "@opencode-ai/sdk/v2"
import { revertedPrompt } from "../../src/util/revert-prompt"

const message: SessionMessageUser = {
  id: "message-1",
  type: "user",
  text: "Fix the tests",
  time: { created: 1 },
  files: [
    {
      uri: "file:///repo/test.ts",
      mime: "text/typescript",
      name: "test.ts",
      source: { start: 0, end: 8, text: "@test.ts" },
    },
  ],
  agents: [{ name: "review", source: { start: 9, end: 16, text: "@review" } }],
}

describe("reverted prompt", () => {
  test("restores the reverted user message into an empty prompt", () => {
    expect(revertedPrompt({ input: "", parts: [] }, message)).toEqual({
      input: "Fix the tests",
      parts: [
        {
          type: "file",
          mime: "text/typescript",
          filename: "test.ts",
          url: "file:///repo/test.ts",
          source: {
            type: "file",
            path: "test.ts",
            text: { start: 0, end: 8, value: "@test.ts" },
          },
        },
        {
          type: "agent",
          name: "review",
          source: { start: 9, end: 16, value: "@review" },
        },
      ],
    })
  })

  test("preserves an existing text draft", () => {
    expect(revertedPrompt({ input: "Keep this", parts: [] }, message)).toBeUndefined()
  })

  test("preserves an existing attachment draft", () => {
    expect(
      revertedPrompt(
        {
          input: "",
          parts: [{ type: "agent", name: "build" }],
        },
        message,
      ),
    ).toBeUndefined()
  })
})
