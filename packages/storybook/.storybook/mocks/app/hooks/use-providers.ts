const model_id = "claude-3-7-sonnet"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]

const provider = {
  id: "anthropic",
  models: {
    [model_id]: {
      id: model_id,
      name: "Claude 3.7 Sonnet",
      cost: { input: 1, output: 1 },
      variants: { fast: {}, thinking: {} },
    },
  },
}

const popular = [
  { id: "opencode", name: "OpenCode Zen", models: {} },
  { id: "opencode-go", name: "OpenCode Go", models: {} },
  { id: "openai", name: "OpenAI", models: {} },
  provider,
  { id: "google", name: "Google", models: {} },
  { id: "github-copilot", name: "GitHub Copilot", models: {} },
]

export function useProviders() {
  return {
    all: () => popular,
    default: () => ({ anthropic: model_id }),
    connected: () => [provider],
    paid: () => [provider],
    popular: () => popular,
  }
}
