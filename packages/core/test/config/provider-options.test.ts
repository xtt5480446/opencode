import { describe, expect, test } from "bun:test"
import { ConfigProviderOptionsV1 } from "@opencode-ai/core/v1/config/provider-options"

describe("ConfigProviderOptionsV1", () => {
  test("splits provider overlays without changing package settings", () => {
    const lowerer = ConfigProviderOptionsV1.get("@ai-sdk/openai")

    expect(
      lowerer.provider({
        apiKey: "secret",
        baseURL: "https://openai.example/v1",
        organization: "org",
        headers: { "x-test": "1", invalid: true },
        body: { store: true },
        nested: { camelCase: true },
      }),
    ).toEqual({
      settings: {
        apiKey: "secret",
        baseURL: "https://openai.example/v1",
        organization: "org",
        nested: { camelCase: true },
      },
      headers: { "x-test": "1" },
      body: { store: true },
    })
  })

  test("keeps model and variant options unchanged", () => {
    const lowerer = ConfigProviderOptionsV1.get("@ai-sdk/anthropic")

    expect(
      lowerer.model({
        reasoningEffort: "high",
        taskBudget: 1024,
        metadata: { userId: "user" },
      }),
    ).toEqual({
      reasoningEffort: "high",
      taskBudget: 1024,
      metadata: { userId: "user" },
    })
  })

  test("uses the same mechanical lowering for every package", () => {
    expect(ConfigProviderOptionsV1.get("custom-provider").provider({ enabled: true })).toEqual({
      settings: { enabled: true },
      headers: undefined,
      body: undefined,
    })
  })
})
