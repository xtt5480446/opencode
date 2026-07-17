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
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly maxAttempts?: number
  readonly onRetry?: (attempt: number, error: Error) => void
}

type BootstrapResult = {
  readonly taskCount: number
  readonly project: ProjectRecord
}

const defaultPlansDirectory = new URL("../docs/superpowers/plans/", import.meta.url).pathname
const defaultIndexPath = new URL("../docs/superpowers/github-task-index.md", import.meta.url).pathname
const transientFailure = /\b(?:TLS|EOF|timeout|timed out|connection reset|network|502|503|504)\b/i

async function reconcileWithRetry(
  options: BootstrapOptions,
  specs: Parameters<typeof reconcileGitHub>[1],
  attempt = 1,
): ReturnType<typeof reconcileGitHub> {
  try {
    return await reconcileGitHub(options.client, specs)
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    if (attempt >= (options.maxAttempts ?? 20) || !transientFailure.test(failure.message)) throw failure
    options.onRetry?.(attempt, failure)
    await (options.sleep ?? Bun.sleep)(Math.min(attempt * 250, 2_000))
    return reconcileWithRetry(options, specs, attempt + 1)
  }
}

export async function runGitHubBootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const plansDirectory = options.plansDirectory ?? defaultPlansDirectory
  const indexPath = options.indexPath ?? defaultIndexPath
  const write = options.write ?? Bun.write
  const specs = buildTaskSpecs(await discoverTasks(plansDirectory))
  const result = await reconcileWithRetry(options, specs)
  await write(indexPath, renderGitHubIndex(specs, result.issueNumbers, result.project))
  return { taskCount: specs.length, project: result.project }
}

if (import.meta.main) {
  const result = await runGitHubBootstrap({
    client: createGitHubClient(createGhRunner()),
    onRetry: (attempt, error) => console.warn(`Transient GitHub failure after attempt ${attempt}: ${error.message}`),
  })
  console.log(`Reconciled ${result.taskCount} tasks in ${result.project.url}`)
}
