import type { AppClient, Capabilities, CommonClient } from "./backend"

type PartialApi<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown ? T[K] : PartialApi<T[K]>
}

export function createAppClient(input: {
  version?: AppClient["version"]
  common?: PartialApi<CommonClient>
  capabilities?: Capabilities
} = {}): AppClient {
  const unsupported = async () => {
    throw new Error("Backend fixture method is not configured")
  }
  const defaults: CommonClient = {
    health: { get: unsupported },
    projects: { current: unsupported },
    catalog: { providers: unsupported, agents: unsupported },
    commands: { list: unsupported },
    references: { list: unsupported },
    sessions: {
      list: unsupported,
      create: unsupported,
      get: unsupported,
      interrupt: unsupported,
      activity: unsupported,
      history: unsupported,
      message: unsupported,
      prompt: unsupported,
    },
    files: { list: unsupported, find: unsupported, read: unsupported },
    permissions: { pending: unsupported, reply: unsupported },
    questions: { pending: unsupported, reply: unsupported, reject: unsupported },
    pty: { list: unsupported, create: unsupported, get: unsupported, update: unsupported, remove: unsupported },
    events: {
      async *subscribe() {},
    },
  }
  return {
    version: input.version ?? "v1",
    capabilities: input.capabilities ?? {},
    common: {
      health: { ...defaults.health, ...input.common?.health },
      projects: { ...defaults.projects, ...input.common?.projects },
      catalog: { ...defaults.catalog, ...input.common?.catalog },
      commands: { ...defaults.commands, ...input.common?.commands },
      references: { ...defaults.references, ...input.common?.references },
      sessions: { ...defaults.sessions, ...input.common?.sessions },
      files: { ...defaults.files, ...input.common?.files },
      permissions: { ...defaults.permissions, ...input.common?.permissions },
      questions: { ...defaults.questions, ...input.common?.questions },
      pty: { ...defaults.pty, ...input.common?.pty },
      events: { ...defaults.events, ...input.common?.events },
    },
  }
}
