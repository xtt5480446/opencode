import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  CodexAuthPlugin,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  type IdTokenClaims,
} from "../../src/plugin/codex"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("plugin.codex", () => {
  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })

  test("deduplicates concurrent Codex token refreshes", async () => {
    let auth = {
      type: "oauth" as const,
      refresh: "refresh-old",
      access: "",
      expires: 0,
    }
    const authUpdates: unknown[] = []
    let resolveRefresh: (() => void) | undefined
    const refreshReady = new Promise<void>((resolve) => {
      resolveRefresh = resolve
    })
    let refreshRequests = 0

    globalThis.fetch = mock(async (request: RequestInfo | URL) => {
      const url = request instanceof URL ? request.href : typeof request === "string" ? request : request.url
      if (url === "https://auth.openai.com/oauth/token") {
        refreshRequests += 1
        await refreshReady
        return new Response(
          JSON.stringify({
            id_token: createTestJwt({ chatgpt_account_id: "acc-123" }),
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          }),
          { status: 200 },
        )
      }

      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    const hooks = await CodexAuthPlugin({
      client: {
        auth: {
          async set(input: { body: { refresh: string; access: string; expires: number } }) {
            authUpdates.push(input)
            auth = {
              type: "oauth",
              refresh: input.body.refresh,
              access: input.body.access,
              expires: input.body.expires,
            }
          },
        },
      } as never,
      project: {} as never,
      directory: "",
      worktree: "",
      experimental_workspace: {
        register() {},
      },
      serverUrl: new URL("https://example.com"),
      $: {} as never,
    })
    const loaded = await hooks.auth!.loader!(async () => auth as never, {} as never)

    const first = loaded.fetch!("https://api.openai.com/v1/responses")
    const second = loaded.fetch!("https://api.openai.com/v1/responses")

    await Promise.resolve()
    await Promise.resolve()
    expect(refreshRequests).toBe(1)

    resolveRefresh!()
    await Promise.all([first, second])

    expect(refreshRequests).toBe(1)
    expect(authUpdates).toHaveLength(1)
  })
})
