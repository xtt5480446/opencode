import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionMessage } from "../src/session-message.js"

describe("session message", () => {
  test("decodes completed compactions recorded before model attribution", () => {
    const encoded = {
      type: "compaction" as const,
      id: "msg_compaction",
      time: { created: 0 },
      status: "completed" as const,
      reason: "manual" as const,
      summary: "summary",
      recent: "",
    }
    const message = Schema.decodeUnknownSync(SessionMessage.CompactionCompleted)(encoded)

    expect(message.model).toBeUndefined()
    expect(Schema.encodeSync(SessionMessage.CompactionCompleted)(message)).toEqual(encoded)
  })
})
