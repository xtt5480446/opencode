import { Auth } from "../../route/auth"
import { ProviderPackage } from "../../provider-package"
import { OpenAIResponses } from "../../protocols/openai-responses"

export interface OpenAICodexSettings extends ProviderPackage.Settings {
  readonly accountID?: string
}

export const model = ProviderPackage.define((modelID, settings: OpenAICodexSettings) =>
  OpenAIResponses.model(modelID, {
    auth: (settings.apiKey === undefined ? Auth.none : Auth.bearer(settings.apiKey)).andThen(
      settings.accountID === undefined ? Auth.none : Auth.headers({ "chatgpt-account-id": settings.accountID }),
    ),
    baseURL: "https://chatgpt.com/backend-api/codex",
    headers: settings.headers,
    providerOptions: settings.providerOptions === undefined ? undefined : { openai: settings.providerOptions },
    body: settings.body,
    limits: settings.limits,
  }),
)
