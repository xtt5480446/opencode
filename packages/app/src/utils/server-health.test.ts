import { describe, expect, test } from "bun:test"
import type { ServerConnection } from "@/context/server"
import { checkServerHealth } from "./server-health"

const server: ServerConnection.HttpBase = {
  url: "http://localhost:4096",
}

function abortFromInput(input: RequestInfo | URL, init?: RequestInit) {
  if (init?.signal) return init.signal
  if (input instanceof Request) return input.signal
  return undefined
}

describe("checkServerHealth", () => {
  test("prefers native v2 health", async () => {
    const paths: string[] = []
    const fetch = (async () =>
      new Response(JSON.stringify({ healthy: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch

    const trackingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      paths.push(new URL(input instanceof Request ? input.url : input).pathname)
      return fetch(input, init)
    }) as typeof globalThis.fetch

    const result = await checkServerHealth(server, trackingFetch)

    expect(result).toEqual({ healthy: true, version: "v2" })
    expect(paths).toEqual(["/api/health"])
  })

  test("falls back to v1 and preserves installation version", async () => {
    const paths: string[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      paths.push(path)
      if (path === "/api/health") return new Response(null, { status: 404 })
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({ healthy: true, version: "v1", installationVersion: "1.2.3" })
    expect(paths).toEqual(["/api/health", "/global/health"])
  })

  test("allows slow servers thirty seconds by default", async () => {
    const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")
    let timeoutMs = 0
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: (ms: number) => {
        timeoutMs = ms
        return new AbortController().signal
      },
    })

    const fetch = (async () =>
      new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch

    await checkServerHealth(server, fetch).finally(() => {
      if (timeout) Object.defineProperty(AbortSignal, "timeout", timeout)
      if (!timeout) Reflect.deleteProperty(AbortSignal, "timeout")
    })

    expect(timeoutMs).toBe(30_000)
  })

  test("returns unhealthy when request fails", async () => {
    const fetch = (async () => {
      throw new Error("network")
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch)

    expect(result).toEqual({ healthy: false, version: "v2" })
  })

  test("uses timeout fallback when AbortSignal.timeout is unavailable", async () => {
    const timeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: undefined,
    })

    let aborted = false
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = abortFromInput(input, init)
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true
            reject(new DOMException("Aborted", "AbortError"))
          },
          { once: true },
        )
      })) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch, {
      timeoutMs: 10,
    }).finally(() => {
      if (timeout) Object.defineProperty(AbortSignal, "timeout", timeout)
      if (!timeout) Reflect.deleteProperty(AbortSignal, "timeout")
    })

    expect(aborted).toBe(true)
    expect(result).toEqual({ healthy: false, version: "v2" })
  })

  test("uses provided abort signal", async () => {
    let signal: AbortSignal | undefined
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      signal = abortFromInput(input, init)
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch

    const abort = new AbortController()
    await checkServerHealth(server, fetch, {
      signal: abort.signal,
    })

    expect(signal).toBe(abort.signal)
  })

  test("retries transient failures and eventually succeeds", async () => {
    let count = 0
    const fetch = (async () => {
      count += 1
      if (count < 3) throw new TypeError("network")
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch, {
      retryCount: 2,
      retryDelayMs: 1,
    })

    expect(count).toBe(3)
    expect(result).toEqual({ healthy: true, version: "v2" })
  })

  test("returns unhealthy when retries are exhausted", async () => {
    let count = 0
    const fetch = (async () => {
      count += 1
      throw new TypeError("network")
    }) as unknown as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch, {
      retryCount: 2,
      retryDelayMs: 1,
    })

    expect(count).toBe(3)
    expect(result).toEqual({ healthy: false, version: "v2" })
  })

  test("does not fall back to v1 for a transient v2 server response", async () => {
    const paths: string[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      paths.push(new URL(input instanceof Request ? input.url : input).pathname)
      return new Response(null, { status: 503 })
    }) as typeof globalThis.fetch

    const result = await checkServerHealth(server, fetch, { retryCount: 0 })

    expect(result).toEqual({ healthy: false, version: "v2" })
    expect(paths).toEqual(["/api/health"])
  })

  test("retries transient v2 responses before succeeding", async () => {
    const paths: string[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      paths.push(path)
      if (paths.length === 1) return new Response(null, { status: 503 })
      return new Response(JSON.stringify({ healthy: true }), {
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    expect(await checkServerHealth(server, fetch, { retryCount: 1, retryDelayMs: 1 })).toEqual({
      healthy: true,
      version: "v2",
    })
    expect(paths).toEqual(["/api/health", "/api/health"])
  })

  test("falls back to v1 for method-not-allowed v2 health", async () => {
    const paths: string[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname
      paths.push(path)
      if (path === "/api/health") return new Response(null, { status: 405 })
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        headers: { "content-type": "application/json" },
      })
    }) as typeof globalThis.fetch

    expect(await checkServerHealth(server, fetch)).toEqual({
      healthy: true,
      version: "v1",
      installationVersion: "1.2.3",
    })
    expect(paths).toEqual(["/api/health", "/global/health"])
  })
})
