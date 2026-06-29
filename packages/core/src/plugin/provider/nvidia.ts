import { Effect } from "effect"
import { define } from "../internal"
import { ProviderV2 } from "../../provider"

export const NvidiaPlugin = define({
  id: "nvidia",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (!ProviderV2.isAISDK(item.provider.package)) continue
          if (ProviderV2.packageName(item.provider.package) !== "@ai-sdk/openai-compatible") continue
          if (item.provider.settings?.baseURL !== "https://integrate.api.nvidia.com/v1") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.headers = {
              ...provider.headers,
              "HTTP-Referer": "https://opencode.ai/",
              "X-Title": "opencode",
              "X-BILLING-INVOKE-ORIGIN": provider.headers?.["X-BILLING-INVOKE-ORIGIN"] ?? "OpenCode",
            }
          })
        }
      }),
    )
  }),
})
