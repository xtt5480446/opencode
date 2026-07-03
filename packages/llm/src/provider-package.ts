export * as ProviderPackage from "./provider-package"

import type { Model } from "./schema"

export interface Settings extends Readonly<Record<string, unknown>> {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly providerOptions?: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Readonly<Record<string, unknown>>
  readonly limits?: { readonly context: number; readonly output: number }
}

export interface Definition<S extends Settings = Settings> {
  readonly model: (modelID: string, settings: S) => Model
}

export const define = <S extends Settings = Settings>(model: (modelID: string, settings: S) => Model) => model
