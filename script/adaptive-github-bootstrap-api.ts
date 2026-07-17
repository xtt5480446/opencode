import type { GitHubBootstrapClient, IssueRecord, ProjectRecord } from "./adaptive-github-bootstrap-lib"
import { projectTitle } from "./adaptive-github-bootstrap-lib"

export type GhRunner = (args: readonly string[], input?: unknown) => Promise<unknown>

type GhExecution = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

type GhExecutor = (binary: string, args: readonly string[], stdin?: string) => Promise<GhExecution>

type GhRunnerOptions = {
  readonly binary?: string
  readonly execute?: GhExecutor
  readonly sleep?: (milliseconds: number) => Promise<void>
}

const repository = "xtt5480446/opencode"
const transientFailure = /\b(?:TLS|EOF|timeout|timed out|connection reset|network|502|503|504)\b/i

async function executeGh(binary: string, args: readonly string[], stdin?: string): Promise<GhExecution> {
  const child = Bun.spawn([binary, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (stdin !== undefined) child.stdin.write(stdin)
  child.stdin.end()
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

export function createGhRunner(options: GhRunnerOptions = {}): GhRunner {
  const binary = options.binary ?? Bun.which("gh") ?? `${process.env.HOME ?? "/home/xtt"}/.local/bin/gh`
  const execute = options.execute ?? executeGh
  const sleep = options.sleep ?? Bun.sleep

  return async (args, input) => {
    const stdin = input === undefined ? undefined : JSON.stringify(input)
    const query = input && typeof input === "object" ? (input as Record<string, unknown>).query : undefined
    const canRetry =
      !args.includes("--method") && (args[1] !== "graphql" || (typeof query === "string" && /^\s*query\b/.test(query)))
    for (let attempt = 1; attempt <= 3; attempt++) {
      let execution: GhExecution
      try {
        execution = await execute(binary, args, stdin)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (attempt === 3 || !canRetry || !transientFailure.test(message)) throw error
        await sleep(250 * attempt)
        continue
      }
      if (execution.exitCode === 0) {
        const output = execution.stdout.trim()
        return output ? JSON.parse(output) : undefined
      }
      const message = execution.stderr.trim() || `gh exited with status ${execution.exitCode}`
      if (attempt === 3 || !canRetry || !transientFailure.test(message)) throw new Error(message)
      await sleep(250 * attempt)
    }
    throw new Error("gh retry loop exhausted")
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub returned an invalid response")
  }
  return value as Record<string, unknown>
}

function valueAt(value: unknown, ...path: readonly string[]): unknown {
  return path.reduce((current, key) => asRecord(current)[key], value)
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string") throw new Error(`GitHub response is missing ${field}`)
  return value
}

function requireNumber(value: unknown, field: string) {
  if (typeof value !== "number") throw new Error(`GitHub response is missing ${field}`)
  return value
}

function issueFromAPI(value: unknown): IssueRecord {
  const issue = asRecord(value)
  return {
    number: requireNumber(issue.number, "issue.number"),
    nodeID: requireString(issue.node_id, "issue.node_id"),
    title: requireString(issue.title, "issue.title"),
    body: typeof issue.body === "string" ? issue.body : "",
  }
}

function paginatedValues(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((page) => (Array.isArray(page) ? page : [page]))
}

function batches<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size))
  }
  return result
}

export function createGitHubClient(runner: GhRunner): GitHubBootstrapClient {
  return {
    listLabels: async () => {
      const response = await runner(["api", `repos/${repository}/labels?per_page=100`, "--paginate", "--slurp"])
      return paginatedValues(response).map((value) => ({
        name: requireString(asRecord(value).name, "label.name"),
      }))
    },
    createLabel: async (input) => {
      await runner(["api", "--method", "POST", `repos/${repository}/labels`, "--input", "-"], input)
    },
    listMilestones: async () => {
      const response = await runner([
        "api",
        `repos/${repository}/milestones?state=all&per_page=100`,
        "--paginate",
        "--slurp",
      ])
      return paginatedValues(response).map((value) => {
        const milestone = asRecord(value)
        return {
          number: requireNumber(milestone.number, "milestone.number"),
          title: requireString(milestone.title, "milestone.title"),
        }
      })
    },
    createMilestone: async (input) => {
      const response = asRecord(
        await runner(["api", "--method", "POST", `repos/${repository}/milestones`, "--input", "-"], input),
      )
      return {
        number: requireNumber(response.number, "milestone.number"),
        title: requireString(response.title, "milestone.title"),
      }
    },
    listIssues: async () => {
      const response = await runner([
        "api",
        `repos/${repository}/issues?state=all&per_page=100`,
        "--paginate",
        "--slurp",
      ])
      const issues = paginatedValues(response)
      return issues.filter((issue) => !asRecord(issue).pull_request).map(issueFromAPI)
    },
    createIssue: async (input) => {
      return issueFromAPI(
        await runner(["api", "--method", "POST", `repos/${repository}/issues`, "--input", "-"], input),
      )
    },
    getProject: async () => {
      const response = asRecord(
        await runner(["api", "graphql", "--input", "-"], {
          query: `query { viewer { id projectsV2(first: 100) { nodes { id number title url } } } }`,
        }),
      )
      const projects = valueAt(response, "data", "viewer", "projectsV2", "nodes")
      const project = Array.isArray(projects)
        ? projects.find((item) => asRecord(item).title === projectTitle)
        : undefined
      if (!project) return undefined
      const value = asRecord(project)
      return {
        id: requireString(value.id, "project.id"),
        number: requireNumber(value.number, "project.number"),
        url: requireString(value.url, "project.url"),
      } satisfies ProjectRecord
    },
    createProject: async (input) => {
      const viewerResponse = asRecord(
        await runner(["api", "graphql", "--input", "-"], {
          query: "query { viewer { id } }",
        }),
      )
      const ownerID = requireString(valueAt(viewerResponse, "data", "viewer", "id"), "viewer.id")

      const createResponse = asRecord(
        await runner(["api", "graphql", "--input", "-"], {
          query:
            "mutation($ownerId: ID!, $title: String!) { createProjectV2(input: { ownerId: $ownerId, title: $title }) { projectV2 { id number url } } }",
          variables: { ownerId: ownerID, title: input.title },
        }),
      )
      const value = valueAt(createResponse, "data", "createProjectV2", "projectV2")
      if (!value) throw new Error("GitHub did not return the created Project")
      const project = asRecord(value)
      const projectID = requireString(project.id, "project.id")

      await runner(["api", "graphql", "--input", "-"], {
        query:
          "mutation($projectId: ID!, $shortDescription: String!, $readme: String!) { updateProjectV2(input: { projectV2Id: $projectId, shortDescription: $shortDescription, readme: $readme }) { projectV2 { id } } }",
        variables: {
          projectId: projectID,
          shortDescription: input.shortDescription,
          readme: input.readme,
        },
      })

      return {
        id: projectID,
        number: requireNumber(project.number, "project.number"),
        url: requireString(project.url, "project.url"),
      }
    },
    listProjectIssueNumbers: async (projectID) => {
      const result = new Set<number>()
      let after: string | null = null
      while (true) {
        const response = asRecord(
          await runner(["api", "graphql", "--input", "-"], {
            query:
              "query($projectId: ID!, $after: String) { node(id: $projectId) { ... on ProjectV2 { items(first: 100, after: $after) { nodes { content { ... on Issue { number repository { nameWithOwner } } } } pageInfo { hasNextPage endCursor } } } } }",
            variables: { projectId: projectID, after },
          }),
        )
        const items = asRecord(valueAt(response, "data", "node", "items"))
        if (!Array.isArray(items.nodes)) throw new Error("GitHub Project items are missing")
        for (const item of items.nodes) {
          const content = asRecord(item).content
          if (!content) continue
          const issue = asRecord(content)
          const issueRepository = issue.repository ? asRecord(issue.repository) : undefined
          if (issueRepository?.nameWithOwner === repository && typeof issue.number === "number") {
            result.add(issue.number)
          }
        }
        const pageInfo = asRecord(items.pageInfo)
        if (pageInfo.hasNextPage !== true) break
        after = requireString(pageInfo.endCursor, "project.items.pageInfo.endCursor")
      }
      return result
    },
    addProjectItems: async (projectID, issues) => {
      for (const group of batches(issues, 20)) {
        const fields = group
          .map(
            (_, index) =>
              `item${index}: addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId${index} }) { item { id } }`,
          )
          .join("\n")
        await runner(["api", "graphql", "--input", "-"], {
          query: `mutation(${["$projectId: ID!", ...group.map((_, index) => `$contentId${index}: ID!`)].join(
            ", ",
          )}) { ${fields} }`,
          variables: Object.fromEntries([
            ["projectId", projectID],
            ...group.map((issue, index) => [`contentId${index}`, issue.nodeID]),
          ]),
        })
      }
    },
  }
}
