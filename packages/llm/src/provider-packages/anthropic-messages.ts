import type { ProviderPackage } from "../provider-package"
import * as Anthropic from "../providers/anthropic"
import { defaults } from "./shared"

export interface Settings extends ProviderPackage.Settings {
  readonly apiKey?: string
  readonly baseURL?: string
}

export const model: ProviderPackage.Definition<Settings>["model"] = (id, settings) =>
  Anthropic.configure({
    ...defaults(settings),
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
  }).model(id)
