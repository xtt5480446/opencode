import { mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")
const script = resolve(import.meta.dir, "shortcut-screenshots.drive.ts")
const output = resolve(process.env.OPENCODE_SHORTCUT_SCREENSHOTS_DIR ?? resolve(root, "tmp/tui-shortcut-screenshots"))
const drive = Bun.which("opencode-drive")

if (!drive) throw new Error("opencode-drive is required: https://github.com/jlongster/opencode-drive")

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })

const check = Bun.spawn([drive, "check", script], {
  cwd: root,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
if ((await check.exited) !== 0) throw new Error("OpenCode Drive script typecheck failed")

const run = Bun.spawn([drive, "start", "--name", `tui-shortcuts-${process.pid}`, "--dev", root, "--script", script], {
  cwd: root,
  env: { ...process.env, OPENCODE_DRIVE_MEDIA_DIR: output },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
if ((await run.exited) !== 0) throw new Error("OpenCode Drive screenshot run failed")

console.log(`Shortcut screenshots: ${output}`)
