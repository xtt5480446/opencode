import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("opencode adaptive runtime subprocess", () => {
  cliIt.concurrent("offline doctor reports foundation checks without a legacy session", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["adaptive", "doctor", "--offline", "--json"])
      opencode.expectExit(result, 0)
      const body = JSON.parse(result.stdout)
      expect(body.database).toBe("ok")
      expect(body.process).toBe("ok")
      expect(body.audit).toBe("ok")
    }),
  )

  cliIt.concurrent("adaptive run emits one durable task id in JSON mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.run("inspect", { runtime: "adaptive", format: "json" })
      opencode.expectExit(result, 0)
      const events = opencode.parseJsonEvents(result.stdout)
      expect(events[0]).toMatchObject({ type: "adaptive.task.created", status: "planning" })
      const taskID = events[0]?.taskID
      expect(typeof taskID).toBe("string")
      expect(events.every((event) => event.taskID === taskID)).toBe(true)
    }),
  )
})
