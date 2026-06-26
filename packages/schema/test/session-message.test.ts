import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "../src/session-message"

test("does not model interruption as a provider finish reason", () => {
  expect(() => Schema.decodeUnknownSync(SessionMessage.Finish)("interrupted")).toThrow()
  expect(Schema.decodeUnknownSync(SessionMessage.Finish)("error")).toBe("error")
})

test("decodes projected assistant histories with arbitrary finish strings", () => {
  const message = Schema.decodeUnknownSync(SessionMessage.Message)({
    id: "msg_legacy",
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content: [],
    finish: "legacy-provider-reason",
    time: { created: 0, completed: 1 },
  })

  expect(message).toMatchObject({ type: "assistant", finish: "legacy-provider-reason" })
})
