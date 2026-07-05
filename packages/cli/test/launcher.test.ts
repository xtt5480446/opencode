import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const launcher = path.join(import.meta.dir, "../bin/opencode2.cjs")
const fixture = path.join(import.meta.dir, "fixture/restart-child.ts")

test("restarts the installed binary once with the original arguments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-launcher-"))
  const state = path.join(root, "count")

  try {
    const child = Bun.spawn([process.execPath, launcher, fixture, state, "0"], {
      env: { ...process.env, OPENCODE_BIN_PATH: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await child.exited).toBe(0)
    expect(await Bun.file(state).text()).toBe("2")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("bounds automatic restarts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-launcher-"))
  const state = path.join(root, "count")

  try {
    const child = Bun.spawn([process.execPath, launcher, fixture, state, "75"], {
      env: { ...process.env, OPENCODE_BIN_PATH: process.execPath },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await child.exited).toBe(75)
    expect(await Bun.file(state).text()).toBe("2")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
