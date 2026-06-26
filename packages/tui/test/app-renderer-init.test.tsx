import { expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

test("run preserves the original renderer initialization error message", async () => {
  const message = 'Failed to open library "opentui.dll": error code 126'
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({
    ...core,
    createCliRenderer: async () => {
      throw new Error(message)
    },
  }))

  try {
    const { run } = await import("../src/app")

    await expect(
      Effect.runPromise(
        run({
          url: "http://test",
          config: createTuiResolvedConfig({ plugin_enabled: {} }),
          args: {},
          pluginHost: {
            async start() {},
            async dispose() {},
          },
        }).pipe(Effect.provide(Global.defaultLayer)),
      ),
    ).rejects.toThrow(message)
  } finally {
    mock.restore()
  }
})
