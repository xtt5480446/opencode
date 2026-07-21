import { expect, test } from "bun:test"
import { count } from "drizzle-orm"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { AdaptiveBlobStore } from "@opencode-ai/core/adaptive/blob-store"
import { AdaptiveBlobTable } from "@opencode-ai/core/adaptive/sql"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../fixture/tmpdir"

test("AdaptiveBlobStore deduplicates bytes and quarantines corrupt content", async () => {
  await using tmp = await tmpdir()
  const layer = AppNodeBuilder.build(LayerNode.group([AdaptiveBlobStore.node, Database.node]), [
    [Database.node, Database.layerFromPath(path.join(tmp.path, "blob.sqlite"))],
    [Global.node, Global.layerWith({ data: tmp.path })],
  ])
  const bytes = new TextEncoder().encode("bounded tool output")

  await Effect.runPromise(
    Effect.gen(function* () {
      const blobs = yield* AdaptiveBlobStore.Service
      const first = yield* blobs.put({ bytes, mediaType: "text/plain" })
      const second = yield* blobs.put({ bytes, mediaType: "text/plain" })
      const { db } = yield* Database.Service
      const absolute = path.join(tmp.path, first.relativePath)

      expect(second).toEqual(first)
      expect(yield* blobs.read(first.hash)).toEqual(bytes)
      expect(yield* db.select({ count: count() }).from(AdaptiveBlobTable).get()).toEqual({ count: 1 })
      expect(yield* Effect.promise(() => fs.readdir(path.dirname(absolute)))).toEqual([path.basename(absolute)])

      yield* Effect.promise(() => fs.writeFile(absolute, "corrupt"))
      const failure = yield* blobs.read(first.hash).pipe(Effect.flip)
      expect(failure._tag).toBe("AdaptiveBlobStore.BlobCorrupt")
      expect(yield* Effect.promise(() => fs.readdir(path.dirname(absolute)))).toEqual([
        expect.stringMatching(new RegExp(`^${path.basename(absolute)}\\.corrupt-`)),
      ])
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
})
