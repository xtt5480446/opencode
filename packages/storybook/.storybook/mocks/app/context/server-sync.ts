const data = {
  provider: {
    all: new Map(),
    connected: [],
    default: {},
  },
  provider_auth: {} as Record<string, Array<{ type: "api"; label: string }>>,
  config: { disabled_providers: [] as string[] },
}

export function useServerSync() {
  return () => ({
    data,
    set(key: "provider_auth", value: typeof data.provider_auth) {
      data[key] = value
    },
    updateConfig: async () => {},
  })
}
