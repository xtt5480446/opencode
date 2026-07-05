import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode-ai/core/global"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"

test("only replaces older semantic versions", () => {
  expect(ServiceConfig.canReplaceVersion("1.0.0", "2.0.0")).toBe(true)
  expect(ServiceConfig.canReplaceVersion("2.0.0", "1.0.0")).toBe(false)
  expect(ServiceConfig.canReplaceVersion("1.0.0", "1.0.0")).toBe(false)
  expect(ServiceConfig.canReplaceVersion("0.0.0-next-9999", "0.0.0-next-15000")).toBe(true)
  expect(ServiceConfig.canReplaceVersion("0.0.0-next-15000", "0.0.0-next-9999")).toBe(false)
  expect(ServiceConfig.canReplaceVersion("0.0.0-next-15000.1", "0.0.0-next-15000.2")).toBe(true)
  expect(ServiceConfig.canReplaceVersion("0.0.0-next-15000.10", "0.0.0-next-15000.9")).toBe(false)
  expect(ServiceConfig.canReplaceVersion("0.0.0-next-15000.10", "0.0.0-next-15000.10")).toBe(false)
  expect(ServiceConfig.canReplaceVersion(undefined, "1.0.0")).toBe(true)
})

test("local channel stores service config with the local service filename", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-"))
  try {
    await Effect.runPromise(
      ServiceConfig.set("hostname", "127.0.0.2").pipe(
        Effect.provide(Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })),
        Effect.provide(NodeFileSystem.layer),
      ),
    )
    expect(await Bun.file(path.join(root, "config", "service-local.json")).json()).toEqual({
      hostname: "127.0.0.2",
    })
    expect(await Bun.file(path.join(root, "config", "service.json")).exists()).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
