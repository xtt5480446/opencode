import { createRequire } from "node:module"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const require = createRequire(join(process.cwd(), "pty-harness.cjs"))
const pty = require("@lydell/node-pty")

const args = process.argv.slice(2)
const value = (name, fallback) => {
  const index = args.indexOf(name)
  if (index === -1) return fallback
  return args[index + 1]
}

const exe = value("--exe")
const project = value("--project")
const version = value("--version")
const seconds = Number(value("--seconds", "120"))

if (!exe || !project || !version) {
  throw new Error("Usage: repro-windows-opentui-pty-session.mjs -- --exe <path> --project <path> --version <version>")
}

const crashPattern = /Segmentation fault|Bun has crashed|ACCESS_VIOLATION|0xC0000005|322122|panic\(main thread\)/i
const outputFile = join(project, `pty-output-${version}.log`)
const requestsFile = join(project, `provider-requests-${version}.jsonl`)
let output = ""
let providerRequests = 0
let exited = false
let exitCode = undefined
let exitSignal = undefined

mkdirSync(project, { recursive: true })

function appendOutput(text) {
  output += text
  writeFileSync(outputFile, output)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}

function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

const server = createServer(async (req, res) => {
  const body = await readBody(req)
  providerRequests++
  writeFileSync(
    requestsFile,
    JSON.stringify({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined }) + "\n",
    { flag: "a" },
  )

  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }))
    return
  }

  if (req.url?.endsWith("/chat/completions")) {
    const parsed = body ? JSON.parse(body) : {}
    if (parsed.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      writeSse(res, {
        id: "chatcmpl-opentui-repro",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "test-model",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })
      await delay(50)
      writeSse(res, {
        id: "chatcmpl-opentui-repro",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "test-model",
        choices: [{ index: 0, delta: { content: "This is a deterministic CI response from the fake provider." }, finish_reason: null }],
      })
      await delay(50)
      writeSse(res, {
        id: "chatcmpl-opentui-repro",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "test-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })
      res.write("data: [DONE]\n\n")
      res.end()
      return
    }

    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        id: "chatcmpl-opentui-repro",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "This is a deterministic CI response from the fake provider." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    )
    return
  }

  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: { message: `Unhandled fake provider route: ${req.url}` } }))
})

await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
const { port } = server.address()
const baseURL = `http://127.0.0.1:${port}/v1`

writeFileSync(
  join(project, "opencode.json"),
  `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      enabled_providers: ["test"],
      provider: {
        test: {
          name: "Test",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context: 100000, output: 10000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: { apiKey: "test-key", baseURL },
        },
      },
    },
    null,
    2,
  )}\n`,
)

console.log(`fake provider baseURL=${baseURL}`)
console.log(`pty output log=${outputFile}`)
console.log(`provider requests log=${requestsFile}`)

const env = {
  ...process.env,
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_LOG_LEVEL: "DEBUG",
  OPENCODE_PRINT_LOGS: "1",
  OPENCODE_PURE: "1",
  OTUI_DEBUG: "1",
  OTUI_DUMP_CAPTURES: "1",
  OTUI_USE_CONSOLE: "1",
  OTUI_SHOW_STATS: "1",
}

const proc = pty.spawn(
  exe,
  ["--model", "test/test-model", "--prompt", "start a CI repro session and answer briefly"],
  {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: resolve(project),
    env,
  },
)

proc.onData((data) => {
  appendOutput(data)
  process.stdout.write(data)
})

proc.onExit((event) => {
  exited = true
  exitCode = event.exitCode
  exitSignal = event.signal
})

const deadline = Date.now() + seconds * 1000
while (Date.now() < deadline) {
  if (crashPattern.test(output)) break
  if (exited) break
  if (providerRequests > 0 && output.includes("fake provider")) break
  await delay(500)
}

if (!exited) {
  proc.write("\x03")
  await delay(1500)
}
if (!exited) {
  proc.kill()
  await delay(500)
}

server.close()

console.log(`\npty exitCode=${exitCode} signal=${exitSignal} providerRequests=${providerRequests}`)

if (crashPattern.test(output)) {
  throw new Error("native crash signature detected in PTY session")
}

if (exitCode === 3 || exitCode === -1073741819 || exitCode === -1073740791 || exitCode === -1073741571) {
  throw new Error(`native crash exit code detected in PTY session: ${exitCode}`)
}

if (providerRequests === 0) {
  throw new Error("PTY session did not send a request to the fake provider")
}
