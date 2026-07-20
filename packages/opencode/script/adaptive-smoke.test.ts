import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runAdaptiveSmoke, validateAdaptiveDoctor } from "./adaptive-smoke"

test("accepts a complete offline Adaptive doctor result", () => {
  expect(
    validateAdaptiveDoctor(
      JSON.stringify({
        mode: "offline",
        database: "ok",
        process: "ok",
        workspace: "ok",
        audit: "ok",
        protocol: 1,
      }),
    ),
  ).toEqual({
    mode: "offline",
    database: "ok",
    process: "ok",
    workspace: "ok",
    audit: "ok",
    protocol: 1,
  })
})

test("rejects every incomplete or unsuccessful offline doctor field", () => {
  const valid = {
    mode: "offline",
    database: "ok",
    process: "ok",
    workspace: "ok",
    audit: "ok",
    protocol: 1,
  }
  const cases = [
    ["mode", "live"],
    ["database", "failed"],
    ["process", undefined],
    ["workspace", "failed"],
    ["audit", "failed"],
    ["protocol", 2],
  ] as const

  for (const [key, value] of cases) {
    expect(() => validateAdaptiveDoctor(JSON.stringify({ ...valid, [key]: value }))).toThrow(
      `adaptive doctor failed: ${key}=${String(value)}`,
    )
  }
})

test("reports malformed doctor output without hiding the captured stdout", () => {
  expect(() => validateAdaptiveDoctor("not-json")).toThrow('adaptive doctor returned invalid JSON: stdout="not-json"')
})

test("rejects valid JSON that is not a doctor object", () => {
  expect(() => validateAdaptiveDoctor("null")).toThrow("adaptive doctor returned a non-object JSON value")
})

test("reports a packaged doctor nonzero exit with its stderr", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adaptive-smoke-test-"))
  const fixture = path.join(root, "failure.ts")
  await Bun.write(fixture, 'process.stderr.write("fixture failed\\n")\nprocess.exit(23)\n')

  try {
    await expect(runAdaptiveSmoke([process.execPath, fixture], { temporaryDirectory: root })).rejects.toThrow(
      "adaptive doctor exited with code 23: fixture failed",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("runs the packaged doctor in an isolated disposable environment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adaptive-smoke-test-"))
  const temporaryDirectory = path.join(root, "runs")
  const fixture = path.join(root, "success.ts")
  await mkdir(temporaryDirectory)
  await Bun.write(
    fixture,
    `
const path = await import("node:path")
const expectedArgs = ["adaptive", "doctor", "--offline", "--json"]
const home = process.env.HOME
const valid =
  JSON.stringify(process.argv.slice(2)) === JSON.stringify(expectedArgs) &&
  home !== undefined &&
  process.cwd() !== home &&
  process.env.XDG_CONFIG_HOME === path.join(home, ".config") &&
  process.env.XDG_DATA_HOME === path.join(home, ".local/share") &&
  process.env.XDG_STATE_HOME === path.join(home, ".local/state") &&
  process.env.XDG_CACHE_HOME === path.join(home, ".cache") &&
  process.env.OPENCODE_DB === path.join(home, "opencode-smoke.db") &&
  process.env.OPENCODE_PURE === "1" &&
  process.env.OPENCODE_DISABLE_AUTOUPDATE === "1" &&
  process.env.OPENCODE_DISABLE_AUTOCOMPACT === "1" &&
  process.env.OPENCODE_DISABLE_MODELS_FETCH === "1" &&
  process.env.OPENCODE_DISABLE_PROJECT_CONFIG === "1" &&
  process.env.OPENCODE_AUTH_CONTENT === "{}" &&
  process.env.ADAPTIVE_SMOKE_TEST_SECRET === undefined
if (!valid) {
  process.stderr.write("smoke environment was not isolated\\n")
  process.exit(41)
}
console.log(JSON.stringify({ mode: "offline", database: "ok", process: "ok", workspace: "ok", audit: "ok", protocol: 1 }))
`,
  )
  const secret = process.env.ADAPTIVE_SMOKE_TEST_SECRET
  process.env.ADAPTIVE_SMOKE_TEST_SECRET = "must-not-leak"

  try {
    await expect(runAdaptiveSmoke([process.execPath, fixture], { temporaryDirectory })).resolves.toMatchObject({
      mode: "offline",
      protocol: 1,
    })
    expect(await readdir(temporaryDirectory)).toEqual([])
  } finally {
    if (secret === undefined) delete process.env.ADAPTIVE_SMOKE_TEST_SECRET
    else process.env.ADAPTIVE_SMOKE_TEST_SECRET = secret
    await rm(root, { recursive: true, force: true })
  }
})

test("terminates a packaged doctor that exceeds its bounded runtime", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adaptive-smoke-test-"))
  const temporaryDirectory = path.join(root, "runs")
  const fixture = path.join(root, "slow.ts")
  await mkdir(temporaryDirectory)
  await Bun.write(
    fixture,
    `
await Bun.sleep(250)
console.log(JSON.stringify({ mode: "offline", database: "ok", process: "ok", workspace: "ok", audit: "ok", protocol: 1 }))
`,
  )

  try {
    await expect(runAdaptiveSmoke([process.execPath, fixture], { temporaryDirectory, timeoutMs: 20 })).rejects.toThrow(
      "adaptive doctor timed out after 20ms",
    )
    expect(await readdir(temporaryDirectory)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("terminates detached descendants when the packaged doctor times out", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adaptive-smoke-test-"))
  const temporaryDirectory = path.join(root, "runs")
  const pidFile = path.join(root, "descendant.pid")
  const fixture = path.join(root, "descendant.ts")
  await mkdir(temporaryDirectory)
  await Bun.write(
    fixture,
    `
const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 10_000)"], {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
})
child.unref()
await Bun.write(process.argv[2], String(child.pid))
await Bun.sleep(250)
`,
  )

  try {
    await expect(
      runAdaptiveSmoke([process.execPath, fixture, pidFile], { temporaryDirectory, timeoutMs: 50 }),
    ).rejects.toThrow("adaptive doctor timed out after 50ms")
    const pid = Number(await Bun.file(pidFile).text())
    expect(await waitForProcessExit(pid)).toBe(true)
  } finally {
    const pid = Number(
      await Bun.file(pidFile)
        .text()
        .catch(() => "0"),
    )
    if (pid > 0 && (await processAlive(pid))) process.kill(pid, "SIGKILL")
    await rm(root, { recursive: true, force: true })
  }
})

test("terminates a packaged doctor when either output stream exceeds its byte limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adaptive-smoke-test-"))
  const temporaryDirectory = path.join(root, "runs")
  const fixture = path.join(root, "output-flood.ts")
  await mkdir(temporaryDirectory)
  await Bun.write(
    fixture,
    `
const stream = process.argv[2] === "stdout" ? process.stdout : process.stderr
stream.write("x".repeat(1_024))
await Bun.sleep(250)
`,
  )

  try {
    for (const stream of ["stdout", "stderr"] as const) {
      await expect(
        runAdaptiveSmoke([process.execPath, fixture, stream], {
          temporaryDirectory,
          timeoutMs: 500,
          maxOutputBytes: 64,
        }),
      ).rejects.toThrow(`adaptive doctor ${stream} exceeded 64 bytes`)
    }
    expect(await readdir(temporaryDirectory)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("requires a packaged binary when invoked as a build script", async () => {
  const script = path.join(import.meta.dir, "adaptive-smoke.ts")
  const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])

  expect(exitCode).not.toBe(0)
  expect(stderr).toContain("usage: bun script/adaptive-smoke.ts <binary>")
})

async function waitForProcessExit(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await processAlive(pid))) return true
    await Bun.sleep(10)
  }
  return false
}

async function processAlive(pid: number) {
  if (process.platform === "linux") {
    const stat = Bun.file(`/proc/${pid}/stat`)
    if (!(await stat.exists())) return false
    const body = await stat.text()
    if (body.slice(body.lastIndexOf(")") + 2).startsWith("Z")) return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
