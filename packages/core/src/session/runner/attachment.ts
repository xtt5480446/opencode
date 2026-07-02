export * as SessionRunnerAttachment from "./attachment"

import { fileURLToPath } from "url"
import { Effect } from "effect"
import { Image } from "../../image"
import { AbsolutePath } from "../../schema"
import { ReadToolFileSystem } from "../../tool/read-filesystem"
import { SessionMessage } from "../message"
import type { FileAttachment } from "../prompt"

export interface Services {
  readonly reader: ReadToolFileSystem.Interface
  readonly image: Image.Interface
}

/**
 * One drain's attachment materialization results, keyed by message ID and URI.
 * Reusing it across the drain's turns avoids re-reading attachments from disk
 * and pins their content for the drain, so mid-drain file edits neither rewrite
 * history the model already saw nor invalidate the provider prompt-cache prefix.
 */
export type Cache = Map<string, Materialized>

interface Materialized {
  readonly file?: FileAttachment
  readonly expansion?: string
}

/**
 * Materialize local `file:` attachments during per-turn request assembly.
 *
 * Providers accept media content only for a narrow set of mimes, so lowering an
 * unresolved `file:` URI (or an `application/x-directory` attachment) as a media
 * part fails the provider turn. Directories become an inline listing, text files
 * become inline content, and images are re-encoded as normalized data URLs.
 * Other URI schemes (data URLs, MCP resources) pass through unchanged, and
 * unreadable attachments degrade to a model-visible note instead of failing the
 * turn. The durable projected message is never modified.
 */
export const materialize = Effect.fn("SessionRunnerAttachment.materialize")(function* (
  services: Services,
  cache: Cache,
  messages: readonly SessionMessage.Message[],
) {
  if (!messages.some((message) => message.type === "user" && message.files?.some(local))) return messages
  return yield* Effect.forEach(messages, (message) => {
    if (message.type !== "user" || !message.files?.some(local)) return Effect.succeed(message)
    return Effect.forEach(message.files, (file) => {
      const key = `${message.id}:${file.uri}`
      const hit = cache.get(key)
      if (hit) return Effect.succeed(hit)
      return materializeFile(services, file).pipe(Effect.tap((result) => Effect.sync(() => cache.set(key, result))))
    }).pipe(
      Effect.map(
        (results): SessionMessage.User => ({
          ...message,
          text: [
            message.text,
            ...results.flatMap((result) => (result.expansion === undefined ? [] : [result.expansion])),
          ]
            .filter(Boolean)
            .join("\n\n"),
          files: results.flatMap((result) => (result.file === undefined ? [] : [result.file])),
        }),
      ),
    )
  })
})

const local = (file: FileAttachment) => file.uri.startsWith("file:")

const wrap = (tag: string, path: string, body: string) => `<${tag} path=${JSON.stringify(path)}>\n${body}\n</${tag}>`

// Mirror V1's `?start`/`?end` line-range attachment parameters.
const pageFromRange = (url: URL) => {
  const start = parseInt(url.searchParams.get("start") ?? "", 10)
  if (!Number.isInteger(start) || start < 1) return undefined
  const end = parseInt(url.searchParams.get("end") ?? "", 10)
  return { offset: start, ...(end >= start ? { limit: end - start + 1 } : {}) }
}

const materializeFile = (services: Services, file: FileAttachment) => {
  if (!local(file)) return Effect.succeed<Materialized>({ file })
  return Effect.gen(function* () {
    const { target, page } = yield* Effect.try({
      try: () => {
        const url = new URL(file.uri)
        const page = pageFromRange(url)
        url.search = ""
        url.hash = ""
        return { target: AbsolutePath.make(fileURLToPath(url)), page }
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    })
    const display = file.name ?? target
    const kind = yield* services.reader.inspect(target)
    if (kind === "directory") {
      const listing = yield* services.reader.list(target)
      const lines = [
        ...listing.entries.map((entry) => entry.path),
        ...(listing.truncated ? ["(listing truncated)"] : []),
      ]
      return { expansion: wrap("attached-directory", display, lines.join("\n")) } satisfies Materialized
    }
    const content = yield* services.reader.read(target, display, page)
    if (content instanceof ReadToolFileSystem.TextPage) {
      const truncated = content.truncated ? "\n(content truncated)" : ""
      return { expansion: wrap("attached-file", display, content.content + truncated) } satisfies Materialized
    }
    if (content.encoding === "base64") {
      const normalized = yield* services.image
        .normalize(display, { ...content, encoding: "base64" })
        .pipe(Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)))
      return {
        file: { ...file, uri: `data:${normalized.mime};base64,${normalized.content}`, mime: normalized.mime },
      } satisfies Materialized
    }
    return { expansion: wrap("attached-file", display, content.content) } satisfies Materialized
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed<Materialized>({ expansion: wrap("attachment-unavailable", file.name ?? file.uri, error.message) }),
    ),
  )
}
