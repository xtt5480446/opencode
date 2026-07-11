import { expect, test } from "bun:test"
import path from "node:path"

test("zsh completion does not define the first positional twice", async () => {
  const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/index.ts"), "--completions", "zsh"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(proc.stdout).text()
  const error = await new Response(proc.stderr).text()

  expect(await proc.exited, error).toBe(0)
  expect(output).toContain("'1:command:->command'")
  expect(output).not.toContain("':Directory to start OpenCode in:'")
})
