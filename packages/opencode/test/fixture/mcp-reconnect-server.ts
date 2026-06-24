import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js"

const counts = { initialize: 0, list: 0, call: 0 }
const gates = new Map<string, PromiseWithResolvers<void>>()
const waiters = new Map<string, Array<() => void>>()

function signal(kind: keyof typeof counts) {
  for (const [key, resolvers] of waiters) {
    const [targetKind, targetCount] = key.split(":")
    if (targetKind !== kind || counts[kind] < Number(targetCount)) continue
    waiters.delete(key)
    resolvers.forEach((resolve) => resolve())
  }
}

function wait(kind: keyof typeof counts, count: number) {
  if (counts[kind] >= count) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const key = `${kind}:${count}`
    waiters.set(key, [...(waiters.get(key) ?? []), resolve])
  })
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/control/block") {
      gates.set(`${url.searchParams.get("kind")}:${url.searchParams.get("count")}`, Promise.withResolvers())
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/control/release") {
      gates.get(`${url.searchParams.get("kind")}:${url.searchParams.get("count")}`)?.resolve()
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/control/wait") {
      const kind = url.searchParams.get("kind") as keyof typeof counts
      await wait(kind, Number(url.searchParams.get("count")))
      return new Response(null, { status: 204 })
    }
    if (url.pathname === "/control/state") return Response.json(counts)
    if (request.method === "GET") return new Response(null, { status: 405 })
    if (request.method === "DELETE") return new Response(null, { status: 200 })

    const message = (await request.json()) as { id?: number; method: string }
    if (message.method === "initialize") {
      counts.initialize++
      signal("initialize")
      await gates.get(`initialize:${counts.initialize}`)?.promise
      return Response.json(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "reconnect-test", version: "1" },
          },
        },
        { headers: { "mcp-session-id": `session-${counts.initialize}` } },
      )
    }
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
    if (message.method === "tools/list") {
      counts.list++
      signal("list")
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "probe", inputSchema: { type: "object", properties: {} } }] },
      })
    }
    if (message.method === "tools/call") {
      counts.call++
      signal("call")
      const call = counts.call
      await gates.get(`call:${call}`)?.promise
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `call-${call}-initialize-${counts.initialize}` }] },
      })
    }
    return new Response(null, { status: 202 })
  },
})

process.send?.({ url: server.url.href })

process.on("SIGTERM", () => {
  server.stop(true)
  process.exit(0)
})
