import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import type { DraftTab, useTabs } from "./tabs"

export type ModelSelectionState = {
  agent?: string
  model?: { providerID: string; modelID: string; variant?: string }
  variant?: string | null
}

export function cloneModelSelectionState(value: ModelSelectionState | undefined) {
  if (!value) return
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
  } satisfies ModelSelectionState
}

type ModelSelectionStore = { value?: ModelSelectionState }

export function createModelSelectionState(
  state: [Store<ModelSelectionStore>, SetStoreFunction<ModelSelectionStore>] = createStore<ModelSelectionStore>({}),
) {
  const [store, setStore] = state
  return {
    current: () => store.value,
    set(value: ModelSelectionState | undefined) {
      setStore("value", cloneModelSelectionState(value))
    },
  }
}

export function createTabModelSelectionState(
  tabs: Pick<ReturnType<typeof useTabs>, "state">,
  tab: DraftTab,
  init: () => ReturnType<typeof createModelSelectionState> = createModelSelectionState,
) {
  return tabs.state(tab, "model-selection", init)
}

