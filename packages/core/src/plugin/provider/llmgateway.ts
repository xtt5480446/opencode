import { Effect } from "effect"
import { define } from "../internal"
import { Integration } from "../../integration"
import { ProviderV2 } from "../../provider"

export const LLMGatewayPlugin = define({
  id: "llmgateway",
  effect: Effect.fn(function* (ctx) {
    const integrations = yield* Integration.Service
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.disabled) continue
          if (!ProviderV2.isAISDK(item.provider.package)) continue
          if (ProviderV2.packageName(item.provider.package) !== "@ai-sdk/openai-compatible") continue
          if (item.provider.settings?.baseURL !== "https://api.llmgateway.io/v1") continue
          if (!(yield* integrations.get(Integration.ID.make(item.provider.id)))) continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.headers = {
              ...provider.headers,
              "HTTP-Referer": "https://opencode.ai/",
              "X-Title": "opencode",
              "X-Source": "opencode",
            }
          })
        }
      }),
    )
  }),
})
