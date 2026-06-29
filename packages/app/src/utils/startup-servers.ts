import { normalizeServerUrl, ServerConnection } from "@/context/server"

export type StartupServerConfig =
  | string
  | {
      url?: unknown
      name?: unknown
      displayName?: unknown
      username?: unknown
      password?: unknown
    }

export function parseStartupServers(input: unknown): ServerConnection.Http[] {
  const parsed = typeof input === "string" ? parseServerString(input) : input
  if (Array.isArray(parsed)) return parsed.flatMap((value) => serverFromConfig(value))
  if (!isRecord(parsed)) return []
  return Object.entries(parsed).flatMap(([name, value]) =>
    typeof value === "string" ? serverFromConfig({ name, url: value }) : serverFromConfig(value),
  )
}

function parseServerString(input: string): unknown {
  const trimmed = input.trim()
  if (!trimmed) return []
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return []
    }
  }
  return trimmed.split(",").map((item) => {
    const value = item.trim()
    const index = value.indexOf("=")
    if (index <= 0) return value
    return { name: value.slice(0, index).trim(), url: value.slice(index + 1).trim() }
  })
}

function serverFromConfig(input: unknown): ServerConnection.Http[] {
  const url = normalizeServerUrl(typeof input === "string" ? input : (isRecord(input) && stringValue(input.url)) || "")
  if (!url) return []

  const conn: ServerConnection.Http = { type: "http", http: { url } }
  if (isRecord(input)) {
    const displayName = stringValue(input.displayName) ?? stringValue(input.name)
    if (displayName) conn.displayName = displayName
    const username = stringValue(input.username)
    if (username) conn.http.username = username
    const password = stringValue(input.password)
    if (password) conn.http.password = password
  }
  return [conn]
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
