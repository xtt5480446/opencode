import path from "node:path"
import { expect, test } from "bun:test"

test("remote MCP reconnect lifecycle", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      path.join(import.meta.dir, "../fixture/mcp-reconnect-scenario.ts"),
      "--timeout",
      "30000",
    ],
    {
      cwd: path.join(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
  ])

  expect(code, `${stdout}\n${stderr}`).toBe(0)
})
