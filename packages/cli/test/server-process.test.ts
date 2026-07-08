import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("concurrent service candidates elect one owner before serving", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-election-"))
  const env = {
    ...process.env,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  }
  const entry = path.join(import.meta.dir, "../src/index.ts")
  const candidates = [
    spawn(process.execPath, [entry, "serve", "--service"], { cwd: path.join(import.meta.dir, ".."), env }),
    spawn(process.execPath, [entry, "serve", "--service"], { cwd: path.join(import.meta.dir, ".."), env }),
  ]

  try {
    const registration = path.join(root, "state", "opencode", "service-local.json")
    await waitForFile(registration)
    const info = await Bun.file(registration).json()
    await waitFor(() => candidates.some((candidate) => candidate.exitCode !== null))

    expect(candidates.filter((candidate) => candidate.exitCode === null)).toHaveLength(1)
    expect(candidates.find((candidate) => candidate.exitCode !== null)?.exitCode).toBe(0)
    expect(candidates.find((candidate) => candidate.exitCode === null)?.pid).toBe(info.pid)
    expect(
      await fetch(new URL("/api/health", info.url), {
        headers: { authorization: "Basic " + btoa(`opencode:${info.password}`) },
      }).then((response) => response.ok),
    ).toBe(true)
  } finally {
    await Promise.all(candidates.map(stop))
    await fs.rm(root, { recursive: true, force: true })
  }
}, 20_000)

async function waitForFile(file: string) {
  await waitFor(() => Bun.file(file).exists())
}

async function waitFor(check: () => boolean | Promise<boolean>) {
  const timeout = Date.now() + 10_000
  while (Date.now() < timeout) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error("Timed out waiting for service election")
}

async function stop(process: ReturnType<typeof spawn>) {
  if (process.exitCode !== null || process.signalCode !== null) return
  const closed = new Promise<void>((resolve) => process.once("close", () => resolve()))
  process.kill("SIGTERM")
  await closed
}
