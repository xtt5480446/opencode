import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/TerminalTabSwitch"
const projectID = "proj_terminal_tab_switch"
const sessionA = "ses_terminal_tab_a"
const sessionB = "ses_terminal_tab_b"
const titleA = "Alpha session"
const titleB = "Beta session"
const ptyID = "pty_tab_switch"

test.use({ viewport: { width: 1440, height: 900 } })

// Terminals are workspace-scoped: switching between session tabs in the same
// workspace must keep the terminal mounted and its PTY connection open instead
// of tearing it down and reconnecting.
test("keeps the terminal session alive when switching session tabs in a workspace", async ({ page }) => {
  const connections: string[] = []
  await setup(page, connections)

  await page.goto(sessionHref(sessionA))
  await expectSessionTitle(page, titleA)

  await page.keyboard.press("Control+Backquote")
  const terminal = page.locator('[data-component="terminal"]')
  await expect(terminal).toBeVisible()
  await expect.poll(() => connections.length).toBe(1)
  await terminal.evaluate((el) => {
    ;(el as HTMLElement & { __e2eProbe?: string }).__e2eProbe = "original"
  })

  await switchTab(page, titleB)
  await expectSessionTitle(page, titleB)
  await expect(terminal).toBeVisible()
  expect(await probe(page)).toBe("original")
  expect(connections.length).toBe(1)

  await switchTab(page, titleA)
  await expectSessionTitle(page, titleA)
  await expect(terminal).toBeVisible()
  expect(await probe(page)).toBe("original")
  expect(connections.length).toBe(1)
})

async function switchTab(page: Page, title: string) {
  await page.locator("[data-titlebar-tab-slot]", { hasText: title }).click()
}

async function probe(page: Page) {
  return page
    .locator('[data-component="terminal"]')
    .evaluate((el) => (el as HTMLElement & { __e2eProbe?: string }).__e2eProbe)
}

async function setup(page: Page, connections: string[]) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "terminal-tab-switch",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "test" },
    },
    sessions: [session(sessionA, titleA, 1700000000000), session(sessionB, titleB, 1700000001000)],
    pageMessages: () => ({ items: [] }),
  })
  await page.route("**/pty", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: ptyID, title: "Terminal 1" }),
    }),
  )
  await page.route(`**/pty/${ptyID}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  )
  await page.route(`**/pty/${ptyID}/connect-token*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ ticket: "e2e-ticket" }),
    }),
  )
  await page.routeWebSocket(new RegExp(`/pty/${ptyID}/connect`), (ws) => {
    connections.push(ws.url())
  })

  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.addInitScript(
    ({ directory, server, sessions }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
      localStorage.setItem(
        "opencode.window.browser.dat:tabs",
        JSON.stringify(sessions.map((sessionId: string) => ({ type: "session", server, sessionId }))),
      )
    },
    { directory, server, sessions: [sessionA, sessionB] },
  )
}

function session(id: string, title: string, created: number) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created, updated: created },
  }
}

function sessionHref(sessionID: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}
