export * as ConfigProviderOptionsV1 from "./provider-options"

type Options = Readonly<Record<string, unknown>>

export interface ProviderResult {
  readonly settings: Record<string, unknown>
  readonly headers?: Record<string, string>
  readonly body?: Record<string, unknown>
}

export interface Lowerer {
  readonly provider: (options: Options) => ProviderResult
  readonly model: (options: Options) => Record<string, unknown>
}

const lowerer: Lowerer = {
  provider(options) {
    return {
      settings: Object.fromEntries(Object.entries(options).filter(([key]) => key !== "headers" && key !== "body")),
      headers: record(options.headers, (value): value is string => typeof value === "string"),
      body: record(options.body, () => true),
    }
  },
  model: (options) => ({ ...options }),
}

export function get(_packageName?: string): Lowerer {
  return lowerer
}

function record<T>(input: unknown, guard: (value: unknown) => value is T) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, T] => guard(entry[1])))
}
