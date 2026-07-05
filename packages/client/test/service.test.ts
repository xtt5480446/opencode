import { NodeFileSystem } from "@effect/platform-node"
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Service } from "../src/effect/index"

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(async (run) => await run()))
})

test("does not start or stop a healthy service rejected by the version policy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-client-service-"))
  const child = Bun.spawn([process.execPath, "-e", "await new Promise(() => {})"])
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ healthy: true }) })
  const file = path.join(root, "service.json")
  cleanup.push(
    () => child.kill(),
    () => server.stop(true),
    () => fs.rm(root, { recursive: true, force: true }),
  )
  await Bun.write(file, JSON.stringify({ id: "newer", version: "2.0.0", url: server.url.toString(), pid: child.pid }))

  const options = {
    file,
    version: "1.0.0",
    canReplace: () => false,
    command: [process.execPath, "-e", "throw new Error('should not spawn')"],
  }
  const startError = await Service.start(options).pipe(
    Effect.flip,
    Effect.provide(NodeFileSystem.layer),
    Effect.runPromise,
  )
  const stopError = await Service.stop(options).pipe(
    Effect.flip,
    Effect.provide(NodeFileSystem.layer),
    Effect.runPromise,
  )

  expect(startError).toBeInstanceOf(Service.VersionMismatchError)
  expect(startError).toMatchObject({ clientVersion: "1.0.0", serverVersion: "2.0.0" })
  expect(stopError).toBeInstanceOf(Service.VersionMismatchError)
  expect(process.kill(child.pid, 0)).toBe(true)
  expect(await Bun.file(file).exists()).toBe(true)
})
