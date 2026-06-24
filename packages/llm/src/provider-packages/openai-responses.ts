import type { ProviderPackage } from "../provider-package"
import * as OpenAI from "../providers/openai"
import type { OpenAIProviderOptionsInput } from "../providers/openai-options"
import { defaults } from "./shared"

export interface Settings extends ProviderPackage.Settings {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly queryParams?: Readonly<Record<string, string>>
  readonly transport?: "http" | "websocket"
  readonly providerOptions?: OpenAIProviderOptionsInput
}

export const model: ProviderPackage.Definition<Settings>["model"] = (id, settings) => {
  const provider = OpenAI.configure({
    ...defaults(settings),
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    queryParams: settings.queryParams === undefined ? undefined : { ...settings.queryParams },
    providerOptions: settings.providerOptions,
  })
  if (settings.transport === undefined || settings.transport === "http") return provider.responses(id)
  if (settings.transport === "websocket") return provider.responsesWebSocket(id)
  throw new Error(`Unsupported OpenAI Responses transport: ${String(settings.transport)}`)
}
