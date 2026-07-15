import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode-ai/core/global"
import { Effect, Fiber, Option, Stream } from "effect"
import { expect, test } from "bun:test"
import path from "path"
import { Config } from "../src/config"

function run<A, E>(directory: string, effect: Effect.Effect<A, E, Config.Service>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(Config.layer),
      Effect.provide(Global.layerWith({ config: directory, state: directory })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )
}

test("migrates tui and kv config into cli.json", async () => {
  const directory = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  await Bun.write(
    path.join(directory, "tui.json"),
    JSON.stringify({
      theme: "legacy",
      keybinds: { leader: "ctrl+o" },
      plugin: [["example", { mode: "safe" }]],
      plugin_enabled: { disabled: false },
      leader_timeout: 500,
      scroll_speed: 2,
      scroll_acceleration: { enabled: true },
      diff_style: "stacked",
      mouse: false,
    }),
  )
  await Bun.write(
    path.join(directory, "kv.json"),
    JSON.stringify({
      theme_mode_lock: "light",
      attention_sound_pack: "custom.pack",
      diff_wrap_mode: "none",
      diff_viewer_show_file_tree: false,
      diff_viewer_single_patch: true,
      diff_viewer_view: "split",
      terminal_title_enabled: false,
      file_context_enabled: false,
      paste_summary_enabled: false,
      sidebar: "hide",
      scrollbar_visible: true,
      thinking_mode: "show",
      exploration_grouping: false,
      dismissed_getting_started: true,
      animations_enabled: false,
      skipped_version: "9.9.9",
      which_key_layout: "overlay",
    }),
  )

  try {
    const config = await run(
      directory,
      Effect.gen(function* () {
        const service = yield* Config.Service
        return yield* service.get()
      }),
    )

    expect(config).toMatchObject({
      theme: { name: "legacy", mode: "light" },
      keybinds: { leader: "ctrl+o" },
      plugins: [{ package: "example", options: { mode: "safe" } }, "-disabled"],
      leader: { timeout: 500 },
      scroll: { speed: 2, acceleration: true },
      attention: { sound_pack: "custom.pack" },
      diffs: { wrap: "none", tree: false, single: true, view: "split" },
      terminal: { title: false },
      prompt: { editor: false, paste: "full" },
      session: { sidebar: "hide", scrollbar: true, thinking: "show", grouping: "none" },
      hints: { onboarding: false },
      animations: false,
      mouse: false,
    })
    expect(config).not.toHaveProperty("skipped_version")
    expect(config).not.toHaveProperty("which_key")
    expect((await Bun.file(path.join(directory, "cli.json")).json()).keybinds).toEqual({ leader: "ctrl+o" })
    expect(await Bun.file(path.join(directory, "cli.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(directory, "tui.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(directory, "kv.json")).exists()).toBe(true)
  } finally {
    await Bun.$`rm -rf ${directory}`
  }
})

test("migrates before the first update and does not remigrate afterward", async () => {
  const directory = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  await Bun.write(path.join(directory, "tui.json"), JSON.stringify({ theme: "legacy" }))

  try {
    const config = await run(
      directory,
      Effect.gen(function* () {
        const service = yield* Config.Service
        yield* service.update((draft) => {
          draft.animations = false
          draft.mouse = false
        })
        yield* Effect.promise(() => Bun.write(path.join(directory, "tui.json"), JSON.stringify({ theme: "changed" })))
        return yield* service.get()
      }),
    )

    expect(config).toEqual({ theme: { name: "legacy" }, animations: false, mouse: false })
    expect(await Bun.file(path.join(directory, "cli.json")).json()).toEqual({
      theme: { name: "legacy" },
      animations: false,
      mouse: false,
    })
  } finally {
    await Bun.$`rm -rf ${directory}`
  }
})

test("updates a config draft while preserving JSONC comments", async () => {
  const directory = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  await Bun.write(path.join(directory, "cli.json"), '{\n  // Keep this comment\n  "animations": true\n}\n')

  try {
    const config = await run(
      directory,
      Effect.gen(function* () {
        const service = yield* Config.Service
        return yield* service.update((draft) => {
          draft.prompt = { paste: "compact" }
        })
      }),
    )

    expect(config).toEqual({ animations: true, prompt: { paste: "compact" } })
    expect(await Bun.file(path.join(directory, "cli.json")).text()).toContain("// Keep this comment")
  } finally {
    await Bun.$`rm -rf ${directory}`
  }
})

test("migrates model favorites into an existing cli config", async () => {
  const directory = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  await Bun.write(path.join(directory, "cli.json"), '{\n  // Keep this comment\n  "animations": true\n}\n')
  await Bun.write(
    path.join(directory, "model.json"),
    JSON.stringify({
      recent: [{ providerID: "anthropic", modelID: "recent" }],
      favorite: [
        { providerID: "anthropic", modelID: "claude-sonnet" },
        { providerID: "openai", modelID: "gpt/favorite" },
      ],
    }),
  )

  try {
    const config = await run(
      directory,
      Effect.gen(function* () {
        const service = yield* Config.Service
        return yield* service.get()
      }),
    )

    expect(config.models?.favorites).toEqual(["anthropic/claude-sonnet", "openai/gpt/favorite"])
    expect(await Bun.file(path.join(directory, "cli.json")).text()).toContain("// Keep this comment")
    const model = await Bun.file(path.join(directory, "model.json")).json()
    expect(model).toHaveProperty("recent")
    expect(model).not.toHaveProperty("favorite")
  } finally {
    await Bun.$`rm -rf ${directory}`
  }
})

test("emits config changes written by another process", async () => {
  const directory = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  await Bun.write(path.join(directory, "cli.json"), JSON.stringify({ animations: true }))

  try {
    const config = await run(
      directory,
      Effect.gen(function* () {
        const service = yield* Config.Service
        const update = yield* service.changes.pipe(Stream.runHead, Effect.forkChild)
        yield* Effect.sleep("100 millis")
        yield* Effect.promise(() => Bun.write(path.join(directory, "cli.json"), JSON.stringify({ animations: false })))
        return yield* Fiber.join(update).pipe(Effect.timeout("5 seconds"))
      }),
    )

    expect(Option.getOrThrow(config).animations).toBe(false)
  } finally {
    await Bun.$`rm -rf ${directory}`
  }
})

test("serializes updates from separate config services", async () => {
  const directory = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  await Bun.write(path.join(directory, "cli.json"), "{}")

  try {
    await Promise.all([
      run(
        directory,
        Effect.gen(function* () {
          const service = yield* Config.Service
          yield* service.update((draft) => {
            draft.animations = false
          })
        }),
      ),
      run(
        directory,
        Effect.gen(function* () {
          const service = yield* Config.Service
          yield* service.update((draft) => {
            draft.mouse = false
          })
        }),
      ),
    ])

    expect(await Bun.file(path.join(directory, "cli.json")).json()).toEqual({ animations: false, mouse: false })
  } finally {
    await Bun.$`rm -rf ${directory}`
  }
})
