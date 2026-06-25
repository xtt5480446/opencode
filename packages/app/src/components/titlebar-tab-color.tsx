import { createEffect, For, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useLanguage } from "@/context/language"
import { normalizeTabColor } from "@/context/tab-color"

const colors = [
  { name: "tab.color.blue", value: "#4c8dff" },
  { name: "tab.color.cyan", value: "#35b5c5" },
  { name: "tab.color.green", value: "#4fbf80" },
  { name: "tab.color.yellow", value: "#e3c243" },
  { name: "tab.color.orange", value: "#f29d49" },
  { name: "tab.color.red", value: "#ef5b5b" },
  { name: "tab.color.pink", value: "#e65fa8" },
  { name: "tab.color.purple", value: "#9b6cff" },
] as const

export function TabColorMenu(props: {
  color?: string
  onColorChange: (color: string | undefined) => void
  children: JSX.Element
}) {
  const language = useLanguage()
  const [menu, setMenu] = createStore({ open: false, x: 0, y: 0 })
  let menuRef: HTMLDivElement | undefined

  const choose = (color: string | undefined) => {
    props.onColorChange(color)
    setMenu("open", false)
  }

  createEffect(() => {
    if (!menu.open) return
    requestAnimationFrame(() => menuRef?.querySelector<HTMLElement>("button")?.focus())
    const cleanups = [
      makeEventListener(document, "pointerdown", (event) => {
        if (event.target instanceof Node && menuRef?.contains(event.target)) return
        setMenu("open", false)
      }),
      makeEventListener(document, "keydown", (event) => {
        if (event.key === "Escape") setMenu("open", false)
      }),
    ]
    onCleanup(() => cleanups.forEach((cleanup) => cleanup()))
  })

  return (
    <>
      <div
        class="flex w-full min-w-0"
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          setMenu({
            open: true,
            x: Math.max(4, Math.min(event.clientX || rect.left, window.innerWidth - 168)),
            y: Math.max(4, Math.min(event.clientY || rect.bottom, window.innerHeight - 136)),
          })
        }}
      >
        {props.children}
      </div>
      <Show when={menu.open}>
        <Portal>
          <div
            ref={menuRef}
            role="menu"
            data-component="context-menu-content"
            class="titlebar-tab-color-menu fixed z-[100]"
            style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          >
            <div data-slot="context-menu-group-label">{language.t("tab.color.label")}</div>
            <div role="group" aria-label={language.t("tab.color.label")} class="grid grid-cols-5 gap-1 px-2 pb-2">
              <For each={colors}>
                {(color) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    data-tab-color={color.value}
                    data-checked={normalizeTabColor(props.color) === color.value ? "" : undefined}
                    aria-label={language.t(color.name)}
                    aria-checked={normalizeTabColor(props.color) === color.value}
                    class="relative size-5 rounded-full border border-transparent p-[3px] outline-none hover:border-v2-border-border-strong focus-visible:border-v2-border-border-strong data-[checked]:border-v2-border-border-strong"
                    onClick={() => choose(color.value)}
                  >
                    <span class="block size-full rounded-full" style={{ "background-color": color.value }} />
                  </button>
                )}
              </For>
              <label
                class="relative flex size-5 cursor-pointer items-center justify-center rounded-full border border-transparent p-[3px] hover:border-v2-border-border-strong has-[:focus-visible]:border-v2-border-border-strong"
                title={language.t("tab.color.custom")}
              >
                <span
                  class="block size-full rounded-full"
                  style={{
                    background:
                      "conic-gradient(#ef5b5b, #e3c243, #4fbf80, #35b5c5, #4c8dff, #9b6cff, #e65fa8, #ef5b5b)",
                  }}
                />
                <input
                  data-tab-color-custom
                  type="color"
                  aria-label={language.t("tab.color.custom")}
                  value={normalizeTabColor(props.color) ?? colors[0].value}
                  class="absolute inset-0 cursor-pointer opacity-0"
                  onInput={(event) => choose(event.currentTarget.value)}
                />
              </label>
            </div>
            <Show when={normalizeTabColor(props.color)}>
              <div data-slot="context-menu-separator" />
              <button
                type="button"
                role="menuitem"
                data-slot="context-menu-item"
                class="w-full"
                onClick={() => choose(undefined)}
              >
                <span data-slot="context-menu-item-label">{language.t("tab.color.none")}</span>
              </button>
            </Show>
          </div>
        </Portal>
      </Show>
    </>
  )
}

export function TabColorPill(props: { color?: string }) {
  return (
    <Show when={normalizeTabColor(props.color)}>
      {(color) => (
        <span
          data-slot="tab-color"
          aria-hidden="true"
          class="pointer-events-none absolute bottom-px left-1 right-1 h-1 rounded-b-[5px] border border-t-0"
          style={{ "border-color": color() }}
        />
      )}
    </Show>
  )
}
