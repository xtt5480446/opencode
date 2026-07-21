export * as AdaptiveBlobStore from "./blob-store"

import { eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema, Semaphore } from "effect"
import fs from "fs/promises"
import path from "path"
import { AdaptiveOperation } from "@opencode-ai/schema/adaptive-operation"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { Global } from "../global"
import { Hash } from "../util/hash"
import { AdaptiveBlobTable } from "./sql"

export interface PutInput {
  readonly bytes: Uint8Array
  readonly mediaType: string
}

export interface BlobRecord {
  readonly hash: AdaptiveOperation.Hash
  readonly mediaType: string
  readonly byteCount: number
  readonly relativePath: string
  readonly timeCreated: number
  readonly timeLastAccessed: number
}

export class InvalidBlobError extends Schema.TaggedErrorClass<InvalidBlobError>()("AdaptiveBlobStore.InvalidBlob", {
  reason: Schema.String,
}) {}

export class BlobNotFoundError extends Schema.TaggedErrorClass<BlobNotFoundError>()(
  "AdaptiveBlobStore.BlobNotFound",
  { hash: AdaptiveOperation.Hash },
) {}

export class BlobCorruptError extends Schema.TaggedErrorClass<BlobCorruptError>()("AdaptiveBlobStore.BlobCorrupt", {
  hash: AdaptiveOperation.Hash,
  reason: Schema.String,
}) {}

export class BlobIOError extends Schema.TaggedErrorClass<BlobIOError>()("AdaptiveBlobStore.BlobIO", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export interface Interface {
  readonly put: (input: PutInput) => Effect.Effect<BlobRecord, InvalidBlobError | BlobCorruptError | BlobIOError>
  readonly read: (
    hash: AdaptiveOperation.Hash,
  ) => Effect.Effect<Uint8Array, BlobNotFoundError | BlobCorruptError | BlobIOError>
  readonly getMetadata: (hash: AdaptiveOperation.Hash) => Effect.Effect<BlobRecord, BlobNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/AdaptiveBlobStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const global = yield* Global.Service
    const lock = Semaphore.makeUnsafe(1)

    const getMetadata = Effect.fn("AdaptiveBlobStore.getMetadata")(function* (hash: AdaptiveOperation.Hash) {
      const row = yield* db
        .select()
        .from(AdaptiveBlobTable)
        .where(eq(AdaptiveBlobTable.hash, hash))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new BlobNotFoundError({ hash })
      return blobRecord(row)
    })

    const read = Effect.fn("AdaptiveBlobStore.read")(function* (hash: AdaptiveOperation.Hash) {
      const record = yield* getMetadata(hash)
      const absolute = path.join(global.data, record.relativePath)
      const bytes = yield* io("read", () => fs.readFile(absolute)).pipe(
        Effect.catchTag("AdaptiveBlobStore.BlobIO", (error) =>
          corrupt(hash, absolute, `Blob file is unavailable: ${String(error.cause)}`),
        ),
      )
      if (bytes.byteLength !== record.byteCount || digest(bytes) !== hash)
        return yield* corrupt(hash, absolute, "Stored bytes do not match their content address")
      const now = yield* Clock.currentTimeMillis
      yield* db
        .update(AdaptiveBlobTable)
        .set({ time_last_accessed: now })
        .where(eq(AdaptiveBlobTable.hash, hash))
        .run()
        .pipe(Effect.orDie)
      return new Uint8Array(bytes)
    })

    const put = Effect.fn("AdaptiveBlobStore.put")(function* (input: PutInput) {
      if (input.mediaType.trim().length === 0)
        return yield* new InvalidBlobError({ reason: "Blob media type must not be empty" })
      const bytes = new Uint8Array(input.bytes)
      const hash = digest(bytes)
      return yield* lock.withPermit(
        Effect.gen(function* () {
          const existing = yield* db
            .select()
            .from(AdaptiveBlobTable)
            .where(eq(AdaptiveBlobTable.hash, hash))
            .get()
            .pipe(Effect.orDie)
          if (existing) {
            yield* read(hash).pipe(Effect.catchTag("AdaptiveBlobStore.BlobNotFound", Effect.die))
            return blobRecord(existing)
          }

          const hex = hash.slice("sha256:".length)
          const relativePath = `adaptive/blobs/sha256/${hex.slice(0, 2)}/${hex}`
          const absolute = path.join(global.data, relativePath)
          yield* io("mkdir", () => fs.mkdir(path.dirname(absolute), { recursive: true }))

          const orphan = yield* io("stat", () => fs.stat(absolute)).pipe(
            Effect.map((stat) => stat.isFile()),
            Effect.catchTag("AdaptiveBlobStore.BlobIO", () => Effect.succeed(false)),
          )
          if (orphan) {
            const stored = yield* io("read", () => fs.readFile(absolute))
            if (stored.byteLength !== bytes.byteLength || digest(stored) !== hash)
              return yield* corrupt(hash, absolute, "Orphaned blob does not match its content address")
          } else {
            const temporary = path.join(path.dirname(absolute), `.${hex}.tmp-${process.pid}-${Date.now()}`)
            yield* io("write", async () => {
              const handle = await fs.open(temporary, "wx", 0o600)
              try {
                await handle.writeFile(bytes)
                await handle.sync()
              } finally {
                await handle.close()
              }
              await fs.rename(temporary, absolute)
              const directory = await fs.open(path.dirname(absolute), "r")
              try {
                await directory.sync()
              } finally {
                await directory.close()
              }
            }).pipe(
              Effect.ensuring(
                io("cleanup", () => fs.rm(temporary, { force: true })).pipe(Effect.catch(() => Effect.void)),
              ),
            )
          }

          const now = yield* Clock.currentTimeMillis
          const row = yield* db
            .insert(AdaptiveBlobTable)
            .values({
              hash,
              media_type: input.mediaType,
              byte_count: bytes.byteLength,
              relative_path: relativePath,
              time_created: now,
              time_last_accessed: now,
            })
            .onConflictDoNothing()
            .returning()
            .get()
            .pipe(Effect.orDie)
          if (row) return blobRecord(row)
          return yield* getMetadata(hash).pipe(Effect.orDie)
        }),
      )
    })

    const corrupt = (hash: AdaptiveOperation.Hash, absolute: string, reason: string) =>
      Effect.gen(function* () {
        yield* io("quarantine", () => fs.rename(absolute, `${absolute}.corrupt-${Date.now()}`)).pipe(
          Effect.catch(() => Effect.void),
        )
        return yield* new BlobCorruptError({ hash, reason })
      })

    return Service.of({ put, read, getMetadata })
  }),
)

const io = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new BlobIOError({ operation, cause }) })

const digest = (bytes: Uint8Array) => AdaptiveOperation.Hash.make(`sha256:${Hash.sha256(Buffer.from(bytes))}`)

function blobRecord(row: typeof AdaptiveBlobTable.$inferSelect): BlobRecord {
  return {
    hash: row.hash,
    mediaType: row.media_type,
    byteCount: row.byte_count,
    relativePath: row.relative_path,
    timeCreated: row.time_created,
    timeLastAccessed: row.time_last_accessed,
  }
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Global.node] })
