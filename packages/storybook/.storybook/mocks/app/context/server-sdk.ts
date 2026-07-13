const providers = [
  "opencode",
  "opencode-go",
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "vercel",
  "github-copilot",
  "302ai",
  "abacus",
  "abliteration",
  "alibaba",
  "alibaba-cn",
  "alibaba-coding-plan",
]

const client = {
  provider: {
    auth: async () => ({
      data: Object.fromEntries(providers.map((provider) => [provider, [{ type: "api", label: "API key" }]])),
    }),
    oauth: {
      authorize: async () => ({ data: undefined }),
      callback: async () => ({ data: undefined }),
    },
  },
  auth: {
    set: async () => ({ data: true }),
  },
  global: {
    dispose: async () => ({ data: true }),
  },
}

export function useServerSDK() {
  return () => ({ client })
}
