#!/usr/bin/env bun

import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

export interface RunOptions {
  readonly maxOutputBytes?: number
  readonly temporaryDirectory?: string
  readonly timeoutMs?: number
}

export async function runAdaptiveSmoke(command: readonly string[], options?: RunOptions) {
  const root = await mkdtemp(path.join(options?.temporaryDirectory ?? tmpdir(), "opencode-adaptive-smoke-"))
  const home = path.join(root, "home")
  const workspace = path.join(root, "workspace")

  try {
    await Promise.all([mkdir(home, { recursive: true }), mkdir(workspace, { recursive: true })])
    const child = Bun.spawn([...command, "adaptive", "doctor", "--offline", "--json"], {
      cwd: workspace,
      env: isolatedEnvironment(home, root),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const timeoutMs = options?.timeoutMs ?? 30_000
    const maxOutputBytes = options?.maxOutputBytes ?? 64 * 1024
    const timedOut = { value: false }
    const termination = { value: undefined as Promise<void> | undefined }
    const stop = () => {
      termination.value ??= terminateTree(child.pid, () => child.kill("SIGKILL"))
      return termination.value
    }
    const stdout = readBounded(child.stdout, maxOutputBytes, "stdout", stop)
    const stderr = readBounded(child.stderr, maxOutputBytes, "stderr", stop)
    const timer = setTimeout(() => {
      timedOut.value = true
      void stop()
    }, timeoutMs)
    const [exit, output, error] = await Promise.allSettled([
      child.exited.finally(() => clearTimeout(timer)),
      stdout,
      stderr,
    ])

    if (timedOut.value) throw new Error(`adaptive doctor timed out after ${timeoutMs}ms`)
    if (output.status === "rejected") throw output.reason
    if (error.status === "rejected") throw error.reason
    if (exit.status === "rejected") throw exit.reason
    if (exit.value !== 0) throw new Error(`adaptive doctor exited with code ${exit.value}: ${error.value.trim()}`)
    return validateAdaptiveDoctor(output.value)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export function validateAdaptiveDoctor(output: string) {
  const body = parseDoctor(output)
  const expected = {
    mode: "offline",
    database: "ok",
    process: "ok",
    workspace: "ok",
    audit: "ok",
    protocol: 1,
  }

  for (const [key, value] of Object.entries(expected)) {
    if (body[key] !== value) throw new Error(`adaptive doctor failed: ${key}=${String(body[key])}`)
  }
  return body
}

function parseDoctor(output: string) {
  const body = parseJson(output)
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("adaptive doctor returned a non-object JSON value")
  }
  return body as Record<string, unknown>
}

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error(`adaptive doctor returned invalid JSON: stdout=${JSON.stringify(output)}`)
  }
}

function isolatedEnvironment(home: string, root: string) {
  const inherited = [
    "PATH",
    "Path",
    "COMSPEC",
    "ComSpec",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
  ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
  return {
    ...Object.fromEntries(inherited),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: root,
    TMP: root,
    TEMP: root,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    OPENCODE_TEST_HOME: home,
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_DB: path.join(home, "opencode-smoke.db"),
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_SHARE: "1",
    NO_COLOR: "1",
  }
}

async function terminateTree(pid: number, fallback: () => void) {
  if (process.platform === "win32") {
    try {
      const killer = Bun.spawn(["taskkill", "/pid", String(pid), "/t", "/f"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 2_000,
        killSignal: "SIGKILL",
      })
      if ((await killer.exited) !== 0) fallback()
      return
    } catch {
      fallback()
      return
    }
  }

  signal(pid, "SIGSTOP")
  const first = await descendantPids(pid)
  for (const target of first) signal(target, "SIGSTOP")
  const second = await descendantPids(pid)
  for (const target of second) signal(target, "SIGSTOP")
  const descendants = Array.from(new Set([...first, ...second]))
  for (const target of descendants.toReversed()) signal(target, "SIGKILL")
  signal(pid, "SIGKILL")
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  name: "stdout" | "stderr",
  overflow: () => Promise<void>,
) {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return Buffer.concat(chunks).toString("utf8")
      bytes += next.value.byteLength
      if (bytes > limit) {
        await overflow()
        throw new Error(`adaptive doctor ${name} exceeded ${limit} bytes`)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
}

async function descendantPids(root: number) {
  try {
    const child = Bun.spawn(["ps", "-eo", "pid=,ppid="], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    })
    const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
    if (exitCode !== 0) return []
    const children = new Map<number, number[]>()
    for (const line of output.split("\n")) {
      const [pid, parent] = line.trim().split(/\s+/).map(Number)
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parent)) continue
      children.set(parent!, [...(children.get(parent!) ?? []), pid!])
    }
    const found: number[] = []
    const pending = [...(children.get(root) ?? [])]
    while (pending.length > 0 && found.length < 4_096) {
      const pid = pending.shift()!
      found.push(pid)
      pending.push(...(children.get(pid) ?? []))
    }
    return found
  } catch {
    return []
  }
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
  } catch {}
}

if (import.meta.main) {
  const binary = process.argv[2]
  if (!binary) throw new Error("usage: bun script/adaptive-smoke.ts <binary>")
  const result = await runAdaptiveSmoke([path.resolve(binary)])
  console.log(`Adaptive packaged smoke passed: protocol=${result.protocol}`)
}
