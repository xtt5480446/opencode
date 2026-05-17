import type { ChildProcessWithoutNullStreams } from "child_process"
import { EventEmitter } from "events"
import { PassThrough, type Readable, type Writable } from "stream"
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node"
import type * as LSPServer from "@/lsp/server"

// ─── Fake process ────────────────────────────────────────────────────────────
//
// `LSPClient.create` wraps the server handle's stdout/stdin with
// `StreamMessageReader` / `StreamMessageWriter` from `vscode-jsonrpc/node`,
// which expects real Node `Readable` / `Writable` streams. We satisfy that
// contract with a pair of `PassThrough` streams wired in opposite directions:
//
//   client.write(stdin) ──► [inbound] ──► server reads
//   client.read(stdout) ◄── [outbound] ◄── server writes
//
// Everything lives in-process; nothing is ever spawned.

interface FakeProcessHandles {
  readonly process: ChildProcessWithoutNullStreams
  readonly serverInput: Readable
  readonly serverOutput: Writable
}

let fakePid = 50_000

function createFakeProcess(): FakeProcessHandles {
  const inbound = new PassThrough() // client.stdin → server reads
  const outbound = new PassThrough() // server writes → client.stdout
  const stderr = new PassThrough() // never written

  const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    pid: number
    stdin: Writable
    stdout: Readable
    stderr: Readable
  }
  proc.pid = ++fakePid
  proc.exitCode = null
  proc.signalCode = null
  proc.stdin = inbound
  proc.stdout = outbound
  proc.stderr = stderr

  // `Process.stop` calls `proc.kill()`. Tear the streams down and emit `exit`
  // so any consumer that awaits `process.exited` resolves.
  Object.defineProperty(proc, "kill", {
    value: (_signal?: NodeJS.Signals | number) => {
      if (proc.exitCode !== null) return true
      proc.exitCode = 0
      proc.signalCode = null
      // Closing the streams unblocks the JSON-RPC reader/writer cleanly.
      inbound.end()
      outbound.end()
      stderr.end()
      proc.emit("exit", 0, null)
      proc.emit("close", 0, null)
      return true
    },
  })

  return { process: proc, serverInput: inbound, serverOutput: outbound }
}

// ─── JSON-RPC server implementation ──────────────────────────────────────────
//
// We use the same `vscode-jsonrpc` library on the server side so the wire
// framing is bit-for-bit identical to a real LSP server. The server is
// a stub: it responds with valid but empty results to every request the
// client makes, and accepts every notification silently.

const SERVER_CAPABILITIES = {
  textDocumentSync: {
    openClose: true,
    change: 2, // Incremental
  },
  hoverProvider: true,
  definitionProvider: true,
  referencesProvider: true,
  implementationProvider: true,
  documentSymbolProvider: true,
  workspaceSymbolProvider: true,
  callHierarchyProvider: true,
  diagnosticProvider: {
    interFileDependencies: false,
    workspaceDiagnostics: false,
  },
} as const

function startFakeServer(connection: MessageConnection) {
  connection.onRequest("initialize", async () => ({
    capabilities: SERVER_CAPABILITIES,
    serverInfo: { name: "simulated-lsp", version: "0.0.0" },
  }))

  // Notifications — silently accept.
  for (const method of [
    "initialized",
    "textDocument/didOpen",
    "textDocument/didChange",
    "textDocument/didClose",
    "textDocument/didSave",
    "workspace/didChangeWatchedFiles",
    "workspace/didChangeConfiguration",
    "$/setTrace",
    "$/cancelRequest",
  ]) {
    connection.onNotification(method, () => {})
  }

  // Diagnostics — empty pull response so the client's pull path resolves
  // immediately with no findings. We never push diagnostics.
  connection.onRequest("textDocument/diagnostic", async () => ({
    kind: "full",
    items: [],
  }))
  connection.onRequest("workspace/diagnostic", async () => ({
    items: [],
  }))

  // Code intelligence — null/[] results are valid per the LSP spec.
  connection.onRequest("textDocument/hover", async () => null)
  connection.onRequest("textDocument/definition", async () => [])
  connection.onRequest("textDocument/references", async () => [])
  connection.onRequest("textDocument/implementation", async () => [])
  connection.onRequest("textDocument/documentSymbol", async () => [])
  connection.onRequest("workspace/symbol", async () => [])
  connection.onRequest("textDocument/prepareCallHierarchy", async () => [])
  connection.onRequest("callHierarchy/incomingCalls", async () => [])
  connection.onRequest("callHierarchy/outgoingCalls", async () => [])

  // Shutdown / exit — the client doesn't call `shutdown` (it just kills the
  // process), but answer if it ever does.
  connection.onRequest("shutdown", async () => null)
  connection.onNotification("exit", () => {})

  // Catch-all so unknown methods don't blow up the connection.
  connection.onRequest((method) => {
    // Unknown method: return null. Returning a typed error would also be
    // valid, but null keeps consumers happy without spurious failures.
    void method
    return null
  })
  connection.onNotification(() => {})

  connection.listen()
}

// ─── Public LSPServer.Info implementation ────────────────────────────────────

export const SimulatedTypescript: LSPServer.Info = {
  id: "typescript",
  // Match the file extensions of the real typescript server so the simulated
  // backend reports clients for the same files. The simulated root is just
  // the instance directory — we don't probe the filesystem here because the
  // simulated FS is in-memory and the only "project" is `/opencode`.
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
  root: async (_file, ctx) => ctx.directory,
  async spawn(_root, _ctx) {
    const { process, serverInput, serverOutput } = createFakeProcess()

    const connection = createMessageConnection(
      new StreamMessageReader(serverInput),
      new StreamMessageWriter(serverOutput),
    )
    startFakeServer(connection)

    // When the client kills the process, the streams close and the server
    // connection's reader will emit `end`. Dispose explicitly to release
    // listeners.
    process.once("exit", () => {
      connection.dispose()
    })

    return {
      process,
      initialization: {},
    }
  },
}

export const supportedServers: LSPServer.Info[] = [SimulatedTypescript]

export * as SimulationLsp from "./lsp"
