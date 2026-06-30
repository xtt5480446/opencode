import { createRequire } from "node:module"
import { createServer } from "node:http"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
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
const scenario = value("--scenario", "text")

if (!exe || !project || !version) {
  throw new Error("Usage: repro-windows-opentui-pty-session.mjs -- --exe <path> --project <path> --version <version>")
}

const crashPattern = /Segmentation fault|Bun has crashed|ACCESS_VIOLATION|0xC0000005|322122|panic\(main thread\)/i
const outputFile = join(project, `pty-output-${version}-${scenario}.log`)
const requestsFile = join(project, `provider-requests-${version}-${scenario}.jsonl`)
let output = ""
let providerRequests = 0
let exited = false
let exitCode = undefined
let exitSignal = undefined
let permissionSubmitted = false
let toolCallSent = false

function writeMcpStubPackage() {
  const stubDir = join(project, "mcp-stub-package")
  const binDir = join(stubDir, "bin")
  mkdirSync(binDir, { recursive: true })
  writeFileSync(
    join(stubDir, "package.json"),
    JSON.stringify(
      {
        name: "opencode-mcp-stub",
        version: "1.0.0",
        type: "module",
        bin: { "opencode-mcp-stub": "./bin/opencode-mcp-stub.mjs" },
      },
      null,
      2,
    ) + "\n",
  )
  writeFileSync(
    join(binDir, "opencode-mcp-stub.mjs"),
    `#!/usr/bin/env node
const idArg = process.argv.indexOf("--id")
const id = idArg === -1 ? "server" : process.argv[idArg + 1]
let buffer = ""
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n")
}
function result(request, result) {
  send({ jsonrpc: "2.0", id: request.id, result })
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffer += chunk
  while (true) {
    const index = buffer.indexOf("\\n")
    if (index === -1) return
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const request = JSON.parse(line)
    if (request.method === "initialize") {
      result(request, { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: id, version: "1.0.0" } })
      continue
    }
    if (request.method === "tools/list") {
      result(request, { tools: [{ name: "ping", description: "Return a deterministic response", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] })
      continue
    }
    if (request.method === "tools/call") {
      result(request, { content: [{ type: "text", text: id + " pong" }] })
      continue
    }
    if (request.id !== undefined) result(request, {})
  }
})
setInterval(() => {}, 1000)
`,
  )
  return pathToFileURL(stubDir).href
}

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

function responseText() {
  if (scenario.startsWith("bash-")) {
    return "The bash tool completed and the session continued after tool execution."
  }

  if (scenario.startsWith("task-")) {
    return "The subagent task completed and returned control to the parent session."
  }

  if (scenario.startsWith("mcp-npx")) {
    return "The MCP npx spawn storm initialized and the session completed."
  }

  if (scenario.startsWith("markdown")) {
    const sections = []
    for (let i = 0; i < 40; i++) {
      sections.push(`## Section ${i + 1}`)
      sections.push("")
      sections.push("- This line intentionally exercises markdown wrapping in the OpenTUI renderer.")
      sections.push("- It includes `inline code`, **bold text**, [a link](https://example.com), and CJK text 漢字かなカナ.")
      sections.push("")
      sections.push("```ts")
      sections.push(`const value${i} = { index: ${i}, text: "OpenTUI Windows repro" }`)
      sections.push("console.log(value" + i + ")")
      sections.push("```")
      sections.push("")
    }
    return sections.join("\n")
  }

  return "This is a deterministic CI response from the fake provider."
}

function hasToolResult(parsedBody) {
  return parsedBody?.messages?.some?.((message) => message.role === "tool" || message.role === "function") ?? false
}

function shouldCallBash(parsedBody) {
  if (!scenario.startsWith("bash-")) return false
  if (!parsedBody?.tools?.some?.((tool) => (tool.function?.name ?? tool.name) === "bash")) return false
  if (hasToolResult(parsedBody) || toolCallSent) return false
  toolCallSent = true
  return true
}

function shouldCallTask(parsedBody) {
  if (!scenario.startsWith("task-")) return false
  if (!parsedBody?.tools?.some?.((tool) => (tool.function?.name ?? tool.name) === "task")) return false
  if (hasToolResult(parsedBody) || toolCallSent) return false
  toolCallSent = true
  return true
}

const server = createServer(async (req, res) => {
  const body = await readBody(req)
  providerRequests++
  const parsedBody = body ? JSON.parse(body) : undefined
  console.log(
    `provider request ${providerRequests}: ${req.method} ${req.url} stream=${parsedBody?.stream ?? false} messages=${parsedBody?.messages?.length ?? "n/a"} tools=${parsedBody?.tools?.map?.((tool) => tool.function?.name ?? tool.name).join(",") ?? "none"}`,
  )
  writeFileSync(
    requestsFile,
    JSON.stringify({ method: req.method, url: req.url, body: parsedBody }) + "\n",
    { flag: "a" },
  )

  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ object: "list", data: [{ id: "test-model", object: "model" }] }))
    return
  }

  if (req.url?.endsWith("/chat/completions")) {
    const parsed = parsedBody ?? {}
    const callBash = shouldCallBash(parsed)
    const callTask = shouldCallTask(parsed)
    const text = responseText()
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
      if (callBash || callTask) {
        const toolName = callBash ? "bash" : "task"
        const toolArguments = callBash
          ? { command: "echo opentui-tool-repro > opentui-tool-repro.txt" }
          : {
              description: "subagent repro",
              prompt: "Respond with one sentence for the Windows OpenTUI crash repro.",
              subagent_type: "general",
            }
        writeSse(res, {
          id: "chatcmpl-opentui-repro",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "test-model",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call_opentui_repro_${toolName}`,
                    type: "function",
                    function: {
                      name: toolName,
                      arguments: JSON.stringify(toolArguments),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        await delay(50)
        writeSse(res, {
          id: "chatcmpl-opentui-repro",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }

      writeSse(res, {
        id: "chatcmpl-opentui-repro",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "test-model",
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
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
            message: { role: "assistant", content: text },
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
const mcpPackageUrl = scenario.startsWith("mcp-npx") ? writeMcpStubPackage() : undefined
const mcpServers = {}
if (mcpPackageUrl) {
  for (let index = 1; index <= 12; index++) {
    const id = `server${String(index).padStart(2, "0")}`
    mcpServers[id] = {
      type: "local",
      command: ["npx", "-y", mcpPackageUrl, "--id", id],
      timeout: 15000,
    }
  }
}

writeFileSync(
  join(project, "opencode.json"),
  `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      ...(mcpPackageUrl ? { mcp: mcpServers } : {}),
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

console.log(`scenario=${scenario}`)
if (mcpPackageUrl) console.log(`mcp package=${mcpPackageUrl}`)
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
  ...(scenario.includes("no-native-render") ? { OTUI_NO_NATIVE_RENDER: "1" } : {}),
  OTUI_USE_CONSOLE: "1",
  OTUI_SHOW_STATS: "1",
}

const proc = pty.spawn(
  exe,
  [
    "--model",
    "test/test-model",
    "--prompt",
    scenario.startsWith("bash-")
      ? "run a shell command through the bash tool, then summarize"
      : scenario.startsWith("task-")
        ? "delegate a small task to a subagent, then summarize"
      : "start a CI repro session and answer briefly",
  ],
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
  if (
    (scenario === "bash-permission" || scenario === "task-permission") &&
    !permissionSubmitted &&
    /Permission required|Allow once|Call tool bash|Call tool task|subagent repro/.test(output)
  ) {
    permissionSubmitted = true
    setTimeout(() => proc.write("\r"), 250)
  }
})

proc.onExit((event) => {
  exited = true
  exitCode = event.exitCode
  exitSignal = event.signal
})

const deadline = Date.now() + seconds * 1000
let completedAt
while (Date.now() < deadline) {
  if (crashPattern.test(output)) break
  if (exited) break
  if (!completedAt && output.includes("message=\"exiting loop\"")) completedAt = Date.now()
  if (completedAt && Date.now() - completedAt > 8000) break
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

await new Promise((resolveClose) => server.close(resolveClose))

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

process.exit(0)
