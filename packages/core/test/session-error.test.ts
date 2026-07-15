import { describe, expect, test } from "bun:test"
import {
  APIError,
  Authentication,
  BadRequest,
  ConnectionError,
  ContentPolicy,
  ContextOverflow,
  MalformedResponse,
  ModelID,
  NoRoute,
  NotFound,
  PermissionDenied,
  ProviderID,
  QuotaExceeded,
  RateLimit,
  RouteID,
  ServerError,
  TimeoutError,
  ToolFailure,
} from "@opencode-ai/ai"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Tool } from "@opencode-ai/plugin/v2/effect/tool"
import { toSessionError } from "@opencode-ai/core/session/to-session-error"
import { SessionRunnerRetry } from "@opencode-ai/core/session/runner/retry"

describe("toSessionError", () => {
  test("maps every LLM error tag to the open wire type", () => {
    expect(toSessionError(new RateLimit({ message: "rate", retryAfterMs: 123 }))).toEqual({
      type: "provider.rate-limit",
      message: "rate",
    })
    expect(toSessionError(new Authentication({ message: "auth" })).type).toBe("provider.auth")
    expect(toSessionError(new PermissionDenied({ message: "forbidden" })).type).toBe("provider.auth")
    expect(toSessionError(new NotFound({ message: "missing" })).type).toBe("provider.not-found")
    expect(toSessionError(new QuotaExceeded({ message: "quota" })).type).toBe("provider.quota")
    expect(toSessionError(new ContentPolicy({ message: "blocked" })).type).toBe("provider.content-filter")
    expect(toSessionError(new ContextOverflow({ message: "too long" })).type).toBe("provider.context-overflow")
    expect(toSessionError(new ConnectionError({ message: "reset" })).type).toBe("provider.transport")
    expect(toSessionError(new TimeoutError({ message: "timed out" })).type).toBe("provider.timeout")
    expect(toSessionError(new ServerError({ message: "internal", status: 500 })).type).toBe("provider.internal")
    expect(toSessionError(new MalformedResponse({ message: "output" })).type).toBe("provider.invalid-output")
    expect(toSessionError(new BadRequest({ message: "request" })).type).toBe("provider.invalid-request")
    expect(
      toSessionError(
        new NoRoute({
          route: RouteID.make("route"),
          provider: ProviderID.make("provider"),
          model: ModelID.make("model"),
        }),
      ).type,
    ).toBe("provider.no-route")
    expect(toSessionError(new APIError({ message: "unknown", status: 418 })).type).toBe("provider.unknown")
  })

  test("preserves the permission rejection type without exposing internal fields", () => {
    const blocked = new PermissionV2.BlockedError({ rules: [], permission: "external_directory", resources: [] })
    expect(toSessionError(blocked)).toEqual({
      type: "permission.rejected",
      message: "Permission denied: external_directory",
    })
    expect(toSessionError(new ToolFailure({ message: blocked.message, error: blocked }))).toEqual({
      type: "permission.rejected",
      message: "Permission denied: external_directory",
    })
    expect(toSessionError(new Tool.Failure({ message: "failed" }))).toEqual({
      type: "tool.execution",
      message: "failed",
    })
  })

  test("retries only rate limits, server errors, connection failures, and timeouts", () => {
    const eligible = [
      new RateLimit({ message: "rate" }),
      new ServerError({ message: "internal", status: 500 }),
      new ConnectionError({ message: "reset" }),
      new TimeoutError({ message: "timed out" }),
    ]
    const ineligible = [
      new Authentication({ message: "auth" }),
      new PermissionDenied({ message: "forbidden" }),
      new NotFound({ message: "missing" }),
      new QuotaExceeded({ message: "quota" }),
      new ContentPolicy({ message: "blocked" }),
      new ContextOverflow({ message: "too long" }),
      new MalformedResponse({ message: "output" }),
      new BadRequest({ message: "request" }),
      new NoRoute({
        route: RouteID.make("route"),
        provider: ProviderID.make("provider"),
        model: ModelID.make("model"),
      }),
      new APIError({ message: "unknown" }),
    ]

    expect(eligible.map(SessionRunnerRetry.isRetryable)).toEqual([true, true, true, true])
    expect(ineligible.map(SessionRunnerRetry.isRetryable)).toEqual(ineligible.map(() => false))
  })
})
