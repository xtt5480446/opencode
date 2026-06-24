import type { ProviderPackage } from "../provider-package"
import * as AmazonBedrock from "../providers/amazon-bedrock"
import type { BedrockCredentials } from "../protocols/bedrock-converse"
import { defaults } from "./shared"

export interface Settings extends ProviderPackage.Settings {
  readonly apiKey?: string
  readonly auth?: "bearer" | "sigv4"
  readonly baseURL?: string
  readonly credentials?: BedrockCredentials
  readonly region?: string
  readonly topP?: number
}

export const model: ProviderPackage.Definition<Settings>["model"] = (id, settings) => {
  if (settings.auth === "bearer" && settings.apiKey === undefined)
    throw new Error("Amazon Bedrock bearer auth requires apiKey")
  if (settings.auth === "sigv4" && settings.apiKey !== undefined)
    throw new Error("Amazon Bedrock SigV4 auth does not accept apiKey")
  return AmazonBedrock.configure({
    ...defaults(settings),
    apiKey: settings.auth === "sigv4" ? undefined : settings.apiKey,
    baseURL: settings.baseURL,
    credentials: settings.credentials,
    generation: settings.topP === undefined ? undefined : { topP: settings.topP },
    region: settings.region,
  }).model(id)
}
