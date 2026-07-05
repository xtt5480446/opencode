import type { SessionMessageUser } from "@opencode-ai/sdk/v2"
import type { PromptInfo } from "../prompt/history"

export function revertedPrompt(current: PromptInfo, message: SessionMessageUser): PromptInfo | undefined {
  if (current.input || current.parts.length) return

  return {
    input: message.text,
    parts: [
      ...(message.files ?? []).map((file) => ({
        type: "file" as const,
        mime: file.mime,
        filename: file.name,
        url: file.uri,
        source: file.source
          ? {
              type: "file" as const,
              path: file.name ?? file.uri,
              text: {
                start: file.source.start,
                end: file.source.end,
                value: file.source.text,
              },
            }
          : undefined,
      })),
      ...(message.agents ?? []).map((agent) => ({
        type: "agent" as const,
        name: agent.name,
        source: agent.source
          ? {
              start: agent.source.start,
              end: agent.source.end,
              value: agent.source.text,
            }
          : undefined,
      })),
    ],
  }
}
