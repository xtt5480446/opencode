import type { CliRenderer, Renderable } from "@opentui/core"
import { createMockKeys, createMockMouse } from "@opentui/core/testing"
import { SimulationTrace } from "./trace"

export interface KeyModifiers {
  readonly ctrl?: boolean
  readonly shift?: boolean
  readonly meta?: boolean
  readonly super?: boolean
  readonly hyper?: boolean
}

export type Action =
  | { readonly type: "typeText"; readonly text: string }
  | { readonly type: "pressKey"; readonly key: string; readonly modifiers?: KeyModifiers }
  | { readonly type: "pressEnter" }
  | { readonly type: "pressArrow"; readonly direction: "up" | "down" | "left" | "right" }
  | { readonly type: "focus"; readonly target: number }
  | { readonly type: "click"; readonly target: number; readonly x: number; readonly y: number }

export interface Element {
  readonly id: string
  readonly num: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly focusable: boolean
  readonly focused: boolean
  readonly clickable: boolean
  readonly editor: boolean
}

export interface Harness {
  readonly renderer: CliRenderer
  readonly renderOnce: () => Promise<void>
  readonly screen: () => string
}

type RenderBuffer = {
  readonly width: number
  readonly height: number
  getRealCharBytes(includeAnsi?: boolean): Uint8Array
}

const decoder = new TextDecoder()

function children(renderable: Renderable) {
  return renderable.getChildren().filter((child): child is Renderable => "num" in child)
}

function all(renderable: Renderable): Renderable[] {
  return [renderable, ...children(renderable).flatMap(all)]
}

function mouseListeners(renderable: Renderable) {
  const general = Reflect.get(renderable, "_mouseListener")
  const specific = Reflect.get(renderable, "_mouseListeners")
  return Boolean(general) || (specific && typeof specific === "object" && Object.keys(specific).length > 0)
}

function hit(renderer: CliRenderer, renderable: Renderable) {
  if (renderable.width <= 0 || renderable.height <= 0) return false
  const x = Math.floor(renderable.screenX + renderable.width / 2)
  const y = Math.floor(renderable.screenY + renderable.height / 2)
  return renderer.hitTest(x, y) === renderable.num
}

export function createHarness(renderer: CliRenderer): Harness {
  return {
    renderer,
    renderOnce: async () => {
      renderer.requestRender()
      await renderer.idle()
    },
    screen: () => decoder.decode((Reflect.get(renderer, "currentRenderBuffer") as RenderBuffer).getRealCharBytes(true)),
  }
}

export function elements(renderer: CliRenderer): Element[] {
  return all(renderer.root)
    .filter((renderable) => renderable.visible && !renderable.isDestroyed)
    .map((renderable) => {
      const clickable = mouseListeners(renderable) && hit(renderer, renderable)
      return {
        id: renderable.id,
        num: renderable.num,
        x: renderable.screenX,
        y: renderable.screenY,
        width: renderable.width,
        height: renderable.height,
        focusable: renderable.focusable,
        focused: renderable.focused,
        clickable,
        editor: renderer.currentFocusedEditor === renderable,
      } satisfies Element
    })
    .filter((element) => element.focusable || element.clickable || element.editor)
}

export function actions(renderer: CliRenderer, options: { text?: string } = {}): Action[] {
  const items = elements(renderer)
  return [
    ...(renderer.currentFocusedEditor
      ? ([{ type: "typeText", text: options.text ?? "hello" }, { type: "pressEnter" }] satisfies Action[])
      : []),
    ...items.filter((item) => item.focusable && !item.focused).map((item) => ({ type: "focus" as const, target: item.num })),
    ...items
      .filter((item) => item.clickable)
      .map((item) => ({
        type: "click" as const,
        target: item.num,
        x: Math.floor(item.x + item.width / 2),
        y: Math.floor(item.y + item.height / 2),
      })),
    { type: "pressArrow", direction: "down" },
    { type: "pressArrow", direction: "up" },
  ]
}

export function state(harness: Harness) {
  return {
    screen: harness.screen(),
    focused: {
      renderable: harness.renderer.currentFocusedRenderable?.num,
      editor: Boolean(harness.renderer.currentFocusedEditor),
    },
    elements: elements(harness.renderer),
    actions: actions(harness.renderer),
  }
}

export async function execute(harness: Harness, action: Action) {
  const mockInput = createMockKeys(harness.renderer)
  const mockMouse = createMockMouse(harness.renderer)
  SimulationTrace.add("ui.action", { action })
  switch (action.type) {
    case "typeText":
      await mockInput.typeText(action.text)
      break
    case "pressKey":
      mockInput.pressKey(action.key, action.modifiers)
      break
    case "pressEnter":
      mockInput.pressEnter()
      break
    case "pressArrow":
      mockInput.pressArrow(action.direction)
      break
    case "focus":
      all(harness.renderer.root).find((item) => item.num === action.target)?.focus()
      break
    case "click":
      await mockMouse.click(action.x, action.y)
      break
  }
  await harness.renderOnce()
  return state(harness)
}

export * as SimulationActions from "./actions"
