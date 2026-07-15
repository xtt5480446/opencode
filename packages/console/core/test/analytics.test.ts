import { describe, expect, test } from "bun:test"
import { Effect, Logger, References } from "effect"
import { AnalyticsLogger } from "../src/analytics"

const event: AnalyticsLogger.Event = {
  version: 1,
  type: "completions",
  timestamp: "2026-07-15T15:30:00.000Z",
  dataset: "zen",
  request: {
    id: "request_01",
    sessionID: "session_01",
    projectID: "project_01",
    stream: true,
    size: 1_024,
    responseSize: 4_096,
    status: 200,
  },
  model: {
    id: "claude-opus-4-1",
    tier: "go",
    variant: "high",
  },
  provider: {
    id: "anthropic",
    model: "claude-opus-4-1-20250805",
    shallow: {
      id: "gateway",
      model: "claude-opus-4-1",
    },
    budgetUsage: 0.42,
    budgetPriority: 2,
  },
  account: {
    source: "subscription",
    workspaceID: "workspace_01",
    userID: "user_01",
    apiKeyID: "key_01",
    subscription: "20",
  },
  client: {
    name: "opencode",
    userAgent: "opencode/1.18.1",
    ip: "203.0.113.12",
    ipPrefix: "203.0.113.12/32",
    geo: {
      continent: "NA",
      country: "US",
      city: "Chicago",
      region: "Illinois",
      latitude: 41.8781,
      longitude: -87.6298,
      timezone: "America/Chicago",
    },
  },
  usage: {
    input: 1_000,
    output: 500,
    reasoning: 100,
    cacheRead: 200,
    cacheWrite5m: 50,
    cacheWrite1h: 25,
  },
  price: {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite5m: 18.75,
    cacheWrite1h: 30,
  },
  cost: {
    inputMicrocents: 1_500_000,
    outputMicrocents: 3_750_000,
    cacheReadMicrocents: 30_000,
    cacheWrite5mMicrocents: 93_750,
    cacheWrite1hMicrocents: 75_000,
    totalMicrocents: 5_448_750,
  },
  latency: {
    totalMs: 2_100.5,
    firstByteMs: 320.25,
    firstByteAt: 1_752_592_200_320,
    lastByteAt: 1_752_592_202_100,
  },
}

describe("AnalyticsLogger", () => {
  test("preserves the inference fields needed by analytics", () => {
    expect(AnalyticsLogger.fields(event)).toMatchObject({
      _datalake_key: "inference.event",
      event_version: 1,
      event_timestamp: "2026-07-15T15:30:00.000Z",
      event_date: "2026-07-15",
      event_type: "completions",
      dataset: "zen",
      is_stream: true,
      session: "session_01",
      project: "project_01",
      request: "request_01",
      client: "opencode",
      user_agent: "opencode/1.18.1",
      model: "claude-opus-4-1",
      "model.tier": "go",
      "model.variant": "high",
      source: "subscription",
      workspace: "workspace_01",
      user_id: "user_01",
      api_key: "key_01",
      subscription: "20",
      provider: "anthropic",
      "provider.model": "claude-opus-4-1-20250805",
      shallowProvider: "gateway",
      "shallowProvider.model": "claude-opus-4-1",
      duration: 2_100.5,
      time_to_first_byte: 320.25,
      "tokens.input": 1_000,
      "tokens.output": 500,
      "tokens.reasoning": 100,
      "tokens.cache_read": 200,
      "tokens.cache_write_5m": 50,
      "tokens.cache_write_1h": 25,
      "price.unit": "usd_per_million_tokens",
      "price.input": 15,
      "price.output": 75,
      "price.cache_read": 1.5,
      "price.cache_write_5m": 18.75,
      "price.cache_write_1h": 30,
      "cost.input.microcents": 1_500_000,
      "cost.output.microcents": 3_750_000,
      "cost.cache_read.microcents": 30_000,
      "cost.cache_write.microcents": 168_750,
      "cost.cache_write_5m.microcents": 93_750,
      "cost.cache_write_1h.microcents": 75_000,
      "cost.total.microcents": 5_448_750,
    })
  })

  test("preserves provider and application errors", () => {
    const failure: AnalyticsLogger.Event = {
      version: 1,
      type: "llm.error",
      timestamp: "2026-07-15T15:30:00.000Z",
      dataset: "zen",
      request: event.request,
      model: event.model,
      provider: event.provider,
      error: {
        code: "rate_limit_error",
        llmMessage: "Too many requests",
        response: '{"error":"rate limited"}',
        type: "ProviderError",
        message: "Provider rejected the request",
        cause: "429",
        cause2: '{"retry_after":5}',
      },
    }

    expect(AnalyticsLogger.fields(failure)).toMatchObject({
      event_type: "llm.error",
      "llm.error.code": "rate_limit_error",
      "llm.error.message": "Too many requests",
      "error.response": '{"error":"rate limited"}',
      "error.type": "ProviderError",
      "error.message": "Provider rejected the request",
      "error.cause": "429",
      "error.cause2": '{"retry_after":5}',
    })
  })

  test("writes to every analytical writer without reaching the Dash0 logger", async () => {
    const first: AnalyticsLogger.Fields[] = []
    const second: AnalyticsLogger.Fields[] = []
    const dash0: unknown[] = []
    const dash0Logger = Logger.make<unknown, void>((options) => dash0.push(options.message))

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.logInfo("ordinary application log")
        yield* AnalyticsLogger.write(event)
      }).pipe(
        Effect.provide(
          AnalyticsLogger.layer([
            AnalyticsLogger.writer((fields) => first.push(fields)),
            AnalyticsLogger.writer((fields) => second.push(fields)),
          ]),
        ),
        Effect.provide(Logger.layer([dash0Logger], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "All"),
      ),
    )

    expect(first).toEqual([AnalyticsLogger.fields(event)])
    expect(second).toEqual([AnalyticsLogger.fields(event)])
    expect(dash0).toEqual([["ordinary application log"]])
  })

  test("cannot be disabled by the application log level", async () => {
    const records: AnalyticsLogger.Fields[] = []
    const service = AnalyticsLogger.make([AnalyticsLogger.writer((fields) => records.push(fields))])

    await Effect.runPromise(service.write(event).pipe(Effect.provideService(References.MinimumLogLevel, "None")))

    expect(records).toEqual([AnalyticsLogger.fields(event)])
  })
})
