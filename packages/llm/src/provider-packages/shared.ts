import type { RouteDefaultsInput } from "../route/client"
import type { ProviderPackage } from "../provider-package"

export const defaults = (settings: ProviderPackage.Settings): RouteDefaultsInput => ({
  headers: settings.headers === undefined ? undefined : { ...settings.headers },
  limits: settings.limits,
  http: settings.body === undefined ? undefined : { body: { ...settings.body } },
})
