import { describe, expect, test } from "bun:test"

const workflows = new URL("../.github/workflows/", import.meta.url)

describe("fork GitHub runner policy", () => {
  test("stage pull requests use one focused GitHub-hosted Linux job", async () => {
    const workflow = await Bun.file(new URL("test.yml", workflows)).text()

    expect(workflow).not.toContain("blacksmith-")
    expect(workflow).toContain('pull_request:\n    branches: ["stage-*"]')
    expect(workflow).toContain("adaptive:\n    if: github.event_name == 'pull_request'\n    runs-on: ubuntu-24.04")
    expect(workflow).toContain(
      "name: Test Adaptive Task schema\n        working-directory: packages/schema\n        run: bun test ./test/adaptive-task.test.ts",
    )
    expect(workflow).toContain(
      "name: Test Adaptive Core foundation\n        working-directory: packages/core\n        run: bun test ./test/adaptive ./test/database-migration.test.ts",
    )
    expect(workflow).toContain(
      "name: Typecheck Adaptive Core foundation\n        working-directory: packages/core\n        run: bun run typecheck",
    )
  })

  test("full unit and e2e matrices remain manual or dev-only", async () => {
    const workflow = await Bun.file(new URL("test.yml", workflows)).text()

    expect(workflow.match(/if: github\.event_name != 'pull_request'/g)).toHaveLength(2)
    expect(workflow.match(/host: ubuntu-24\.04/g)).toHaveLength(2)
    expect(workflow.match(/host: windows-2025/g)).toHaveLength(2)
    expect(workflow).toContain("run: GITHUB_ACTIONS=false bun turbo test")
  })

  test("duplicate detection skips forks that do not own the upstream model secret", async () => {
    const workflow = await Bun.file(new URL("pr-management.yml", workflows)).text()

    expect(workflow).not.toContain("blacksmith-")
    expect(workflow).toContain("check-duplicates:\n    if: github.repository == 'anomalyco/opencode'")
    expect(workflow).toContain("runs-on: ubuntu-24.04")
  })
})
