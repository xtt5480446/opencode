import type { useSDK } from "@tui/context/sdk"
import type { useSync } from "@tui/context/sync"
import type { useRoute } from "@tui/context/route"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"

type SDK = ReturnType<typeof useSDK>
type Sync = ReturnType<typeof useSync>
type Navigate = ReturnType<typeof useRoute>["navigate"]

// File parts keep their server identifiers when seeding a new session (fork) but
// are stripped when the draft is re-submitted into the same session (revert).
export function collectPrompt(sync: Sync, messageID: string, options: { stripFiles: boolean }): PromptInfo | undefined {
  const parts = sync.data.part[messageID]
  if (!parts) return
  return parts.reduce(
    (agg, part) => {
      if (part.type === "text") {
        if (!part.synthetic) agg.input += part.text
      }
      if (part.type === "file") agg.parts.push(options.stripFiles ? strip(part) : part)
      return agg
    },
    { input: "", parts: [] as PromptInfo["parts"] },
  )
}

export function collectText(sync: Sync, messageID: string) {
  const parts = sync.data.part[messageID] ?? []
  return parts.reduce((text, part) => {
    if (part.type === "text" && !part.synthetic) text += part.text
    return text
  }, "")
}

export function revert(options: {
  sdk: SDK
  sync: Sync
  sessionID: string
  messageID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  void options.sdk.client.session.revert({ sessionID: options.sessionID, messageID: options.messageID })
  if (!options.setPrompt) return
  const prompt = collectPrompt(options.sync, options.messageID, { stripFiles: true })
  if (prompt) options.setPrompt(prompt)
}

export async function fork(options: {
  sdk: SDK
  sync: Sync
  navigate: Navigate
  sessionID: string
  messageID: string
}) {
  const result = await options.sdk.client.session.fork({ sessionID: options.sessionID, messageID: options.messageID })
  options.navigate({
    type: "session",
    sessionID: result.data!.id,
    prompt: collectPrompt(options.sync, options.messageID, { stripFiles: false }),
  })
}

export * as MessageActions from "./message-actions"
