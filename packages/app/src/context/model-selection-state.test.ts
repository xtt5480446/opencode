import { describe, expect, test } from "bun:test"
import { createRoot, getOwner } from "solid-js"
import { createTabMemory } from "./tab-memory"
import { createTabModelSelectionState } from "./model-selection-state"
import type { DraftTab } from "./tabs"

describe("model selection state", () => {
  test("keeps model selection scoped to its draft tab", () => {
    createRoot((dispose) => {
      const memory = createTabMemory(getOwner())
      const tabs = {
        state<T>(tab: DraftTab, name: string, init: () => T) {
          return memory.ensure(`draft:${tab.draftID}`, name, init)
        },
      }
      const first = { type: "draft", draftID: "first", server: "server", directory: "/repo" } as DraftTab
      const second = { type: "draft", draftID: "second", server: "server", directory: "/repo" } as DraftTab

      createTabModelSelectionState(tabs, first).set({
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude" },
      })
      createTabModelSelectionState(tabs, second).set({
        agent: "build",
        model: { providerID: "openai", modelID: "gpt" },
      })

      expect(createTabModelSelectionState(tabs, first).current()?.model).toEqual({
        providerID: "anthropic",
        modelID: "claude",
      })
      expect(createTabModelSelectionState(tabs, second).current()?.model).toEqual({
        providerID: "openai",
        modelID: "gpt",
      })
      dispose()
    })
  })
})
