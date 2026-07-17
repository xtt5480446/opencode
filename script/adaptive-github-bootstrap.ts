import { createGhRunner, createGitHubClient } from "./adaptive-github-bootstrap-api"
import {
  buildTaskSpecs,
  discoverTasks,
  reconcileGitHub,
  renderGitHubIndex,
  type GitHubBootstrapClient,
  type ProjectRecord,
} from "./adaptive-github-bootstrap-lib"

type BootstrapOptions = {
  readonly client: GitHubBootstrapClient
  readonly plansDirectory?: string
  readonly indexPath?: string
  readonly write?: (path: string, content: string) => Promise<unknown>
}

type BootstrapResult = {
  readonly taskCount: number
  readonly project: ProjectRecord
}

const defaultPlansDirectory = new URL("../docs/superpowers/plans/", import.meta.url).pathname
const defaultIndexPath = new URL("../docs/superpowers/github-task-index.md", import.meta.url).pathname

export async function runGitHubBootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const plansDirectory = options.plansDirectory ?? defaultPlansDirectory
  const indexPath = options.indexPath ?? defaultIndexPath
  const write = options.write ?? Bun.write
  const specs = buildTaskSpecs(await discoverTasks(plansDirectory))
  const result = await reconcileGitHub(options.client, specs)
  await write(indexPath, renderGitHubIndex(specs, result.issueNumbers, result.project))
  return { taskCount: specs.length, project: result.project }
}

if (import.meta.main) {
  const result = await runGitHubBootstrap({
    client: createGitHubClient(createGhRunner()),
  })
  console.log(`Reconciled ${result.taskCount} tasks in ${result.project.url}`)
}
