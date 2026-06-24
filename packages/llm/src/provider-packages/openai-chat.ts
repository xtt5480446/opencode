import type { ProviderPackage } from "../provider-package"
import * as OpenAI from "../providers/openai"
import type { OpenAIProviderOptionsInput } from "../providers/openai-options"
import { defaults } from "./shared"

export interface Settings extends ProviderPackage.Settings {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly queryParams?: Readonly<Record<string, string>>
  readonly providerOptions?: OpenAIProviderOptionsInput
}

export const model: ProviderPackage.Definition<Settings>["model"] = (id, settings) =>
  OpenAI.configure({
    ...defaults(settings),
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    queryParams: settings.queryParams === undefined ? undefined : { ...settings.queryParams },
    providerOptions: settings.providerOptions,
  }).chat(id)
