import { describe, expect, test } from "bun:test"
import path from "path"
import { ConfigProvider, Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { tmpdir } from "./fixture/tmpdir"

describe("Database placement", () => {
  test("resolves explicit files, relative names, and the channel default", () => {
    expect(Database.resolvePath({ file: ":memory:", disableChannelDb: false })).toBe(":memory:")
    expect(Database.resolvePath({ file: "/tmp/explicit.db", disableChannelDb: false })).toBe("/tmp/explicit.db")
    expect(Database.resolvePath({ file: "relative.db", disableChannelDb: false })).toBe(
      path.join(Global.Path.data, "relative.db"),
    )
    expect(Database.resolvePath({ file: undefined, disableChannelDb: true })).toBe(
      path.join(Global.Path.data, "opencode.db"),
    )
  })

  test("reads placement from the active ConfigProvider when the layer is built", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "config-seam.sqlite")

    // The preload sets OPENCODE_DB=":memory:" in the process environment, so a
    // database appearing at this path proves the layer reads through the
    // replaced ConfigProvider rather than the environment snapshot.
    await Effect.runPromise(
      Layer.build(
        LayerNode.compile(LayerNode.group([Database.node])).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_DB: file }))),
        ),
      ).pipe(Effect.scoped, Effect.asVoid),
    )

    expect(await Bun.file(file).exists()).toBe(true)
  })
})
