export * as ProviderV2 from "./provider"

import { Effect, Schema, Types } from "effect"
import { Provider } from "@opencode-ai/schema/provider"
import { ProviderPackage } from "@opencode-ai/llm/provider-package"
import { Anthropic, OpenAI, OpenAICodex, OpenAICompatible } from "@opencode-ai/llm/providers"

export const ID = Provider.ID
export type ID = typeof ID.Type

export const AISDK = Provider.AISDK

export const Native = Provider.Native

export const Api = Provider.Api
export type Api = Provider.Api
export type MutableApi<T extends Api = Api> = T extends Api
  ? Omit<Types.DeepMutable<T>, "settings"> & (undefined extends T["settings"] ? { settings?: any } : { settings: any })
  : never

export const Request = Provider.Request
export type Request = Provider.Request

export const Info = Provider.Info
export type Info = Provider.Info

export type MutableInfo = Omit<Types.DeepMutable<Info>, "api"> & { api: MutableApi }

export class PackageLoadError extends Schema.TaggedErrorClass<PackageLoadError>()("ProviderV2.PackageLoadError", {
  specifier: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Failed to load provider package ${this.specifier}: ${this.reason}`
  }
}

type PackageModule = { readonly model: ProviderPackage.Definition["model"] }

const builtins: Record<string, PackageModule> = {
  "@opencode-ai/llm/providers/openai": OpenAI,
  "@opencode-ai/llm/providers/anthropic": Anthropic,
  "@opencode-ai/llm/providers/openai-compatible": OpenAICompatible,
  "@opencode-ai/llm/providers/openai/codex": OpenAICodex,
}

export const loadPackage = (
  specifier: string,
): Effect.Effect<ProviderPackage.Definition["model"], PackageLoadError> => {
  const builtin = builtins[specifier]
  if (builtin) return Effect.succeed(builtin.model)
  return Effect.tryPromise({
    try: () => import(specifier),
    catch: (cause) =>
      new PackageLoadError({ specifier, reason: cause instanceof Error ? cause.message : String(cause) }),
  }).pipe(
    Effect.flatMap((module) => {
      if (hasModel(module)) return Effect.succeed(module.model)
      return Effect.fail(new PackageLoadError({ specifier, reason: "missing model export" }))
    }),
  )
}

export const load = loadPackage

function hasModel(module: unknown): module is PackageModule {
  return typeof module === "object" && module !== null && "model" in module && typeof module.model === "function"
}
