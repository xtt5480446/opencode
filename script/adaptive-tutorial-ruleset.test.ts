import { describe, expect, test } from "bun:test"
import {
  createRulesetClient,
  desiredRuleset,
  reconcileRuleset,
  type DesiredRuleset,
  type RulesetRecord,
} from "./adaptive-tutorial-ruleset"

describe("adaptive tutorial ruleset", () => {
  test("defines the exact active stage branch protection policy", () => {
    expect(desiredRuleset).toMatchObject({
      name: "adaptive-stage-tutorial",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/heads/stage-*"], exclude: [] } },
    })
    expect(desiredRuleset.rules).toContainEqual(expect.objectContaining({ type: "pull_request" }))
    expect(desiredRuleset.rules).toContainEqual({
      type: "required_status_checks",
      parameters: {
        required_status_checks: [{ context: "adaptive-tutorial" }],
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: true,
      },
    })
  })

  test("creates the ruleset when it is absent", async () => {
    const created: DesiredRuleset[] = []
    expect(
      await reconcileRuleset({
        list: async () => [],
        create: async (input) => void created.push(input),
        update: async () => {
          throw new Error("unexpected update")
        },
      }),
    ).toBe("created")
    expect(created).toEqual([desiredRuleset])
  })

  test("does nothing when the live ruleset has equivalent policy", async () => {
    let writes = 0
    const live = {
      id: 7,
      ...desiredRuleset,
      source_type: "Repository",
      rules: desiredRuleset.rules.map((rule) =>
        rule.type === "required_status_checks"
          ? {
              ...rule,
              parameters: {
                ...rule.parameters,
                required_status_checks: [{ context: "adaptive-tutorial", integration_id: null }],
              },
            }
          : rule,
      ),
    } as RulesetRecord

    expect(
      await reconcileRuleset({
        list: async () => [live],
        create: async () => void writes++,
        update: async () => void writes++,
      }),
    ).toBe("unchanged")
    expect(writes).toBe(0)
  })

  test("updates drifted policy without creating a duplicate", async () => {
    const updates: { id: number; input: DesiredRuleset }[] = []
    expect(
      await reconcileRuleset({
        list: async () => [{ id: 7, ...desiredRuleset, enforcement: "disabled" }],
        create: async () => {
          throw new Error("unexpected create")
        },
        update: async (id, input) => void updates.push({ id, input }),
      }),
    ).toBe("updated")
    expect(updates).toEqual([{ id: 7, input: desiredRuleset }])
  })

  test("GitHub adapter reads full rulesets and sends exact create/update payloads", async () => {
    const calls: { args: readonly string[]; input?: unknown }[] = []
    const runner = async (args: readonly string[], input?: unknown) => {
      calls.push({ args, input })
      const endpoint = args.find((value) => value.startsWith("repos/"))
      if (endpoint?.endsWith("/rulesets")) {
        if (args.includes("--method")) return { id: 8, ...desiredRuleset }
        return [{ id: 7, name: desiredRuleset.name }]
      }
      if (endpoint?.endsWith("/rulesets/7")) return { id: 7, ...desiredRuleset }
      if (endpoint?.endsWith("/rulesets/8")) return { id: 8, ...desiredRuleset }
      throw new Error(`Unexpected endpoint: ${endpoint}`)
    }
    const client = createRulesetClient(runner)

    expect(await client.list()).toEqual([{ id: 7, ...desiredRuleset }])
    await client.create(desiredRuleset)
    await client.update(8, desiredRuleset)

    expect(calls).toContainEqual({
      args: ["api", "--method", "POST", "repos/xtt5480446/opencode/rulesets", "--input", "-"],
      input: desiredRuleset,
    })
    expect(calls).toContainEqual({
      args: ["api", "--method", "PUT", "repos/xtt5480446/opencode/rulesets/8", "--input", "-"],
      input: desiredRuleset,
    })
  })
})
