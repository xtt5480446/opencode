import { describe, expect, test } from "bun:test"

const workflows = new URL("../.github/workflows/", import.meta.url)

describe("fork GitHub runner policy", () => {
  test("daily PR tests use pinned GitHub-hosted Linux and Windows runners", async () => {
    const workflow = await Bun.file(new URL("test.yml", workflows)).text()

    expect(workflow).not.toContain("blacksmith-")
    expect(workflow.match(/host: ubuntu-24\.04/g)).toHaveLength(2)
    expect(workflow.match(/host: windows-2025/g)).toHaveLength(2)
  })

  test("unit tests serialize package execution on standard runners", async () => {
    const workflow = await Bun.file(new URL("test.yml", workflows)).text()

    expect(workflow).toContain("timeout-minutes: 30\n        run: GITHUB_ACTIONS=false bun turbo test --concurrency=1")
  })

  test("process-heavy core tests allow hosted Windows startup latency", async () => {
    const pkg = await Bun.file(new URL("../packages/core/package.json", import.meta.url)).json()

    expect(pkg.scripts.test).toBe("bun test --timeout 30000 --max-concurrency=1 --only-failures")
  })

  test("duplicate detection skips forks that do not own the upstream model secret", async () => {
    const workflow = await Bun.file(new URL("pr-management.yml", workflows)).text()

    expect(workflow).not.toContain("blacksmith-")
    expect(workflow).toContain("check-duplicates:\n    if: github.repository == 'anomalyco/opencode'")
    expect(workflow).toContain("runs-on: ubuntu-24.04")
  })
})
