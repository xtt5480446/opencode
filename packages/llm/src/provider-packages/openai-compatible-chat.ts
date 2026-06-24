import type { ProviderPackage } from "../provider-package"
import * as OpenAICompatible from "../providers/openai-compatible"
import { defaults } from "./shared"

export interface Settings extends ProviderPackage.Settings {
  readonly apiKey?: string
  readonly baseURL: string
  readonly provider?: string
}

export const model: ProviderPackage.Definition<Settings>["model"] = (id, settings) =>
  OpenAICompatible.configure({
    ...defaults(settings),
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    provider: settings.provider,
  }).model(id)
