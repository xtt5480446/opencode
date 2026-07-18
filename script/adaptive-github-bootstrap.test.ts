import { describe, expect, test } from "bun:test"
import {
  buildTaskSpecs,
  desiredLabels,
  discoverTasks,
  missingByKey,
  reconcileGitHub,
  renderGitHubIndex,
  renderIssueBody,
  stageDefinitions,
} from "./adaptive-github-bootstrap-lib"
import { createGhRunner, createGitHubClient } from "./adaptive-github-bootstrap-api"
import { runGitHubBootstrap } from "./adaptive-github-bootstrap"

const plans = new URL("../docs/superpowers/plans/", import.meta.url).pathname

describe("adaptive GitHub bootstrap", () => {
  test("discovers all 59 planned tasks in stable stage/task order", async () => {
    const tasks = await discoverTasks(plans)

    expect(tasks).toHaveLength(59)
    expect(tasks.map((task) => task.key).slice(0, 3)).toEqual(["S01-T01", "S01-T02", "S01-T03"])
    expect(tasks.map((task) => task.key).slice(-3)).toEqual(["S06-T08", "S06-T09", "S06-T10"])
    expect(stageDefinitions.map((stage) => tasks.filter((task) => task.stage === stage.stage).length)).toEqual([
      10, 9, 9, 10, 11, 10,
    ])
  })

  test("builds a complete acyclic dependency graph and marks one gate per stage", async () => {
    const specs = buildTaskSpecs(await discoverTasks(plans))
    const positions = new Map(specs.map((spec, index) => [spec.key, index]))

    expect(specs).toHaveLength(59)
    for (const spec of specs) {
      expect(spec.branch).toMatch(/^s\d{2}-t\d{2}-[a-z0-9]+$/)
      expect(spec.targetBranch).toBe(`stage-${String(spec.stage).padStart(2, "0")}`)
      for (const dependency of spec.dependencies) {
        expect(positions.has(dependency)).toBe(true)
        expect(positions.get(dependency)!).toBeLessThan(positions.get(spec.key)!)
      }
    }

    const gates = specs.filter((spec) => spec.labels.includes("user-gate"))
    expect(gates.map((gate) => gate.key)).toEqual(["S01-T10", "S02-T09", "S03-T09", "S04-T10", "S05-T11", "S06-T10"])
  })

  test("renders linked dependencies, exact files, validation layer, and definition of done", async () => {
    const specs = buildTaskSpecs(await discoverTasks(plans))
    const spec = specs.find((item) => item.key === "S01-T02")!
    const body = renderIssueBody(spec, new Map([["S01-T01", 41]]))

    expect(body).toContain("Depends on: #41")
    expect(body).toContain("packages/core/src/adaptive/model-policy.ts")
    expect(body).toContain("Target branch: `stage-01`")
    expect(body).toContain("Task branch: `s01-t02-policy`")
    expect(body).toContain("## Correctness evidence")
    expect(body).toContain("## Definition of Done")
    expect(body).toContain("Closes this Issue")
    expect(body).toContain(
      "The implementation tutorial matching `docs/adaptive-runtime/tutorials/s01-t02-*.md` is added, indexed, CI-validated, and reviewed before acceptance.",
    )
  })

  test("adds one task-specific Tutorial DoD item without rewriting existing checklist state", async () => {
    const module = await import("./adaptive-github-bootstrap-lib")
    expect(module).toHaveProperty("ensureTutorialDoD")
    const ensureTutorialDoD = (
      module as typeof module & {
        ensureTutorialDoD: (body: string, key: string, state: "open" | "closed") => string
      }
    ).ensureTutorialDoD
    const existing = "## Definition of Done\n\n- [x] Existing completed item\n"
    const open = ensureTutorialDoD(existing, "S01-T03", "open")
    const closed = ensureTutorialDoD(existing, "S01-T02", "closed")

    expect(open).toContain("- [ ] The implementation tutorial")
    expect(closed).toContain("- [x] The implementation tutorial")
    expect(open).toContain("- [x] Existing completed item")
    expect(ensureTutorialDoD(open, "S01-T03", "open")).toBe(open)
    expect(
      ensureTutorialDoD(
        `${existing}- [ ] The implementation tutorial matching \`docs/adaptive-runtime/tutorials/s01-t04-*.md\` is added, indexed, CI-validated, and reviewed before acceptance.\n`,
        "S01-T03",
        "open",
      ),
    ).toContain("docs/adaptive-runtime/tutorials/s01-t03-*.md")
  })

  test("idempotent reconciliation returns only desired entries missing by exact key", () => {
    const desired = [{ name: "adaptive-runtime" }, { name: "stage:1" }, { name: "stage:2" }]
    const existing = [{ name: "stage:1" }, { name: "unrelated" }]

    expect(missingByKey(desired, existing, (item) => item.name)).toEqual([
      { name: "adaptive-runtime" },
      { name: "stage:2" },
    ])
  })

  test("reconciles milestones, labels, issues, project, and items exactly once", async () => {
    const labels: { name: string }[] = []
    const milestones: { number: number; title: string }[] = []
    const issues: {
      number: number
      nodeID: string
      title: string
      body: string
      state: "open" | "closed"
    }[] = []
    const projectItems = new Set<number>()
    let project: { id: string; number: number; url: string } | undefined
    let projectUpdates = 0

    const client = {
      listLabels: async () => labels,
      createLabel: async (input: { name: string }) => void labels.push({ name: input.name }),
      listMilestones: async () => milestones,
      createMilestone: async (input: { title: string }) => {
        const value = { number: milestones.length + 1, title: input.title }
        milestones.push(value)
        return value
      },
      listIssues: async () => issues,
      createIssue: async (input: { title: string; body: string }) => {
        const number = issues.length + 1
        const value = {
          number,
          nodeID: `issue-${number}`,
          title: input.title,
          body: input.body,
          state: "open" as const,
        }
        issues.push(value)
        return value
      },
      updateIssue: async () => {
        throw new Error("unexpected issue update")
      },
      getProject: async () => project,
      createProject: async () => {
        project = { id: "project-1", number: 1, url: "https://github.com/users/xtt5480446/projects/1" }
        projectUpdates++
        return project
      },
      updateProject: async () => {
        projectUpdates++
      },
      listProjectIssueNumbers: async () => projectItems,
      addProjectItems: async (_projectID: string, input: readonly { number: number }[]) => {
        for (const issue of input) projectItems.add(issue.number)
      },
    }

    const specs = buildTaskSpecs(await discoverTasks(plans))
    const first = await reconcileGitHub(client, specs)
    const second = await reconcileGitHub(client, specs)

    expect(labels).toHaveLength(desiredLabels.length)
    expect(milestones).toHaveLength(6)
    expect(issues).toHaveLength(59)
    expect(projectItems.size).toBe(59)
    expect(first.project.url).toBe("https://github.com/users/xtt5480446/projects/1")
    expect(second.issueNumbers).toEqual(first.issueNumbers)
    expect(issues[1]!.body).toContain("Depends on: #1")
    expect(projectUpdates).toBe(2)
  })

  test("incrementally reconciles Tutorial DoD into all existing task Issues exactly once", async () => {
    const specs = buildTaskSpecs(await discoverTasks(plans))
    const issues = specs.map((spec, index) => ({
      number: index + 1,
      nodeID: `issue-${index + 1}`,
      title: `[${spec.key}] ${spec.title}`,
      body: `<!-- adaptive-runtime-task:${spec.key} -->\n\n## Definition of Done\n\n- [x] Existing completed item\n`,
      state: index < 2 ? ("closed" as const) : ("open" as const),
    }))
    const updates: number[] = []
    const project = { id: "project-1", number: 1, url: "https://example.test/project" }
    const client = {
      listLabels: async () => desiredLabels,
      createLabel: async () => {},
      listMilestones: async () =>
        stageDefinitions.map((stage, index) => ({ number: index + 1, title: stage.milestone })),
      createMilestone: async () => {
        throw new Error("unexpected milestone creation")
      },
      listIssues: async () => issues,
      createIssue: async () => {
        throw new Error("unexpected issue creation")
      },
      updateIssue: async (number: number, input: { readonly body: string }) => {
        updates.push(number)
        issues[number - 1]!.body = input.body
        return issues[number - 1]!
      },
      getProject: async () => project,
      createProject: async () => {
        throw new Error("unexpected project creation")
      },
      updateProject: async () => {},
      listProjectIssueNumbers: async () => new Set(issues.map((issue) => issue.number)),
      addProjectItems: async () => {},
    }

    await reconcileGitHub(client, specs)
    await reconcileGitHub(client, specs)

    expect(updates).toHaveLength(59)
    expect(issues[0]!.body).toContain("- [x] The implementation tutorial")
    expect(issues[1]!.body).toContain("- [x] The implementation tutorial")
    expect(issues[2]!.body).toContain("- [ ] The implementation tutorial")
    expect(issues[58]!.body).toContain("- [ ] The implementation tutorial")
    expect(issues.every((issue) => issue.body.includes("- [x] Existing completed item"))).toBe(true)
  })

  test("renders a stable 59-row GitHub task index", async () => {
    const specs = buildTaskSpecs(await discoverTasks(plans))
    const issueNumbers = new Map(specs.map((spec, index) => [spec.key, index + 101]))
    const index = renderGitHubIndex(specs, issueNumbers, {
      id: "project-1",
      number: 7,
      url: "https://github.com/users/xtt5480446/projects/7",
    })

    expect(index).toContain("Project: https://github.com/users/xtt5480446/projects/7")
    expect(index.match(/^\| S\d{2}-T\d{2} /gm)).toHaveLength(59)
    expect(index).toContain("| S01-T01 | [#101]")
    expect(index).toContain("| S06-T10 | [#159]")
    const tableLines = index.split("\n").filter((line) => line.startsWith("|"))
    expect(new Set(tableLines.map((line) => line.length)).size).toBe(1)
  })

  test("GitHub API adapter filters pull requests, finds the project, and batches project items", async () => {
    const calls: { args: readonly string[]; input?: unknown }[] = []
    const runner = async (args: readonly string[], input?: unknown) => {
      calls.push({ args, input })
      const command = args.join(" ")
      if (command.includes("/issues?")) {
        return [
          { number: 1, node_id: "I_1", title: "issue", body: "body", state: "open" },
          { number: 2, node_id: "PR_2", title: "pull", body: "body", state: "open", pull_request: {} },
        ]
      }
      if (command === "api graphql --input -" && JSON.stringify(input).includes("projectsV2")) {
        return {
          data: {
            viewer: {
              id: "user-1",
              projectsV2: {
                nodes: [
                  { id: "other", number: 1, title: "Other", url: "https://example.test/1" },
                  {
                    id: "project-7",
                    number: 7,
                    title: "Adaptive Runtime Commercial V1",
                    url: "https://github.com/users/xtt5480446/projects/7",
                  },
                ],
              },
            },
          },
        }
      }
      if (command === "api graphql --input -" && JSON.stringify(input).includes("addProjectV2ItemById")) {
        return { data: {} }
      }
      throw new Error(`Unexpected command: ${command}`)
    }
    const client = createGitHubClient(runner)

    expect(await client.listIssues()).toEqual([
      { number: 1, nodeID: "I_1", title: "issue", body: "body", state: "open" },
    ])
    expect((await client.getProject())?.number).toBe(7)
    await client.addProjectItems(
      "project-7",
      Array.from({ length: 21 }, (_, index) => ({ number: index + 1, nodeID: `I_${index + 1}` })),
    )

    const additions = calls.filter((call) => JSON.stringify(call.input ?? "").includes("addProjectV2ItemById"))
    expect(additions).toHaveLength(2)
  })

  test("GitHub API adapter lists and creates labels through REST", async () => {
    const calls: { args: readonly string[]; input?: unknown }[] = []
    const client = createGitHubClient(async (args, input) => {
      calls.push({ args, input })
      if (args.includes("--method")) return { name: "stage:1" }
      return [[{ name: "adaptive-runtime" }], [{ name: "stage:1" }]]
    })

    expect(await client.listLabels()).toEqual([{ name: "adaptive-runtime" }, { name: "stage:1" }])
    await client.createLabel({ name: "user-gate", color: "B60205", description: "Requires acceptance" })

    expect(calls[0]!.args).toContain("--slurp")
    expect(calls[1]).toEqual({
      args: ["api", "--method", "POST", "repos/xtt5480446/opencode/labels", "--input", "-"],
      input: { name: "user-gate", color: "B60205", description: "Requires acceptance" },
    })
  })

  test("GitHub API adapter lists and creates milestones through REST", async () => {
    const calls: { args: readonly string[]; input?: unknown }[] = []
    const client = createGitHubClient(async (args, input) => {
      calls.push({ args, input })
      if (args.includes("--method")) return { number: 6, title: "G6" }
      return [[{ number: 1, title: "G1" }], [{ number: 2, title: "G2" }]]
    })

    expect(await client.listMilestones()).toEqual([
      { number: 1, title: "G1" },
      { number: 2, title: "G2" },
    ])
    expect(await client.createMilestone({ title: "G6", description: "Commercial hardening" })).toEqual({
      number: 6,
      title: "G6",
    })
    expect(calls[1]).toEqual({
      args: ["api", "--method", "POST", "repos/xtt5480446/opencode/milestones", "--input", "-"],
      input: { title: "G6", description: "Commercial hardening" },
    })
  })

  test("GitHub API adapter creates issues with labels and a milestone through REST", async () => {
    const calls: { args: readonly string[]; input?: unknown }[] = []
    const client = createGitHubClient(async (args, input) => {
      calls.push({ args, input })
      return { number: 42, node_id: "I_42", title: "[S01-T01] Schema", body: "Task body", state: "open" }
    })

    expect(
      await client.createIssue({
        title: "[S01-T01] Schema",
        body: "Task body",
        labels: ["adaptive-runtime", "stage:1"],
        milestone: 1,
      }),
    ).toEqual({ number: 42, nodeID: "I_42", title: "[S01-T01] Schema", body: "Task body", state: "open" })
    expect(calls).toEqual([
      {
        args: ["api", "--method", "POST", "repos/xtt5480446/opencode/issues", "--input", "-"],
        input: {
          title: "[S01-T01] Schema",
          body: "Task body",
          labels: ["adaptive-runtime", "stage:1"],
          milestone: 1,
        },
      },
    ])
  })

  test("GitHub API adapter updates only an Issue body through REST", async () => {
    const calls: { args: readonly string[]; input?: unknown }[] = []
    const client = createGitHubClient(async (args, input) => {
      calls.push({ args, input })
      return { number: 42, node_id: "I_42", title: "[S01-T01] Schema", body: "updated", state: "open" }
    })
    const updateIssue = (
      client as typeof client & {
        updateIssue: (number: number, input: { readonly body: string }) => Promise<unknown>
      }
    ).updateIssue
    expect(updateIssue).toBeFunction()

    expect(await updateIssue(42, { body: "updated" })).toEqual({
      number: 42,
      nodeID: "I_42",
      title: "[S01-T01] Schema",
      body: "updated",
      state: "open",
    })
    expect(calls).toEqual([
      {
        args: ["api", "--method", "PATCH", "repos/xtt5480446/opencode/issues/42", "--input", "-"],
        input: { body: "updated" },
      },
    ])
  })

  test("GitHub API adapter flattens paginated issue responses", async () => {
    let requestedArgs: readonly string[] = []
    const client = createGitHubClient(async (args) => {
      requestedArgs = args
      return [
        [{ number: 1, node_id: "I_1", title: "first", body: "one", state: "open" }],
        [{ number: 2, node_id: "I_2", title: "second", body: "two", state: "closed" }],
      ]
    })

    expect(await client.listIssues()).toEqual([
      { number: 1, nodeID: "I_1", title: "first", body: "one", state: "open" },
      { number: 2, nodeID: "I_2", title: "second", body: "two", state: "closed" },
    ])
    expect(requestedArgs).toContain("--slurp")
  })

  test("GitHub API adapter creates and configures a user Project v2", async () => {
    const calls: unknown[] = []
    const client = createGitHubClient(async (_args, input) => {
      calls.push(input)
      const query = JSON.stringify(input)
      if (query.includes("createProjectV2")) {
        return {
          data: {
            createProjectV2: {
              projectV2: {
                id: "project-7",
                number: 7,
                url: "https://github.com/users/xtt5480446/projects/7",
              },
            },
          },
        }
      }
      if (query.includes("updateProjectV2")) return { data: { updateProjectV2: { projectV2: { id: "project-7" } } } }
      return { data: { viewer: { id: "user-1" } } }
    })

    expect(
      await client.createProject({
        title: "Adaptive Runtime Commercial V1",
        shortDescription: "Execution board",
        readme: "Authoritative work items",
      }),
    ).toEqual({
      id: "project-7",
      number: 7,
      url: "https://github.com/users/xtt5480446/projects/7",
    })
    expect(calls).toHaveLength(3)
    const update = calls.find((input) => JSON.stringify(input).includes("updateProjectV2"))
    expect(JSON.stringify(update)).toContain("projectId: $projectId")
    expect(JSON.stringify(update)).not.toContain("projectV2Id")
  })

  test("GitHub API adapter reads repository issue numbers from every Project page", async () => {
    const calls: unknown[] = []
    const client = createGitHubClient(async (_args, input) => {
      calls.push(input)
      const after = (input as { variables?: { after?: string | null } }).variables?.after
      if (!after) {
        return {
          data: {
            node: {
              items: {
                nodes: [
                  { content: { number: 1, repository: { nameWithOwner: "xtt5480446/opencode" } } },
                  { content: { number: 99, repository: { nameWithOwner: "someone/else" } } },
                  { content: null },
                ],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          },
        }
      }
      return {
        data: {
          node: {
            items: {
              nodes: [{ content: { number: 2, repository: { nameWithOwner: "xtt5480446/opencode" } } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }
    })

    expect(await client.listProjectIssueNumbers("project-7")).toEqual(new Set([1, 2]))
    expect(calls).toHaveLength(2)
  })

  test("gh runner retries transient transport failures and parses JSON without environment tokens", async () => {
    const executions: { binary: string; args: readonly string[]; stdin?: string }[] = []
    let attempts = 0
    const runner = createGhRunner({
      binary: "/home/xtt/.local/bin/gh",
      execute: async (binary, args, stdin) => {
        executions.push({ binary, args, stdin })
        attempts++
        if (attempts === 1) return { exitCode: 1, stdout: "", stderr: "TLS handshake EOF" }
        return { exitCode: 0, stdout: '{"ok":true}', stderr: "" }
      },
      sleep: async () => {},
    })

    expect(await runner(["api", "graphql", "--input", "-"], { query: "query { viewer { id } }" })).toEqual({
      ok: true,
    })
    expect(executions).toHaveLength(2)
    expect(executions[1]).toEqual({
      binary: "/home/xtt/.local/bin/gh",
      args: ["api", "graphql", "--input", "-"],
      stdin: '{"query":"query { viewer { id } }"}',
    })
  })

  test("gh runner does not retry an ambiguous write failure", async () => {
    let attempts = 0
    const runner = createGhRunner({
      execute: async () => {
        attempts++
        return { exitCode: 1, stdout: "", stderr: "TLS connection closed with EOF" }
      },
      sleep: async () => {},
    })

    await expect(
      runner(["api", "--method", "POST", "repos/xtt5480446/opencode/issues", "--input", "-"], {
        title: "task",
      }),
    ).rejects.toThrow("TLS connection closed with EOF")
    expect(attempts).toBe(1)
  })

  test("executable bootstrap writes an index from reconciled GitHub identifiers", async () => {
    const specs = buildTaskSpecs(await discoverTasks(plans))
    const issues = specs.map((spec, index) => ({
      number: index + 101,
      nodeID: `I_${index + 101}`,
      title: `[${spec.key}] ${spec.title}`,
      body: `<!-- adaptive-runtime-task:${spec.key} -->\n\n## Definition of Done\n\n- [x] Existing completed item\n`,
      state: "open" as const,
    }))
    const project = {
      id: "project-7",
      number: 7,
      url: "https://github.com/users/xtt5480446/projects/7",
    }
    let written: { path: string; content: string } | undefined
    let projectUpdates = 0
    const client = {
      listLabels: async () => desiredLabels,
      createLabel: async () => {
        throw new Error("unexpected label creation")
      },
      listMilestones: async () =>
        stageDefinitions.map((stage, index) => ({ number: index + 1, title: stage.milestone })),
      createMilestone: async () => {
        throw new Error("unexpected milestone creation")
      },
      listIssues: async () => issues,
      createIssue: async () => {
        throw new Error("unexpected issue creation")
      },
      updateIssue: async (number: number, input: { readonly body: string }) => {
        const issue = issues.find((item) => item.number === number)!
        issue.body = input.body
        return issue
      },
      getProject: async () => project,
      createProject: async () => {
        throw new Error("unexpected project creation")
      },
      updateProject: async () => {
        projectUpdates++
        if (projectUpdates === 1) throw new Error("TLS handshake timeout")
      },
      listProjectIssueNumbers: async () => new Set(issues.map((issue) => issue.number)),
      addProjectItems: async () => {
        throw new Error("unexpected Project item creation")
      },
    }

    const result = await runGitHubBootstrap({
      client,
      plansDirectory: plans,
      indexPath: "/tmp/github-task-index.md",
      write: async (path, content) => {
        written = { path, content }
      },
      sleep: async () => {},
    })

    expect(result.taskCount).toBe(59)
    expect(result.project).toEqual(project)
    expect(written?.path).toBe("/tmp/github-task-index.md")
    expect(written?.content.match(/^\| S\d{2}-T\d{2} /gm)).toHaveLength(59)
    expect(projectUpdates).toBe(2)
  })
})
