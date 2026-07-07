import type { IntegrationApi } from "@opencode-ai/client/promise/api"
import type { IntegrationMethodRegistration } from "../effect/integration.js"
import type {
  CredentialOAuth,
  CredentialValue,
  IntegrationEnvMethod,
  IntegrationInputs,
  IntegrationKeyMethod,
  IntegrationOAuthMethod,
} from "@opencode-ai/sdk/v2/types"
import type { Search } from "@opencode-ai/schema/search"
import type { Registration, TransformHook } from "./registration.js"

export type { IntegrationMethodRegistration }

export type IntegrationOAuthAuthorization = {
  readonly url: string
  readonly instructions: string
} & (
  | {
      readonly mode: "auto"
      readonly callback: Promise<CredentialOAuth>
    }
  | {
      readonly mode: "code"
      readonly callback: (code: string) => Promise<CredentialOAuth>
    }
)

export type IntegrationOAuthMethodDefinition = IntegrationOAuthMethod & {
  readonly authorize: (inputs: IntegrationInputs) => Promise<IntegrationOAuthAuthorization>
  readonly refresh?: (credential: CredentialOAuth) => Promise<CredentialOAuth>
  readonly credentialLabel?: (credential: CredentialOAuth) => string | undefined
}

export type IntegrationMethodDefinition = IntegrationOAuthMethodDefinition | IntegrationKeyMethod | IntegrationEnvMethod

export interface IntegrationSearchDefinition {
  readonly connection: "optional" | "required"
  readonly execute: (
    input: Search.Input,
    context: { readonly credential?: CredentialValue; readonly sessionID?: string; readonly signal: AbortSignal },
  ) => Promise<Search.ProviderOutput>
}

export interface IntegrationDefinition {
  readonly id: string
  readonly name: string
  readonly methods?: readonly IntegrationMethodDefinition[]
  readonly search?: IntegrationSearchDefinition
}

export type IntegrationDraft = import("../effect/integration.js").IntegrationDraft

export interface IntegrationHooks extends IntegrationApi {
  readonly register: (definition: IntegrationDefinition) => Promise<Registration>
  readonly transform: TransformHook<IntegrationDraft>
  readonly reload: () => Promise<void>
  readonly connection: {
    readonly active: (integrationID: string) => Promise<import("@opencode-ai/sdk/v2/types").ConnectionInfo | undefined>
    readonly resolve: (
      connection: import("@opencode-ai/sdk/v2/types").ConnectionInfo,
    ) => Promise<CredentialValue | undefined>
  }
}
