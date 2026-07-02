import { describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { DateTime, Effect, FileSystem } from "effect"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Image } from "@opencode-ai/core/image"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { FileAttachment } from "@opencode-ai/core/session/prompt"
import { SessionRunnerAttachment } from "@opencode-ai/core/session/runner/attachment"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([ReadToolFileSystem.node, LayerNodePlatform.filesystem])))

const created = DateTime.makeUnsafe(0)
const user = (files: FileAttachment[]) =>
  SessionMessage.User.make({
    id: SessionMessage.ID.make("msg_user"),
    type: "user",
    text: "Look at this",
    files,
    time: { created },
  })

// The resizer-unavailable stub exercises the raw-content fallback deterministically.
const image = Image.Service.of({ normalize: () => Effect.fail(new Image.ResizerUnavailableError()) })

const fixture = Effect.gen(function* () {
  const services = { reader: yield* ReadToolFileSystem.Service, image }
  const files = yield* FileSystem.FileSystem
  const directory = yield* files.makeTempDirectoryScoped()
  return { services, files, directory }
})

const requireUser = (message: SessionMessage.Message) => {
  if (message.type !== "user") throw new Error(`Expected a user message, got ${message.type}`)
  return message
}

describe("SessionRunnerAttachment.materialize", () => {
  it.effect("expands a directory attachment into a listing instead of media", () =>
    Effect.gen(function* () {
      const { services, files, directory } = yield* fixture
      yield* files.makeDirectory(path.join(directory, "src"))
      yield* files.writeFileString(path.join(directory, "package.json"), "{}")
      const attachment = FileAttachment.make({
        uri: pathToFileURL(directory + path.sep).href,
        mime: "application/x-directory",
        name: "project/",
      })

      const result = yield* SessionRunnerAttachment.materialize(services, new Map(), [user([attachment])])

      const message = requireUser(result[0])
      expect(message.files).toEqual([])
      expect(message.text).toContain('<attached-directory path="project/">')
      expect(message.text).toContain("src/")
      expect(message.text).toContain("package.json")
    }),
  )

  it.effect("expands a text file attachment into inline content", () =>
    Effect.gen(function* () {
      const { services, files, directory } = yield* fixture
      const file = path.join(directory, "notes.md")
      yield* files.writeFileString(file, "first line\nsecond line\nthird line\n")
      const attachment = FileAttachment.make({
        uri: pathToFileURL(file).href,
        mime: "text/markdown",
        name: "notes.md",
      })

      const result = yield* SessionRunnerAttachment.materialize(services, new Map(), [user([attachment])])

      const message = requireUser(result[0])
      expect(message.files).toEqual([])
      expect(message.text).toContain('<attached-file path="notes.md">')
      expect(message.text).toContain("second line")
    }),
  )

  it.effect("honors ?start/?end line-range parameters", () =>
    Effect.gen(function* () {
      const { services, files, directory } = yield* fixture
      const file = path.join(directory, "notes.md")
      yield* files.writeFileString(file, "first line\nsecond line\nthird line\nfourth line\n")
      const attachment = FileAttachment.make({
        uri: pathToFileURL(file).href + "?start=2&end=3",
        mime: "text/markdown",
        name: "notes.md#2-3",
      })

      const result = yield* SessionRunnerAttachment.materialize(services, new Map(), [user([attachment])])

      const message = requireUser(result[0])
      expect(message.text).toContain("second line")
      expect(message.text).toContain("third line")
      expect(message.text).not.toContain("first line")
      expect(message.text).not.toContain("fourth line")
    }),
  )

  it.effect("re-encodes an image attachment as a data URL media part", () =>
    Effect.gen(function* () {
      const { services, files, directory } = yield* fixture
      const file = path.join(directory, "pixel.png")
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
      yield* files.writeFile(file, png)
      const attachment = FileAttachment.make({
        uri: pathToFileURL(file).href,
        mime: "image/png",
        name: "pixel.png",
      })

      const result = yield* SessionRunnerAttachment.materialize(services, new Map(), [user([attachment])])

      const message = requireUser(result[0])
      expect(message.text).toBe("Look at this")
      expect(message.files).toHaveLength(1)
      expect(message.files![0].mime).toBe("image/png")
      expect(message.files![0].uri).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`)
    }),
  )

  it.effect("degrades unreadable attachments to a model-visible note instead of failing", () =>
    Effect.gen(function* () {
      const { services, directory } = yield* fixture
      const attachment = FileAttachment.make({
        uri: pathToFileURL(path.join(directory, "missing.txt")).href,
        mime: "text/plain",
        name: "missing.txt",
      })

      const result = yield* SessionRunnerAttachment.materialize(services, new Map(), [user([attachment])])

      const message = requireUser(result[0])
      expect(message.files).toEqual([])
      expect(message.text).toContain('<attachment-unavailable path="missing.txt">')
    }),
  )

  it.effect("reuses cached materialization for the life of a drain", () =>
    Effect.gen(function* () {
      const { services, files, directory } = yield* fixture
      const file = path.join(directory, "notes.md")
      yield* files.writeFileString(file, "original content\n")
      const attachment = FileAttachment.make({
        uri: pathToFileURL(file).href,
        mime: "text/plain",
        name: "notes.md",
      })
      const cache: SessionRunnerAttachment.Cache = new Map()

      const first = yield* SessionRunnerAttachment.materialize(services, cache, [user([attachment])])
      yield* files.writeFileString(file, "changed content\n")
      const second = yield* SessionRunnerAttachment.materialize(services, cache, [user([attachment])])

      expect(requireUser(second[0]).text).toBe(requireUser(first[0]).text)
      expect(requireUser(second[0]).text).toContain("original content")
    }),
  )

  it.effect("passes data URLs and non-user messages through unchanged", () =>
    Effect.gen(function* () {
      const { services } = yield* fixture
      const dataAttachment = FileAttachment.make({
        uri: "data:image/png;base64,aGVsbG8=",
        mime: "image/png",
        name: "hello.png",
      })
      const original = user([dataAttachment])
      const synthetic = SessionMessage.Synthetic.make({
        id: SessionMessage.ID.make("msg_synthetic"),
        type: "synthetic",
        sessionID: SessionV2.ID.make("ses_translate"),
        text: "Synthetic context",
        time: { created },
      })

      const result = yield* SessionRunnerAttachment.materialize(services, new Map(), [original, synthetic])

      expect(result[0]).toBe(original)
      expect(result[1]).toBe(synthetic)
    }),
  )
})
