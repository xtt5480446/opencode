import { createGhRunner, type GhRunner } from "./adaptive-github-bootstrap-api"

const repository = "xtt5480446/opencode"

export const desiredRuleset = {
  name: "adaptive-stage-tutorial",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: {
    ref_name: {
      include: ["refs/heads/stage-*"],
      exclude: [],
    },
  },
  rules: [
    {
      type: "pull_request",
      parameters: {
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_approving_review_count: 0,
        required_review_thread_resolution: false,
        automatic_copilot_code_review_enabled: false,
        allowed_merge_methods: ["merge", "squash", "rebase"],
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: [{ context: "adaptive-tutorial" }],
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: true,
      },
    },
  ],
} as const

export type DesiredRuleset = typeof desiredRuleset

export type RulesetRecord = {
  readonly id: number
  readonly name: string
  readonly target: string
  readonly enforcement: string
  readonly conditions: unknown
  readonly rules: readonly unknown[]
  readonly [key: string]: unknown
}

export interface RulesetClient {
  readonly list: () => Promise<readonly RulesetRecord[]>
  readonly create: (input: DesiredRuleset) => Promise<void>
  readonly update: (id: number, input: DesiredRuleset) => Promise<void>
}

export async function reconcileRuleset(client: RulesetClient): Promise<"created" | "updated" | "unchanged"> {
  const current = (await client.list()).find((ruleset) => ruleset.name === desiredRuleset.name)
  if (!current) {
    await client.create(desiredRuleset)
    return "created"
  }
  if (JSON.stringify(policy(current)) === JSON.stringify(policy(desiredRuleset))) return "unchanged"
  await client.update(current.id, desiredRuleset)
  return "updated"
}

export function createRulesetClient(runner: GhRunner): RulesetClient {
  return {
    list: async () => {
      const summaries = await runner(["api", `repos/${repository}/rulesets`])
      if (!Array.isArray(summaries)) throw new Error("GitHub returned invalid repository rulesets")
      return Promise.all(
        summaries.map(async (summary) => {
          const id = numberField(record(summary), "id")
          return ruleset(await runner(["api", `repos/${repository}/rulesets/${id}`]))
        }),
      )
    },
    create: async (input) => {
      await runner(["api", "--method", "POST", `repos/${repository}/rulesets`, "--input", "-"], input)
    },
    update: async (id, input) => {
      await runner(["api", "--method", "PUT", `repos/${repository}/rulesets/${id}`, "--input", "-"], input)
    },
  }
}

function policy(input: Record<string, unknown>) {
  const conditions = record(input.conditions)
  const refName = record(conditions.ref_name)
  const rules = Array.isArray(input.rules) ? input.rules.map(record) : []
  return {
    name: input.name,
    target: input.target,
    enforcement: input.enforcement,
    bypass_actors: Array.isArray(input.bypass_actors) ? input.bypass_actors : [],
    conditions: {
      ref_name: {
        include: strings(refName.include),
        exclude: strings(refName.exclude),
      },
    },
    rules: rules
      .map((rule) => {
        if (rule.type === "pull_request") {
          return { type: rule.type, parameters: pullRequestPolicy(record(rule.parameters)) }
        }
        if (rule.type === "required_status_checks") {
          return { type: rule.type, parameters: statusCheckPolicy(record(rule.parameters)) }
        }
        return { type: rule.type, parameters: rule.parameters }
      })
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  }
}

function pullRequestPolicy(parameters: Record<string, unknown>) {
  return {
    dismiss_stale_reviews_on_push: parameters.dismiss_stale_reviews_on_push,
    require_code_owner_review: parameters.require_code_owner_review,
    require_last_push_approval: parameters.require_last_push_approval,
    required_approving_review_count: parameters.required_approving_review_count,
    required_review_thread_resolution: parameters.required_review_thread_resolution,
    automatic_copilot_code_review_enabled:
      parameters.automatic_copilot_code_review_enabled === undefined
        ? false
        : parameters.automatic_copilot_code_review_enabled,
    allowed_merge_methods: strings(parameters.allowed_merge_methods),
  }
}

function statusCheckPolicy(parameters: Record<string, unknown>) {
  const checks = Array.isArray(parameters.required_status_checks)
    ? parameters.required_status_checks.map((check) => {
        const value = record(check)
        return {
          context: value.context,
          integration_id: typeof value.integration_id === "number" ? value.integration_id : null,
        }
      })
    : []
  return {
    required_status_checks: checks,
    strict_required_status_checks_policy: parameters.strict_required_status_checks_policy,
    do_not_enforce_on_create: parameters.do_not_enforce_on_create,
  }
}

function ruleset(value: unknown): RulesetRecord {
  const input = record(value)
  return {
    ...input,
    id: numberField(input, "id"),
    name: stringField(input, "name"),
    target: stringField(input, "target"),
    enforcement: stringField(input, "enforcement"),
    conditions: input.conditions,
    rules: Array.isArray(input.rules) ? input.rules : [],
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned invalid ruleset data")
  return value as Record<string, unknown>
}

function stringField(input: Record<string, unknown>, field: string) {
  const value = input[field]
  if (typeof value !== "string") throw new Error(`GitHub ruleset is missing ${field}`)
  return value
}

function numberField(input: Record<string, unknown>, field: string) {
  const value = input[field]
  if (typeof value !== "number") throw new Error(`GitHub ruleset is missing ${field}`)
  return value
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

if (import.meta.main) {
  console.log(await reconcileRuleset(createRulesetClient(createGhRunner())))
}
