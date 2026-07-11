import { defineScript, wait, type ScriptUi } from "opencode-drive"

const settle = () => wait(100)

async function screenshot(ui: ScriptUi, name: string) {
  await settle()
  const path = await ui.screenshot(name)
  console.log(`${name}: ${path}`)
}

async function closeDialog(ui: ScriptUi) {
  await ui.press("escape")
  await ui.waitFor("commands")
  await settle()
  await ui.waitFor((state) => state.focused.editor)
}

async function runPalette(ui: ScriptUi, command: string, text: string, name: string) {
  await settle()
  await ui.press("p", { ctrl: true })
  await ui.waitFor("Commands")
  await settle()
  await ui.type(command)
  await ui.waitFor(command)
  await ui.enter()
  await ui.waitFor(text)
  await screenshot(ui, name)
}

export default defineScript({
  viewport: { cols: 120, rows: 36 },
  setup({ config }) {
    config.autoupdate = false
  },
  async run({ ui }) {
    await ui.waitFor((state) => state.focused.editor)
    await screenshot(ui, "01-home-key-first")

    await ui.type("!")
    await ui.waitFor("exit shell mode")
    await screenshot(ui, "02-shell-key-first")
    await ui.press("escape")
    await ui.waitFor("commands")
    await ui.waitFor((state) => state.focused.editor)

    await ui.press("p", { ctrl: true })
    await ui.waitFor("Commands")
    await screenshot(ui, "03-command-palette")
    await closeDialog(ui)

    await runPalette(ui, "Switch model", "Select model", "04-model-actions")
    await closeDialog(ui)

    await runPalette(ui, "Help", "Press", "05-help-header-prose")
    await closeDialog(ui)

    await runPalette(ui, "View debug info", "Share this", "06-debug-action-first")
    await closeDialog(ui)

    await runPalette(ui, "Switch session", "Sessions", "07-session-actions")
    await closeDialog(ui)

    await runPalette(ui, "Plugins", "Plugins", "08-plugin-actions")
    await closeDialog(ui)

    await runPalette(ui, "Install plugin", "scope:", "09-plugin-install")
    await closeDialog(ui)

    await runPalette(ui, "Open diff viewer", "opencode crashed", "10-crash-stacked")
  },
})
