// Per-process network log for the simulated TUI. Captures every HTTP request
// the TUI sends to the worker-backed backend (via `createWorkerFetch`).
// Exposed through the simulation MCP server so tests / agents can inspect what
// the running TUI is actually doing.

export interface NetworkLogEntry {
  readonly id: number
  readonly time: string
  readonly method: string
  readonly url: string
  readonly status: number
  readonly durationMs: number
  readonly requestHeaders: Record<string, string>
  readonly requestBody?: string
  readonly responseHeaders: Record<string, string>
  readonly responseBody: string
  readonly responseTruncated: boolean
  readonly error?: string
}

const MAX_ENTRIES = 500
const MAX_BODY_BYTES = 32_768

const entries: NetworkLogEntry[] = []
let nextId = 1

function truncate(text: string): { body: string; truncated: boolean } {
  if (text.length <= MAX_BODY_BYTES) return { body: text, truncated: false }
  return { body: text.slice(0, MAX_BODY_BYTES), truncated: true }
}

export function record(entry: Omit<NetworkLogEntry, "id" | "responseTruncated"> & { responseBody: string }) {
  const { body, truncated } = truncate(entry.responseBody)
  entries.push({ ...entry, id: nextId++, responseBody: body, responseTruncated: truncated })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
}

export function snapshot(): NetworkLogEntry[] {
  return entries.slice()
}

export function clear() {
  entries.length = 0
}

export * as SimulationNetworkLog from "./simulation-network-log"
