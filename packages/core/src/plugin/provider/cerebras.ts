import { Effect } from "effect"
import { define } from "../internal"
import { ProviderV2 } from "../../provider"

export const CerebrasPlugin = define({
  id: "cerebras",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (!ProviderV2.isAISDK(item.provider.package)) continue
          if (ProviderV2.packageName(item.provider.package) !== "@ai-sdk/cerebras") continue
          evt.provider.update(item.provider.id, (provider) => {
            provider.headers = { ...provider.headers, "X-Cerebras-3rd-Party-Integration": "opencode" }
          })
        }
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/cerebras") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/cerebras"))
        evt.sdk = mod.createCerebras(evt.options)
      }),
    )
  }),
})
