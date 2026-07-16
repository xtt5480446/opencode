import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { QueryClient } from "@tanstack/solid-query"
import type { AppClient, AppProject as Project, AppSession as Session } from "../backend"
import { createAppClient } from "../backend.test-fixture"
import type { ProviderStore } from "./types"
import { bootstrapDirectory, loadPathQuery, loadProvidersQuery } from "./bootstrap"
import type { State, VcsCache } from "./types"
import { createServerSession } from "../server-session"
import { ServerScope } from "@/utils/server-scope"

const provider = { all: new Map(), connected: [], default: {} } satisfies ProviderStore

function directoryState() {
  return createStore<State>({
    status: "loading",
    agent: [],
    command: [],
    reference: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: true,
    provider,
    config: {},
    path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_working(id: string) {
      return this.session_status[id]?.type !== "idle"
    },
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    mcp_ready: true,
    mcp: {},
    mcp_resource: {},
    lsp_ready: true,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    part: {},
    part_text_accum_delta: {},
  })
}

describe("bootstrapDirectory", () => {
  test("marks a loading directory partial during bootstrap and complete after success", async () => {
    const mcpReads: string[] = []
    const [store, setStore] = directoryState()

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {},
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      backend: {
        version: "v1",
        capabilities: {
          configuration: { get: async () => ({}), getGlobal: async () => ({}), updateGlobal: async () => {} },
          vcsInfo: { get: async () => ({}) },
        },
        common: {
          catalog: {
            agents: async () => [{ id: "build", name: "build", mode: "primary", hidden: false }],
            providers: async () => ({ providers: new Map(), connected: [], defaults: {} }),
          },
          sessions: { activity: async () => ({}) },
          projects: { current: async () => ({ id: "project", directory: "/project" }) },
          commands: {
            list: async () => {
              mcpReads.push("command")
              return []
            },
          },
          permissions: { pending: async () => [] },
          questions: { pending: async () => [] },
          references: { list: async () => [] },
        },
      } as unknown as AppClient,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
    })

    expect(store.status).toBe("partial")

    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(store.status).toBe("complete")
    expect(mcpReads).toEqual([])
  })

  test("seeds session status even while warming session info stalls", async () => {
    const [store, setStore] = directoryState()
    const stalled = Promise.withResolvers<never>()
    const backend = createAppClient({
      version: "v1",
      capabilities: {
        configuration: { get: async () => ({}), getGlobal: async () => ({}), updateGlobal: async () => {} },
        vcsInfo: { get: async () => ({}) },
      },
      common: {
        catalog: {
          agents: async () => [{ id: "build", name: "build", mode: "primary", hidden: false }],
          providers: async () => ({ providers: new Map(), connected: [], defaults: {} }),
        },
        sessions: { activity: async () => ({ ses_busy: { type: "busy" } }), get: () => stalled.promise },
        projects: { current: async () => ({ id: "project", directory: "/project" }) },
        commands: { list: async () => [] },
        permissions: { pending: async () => [] },
        questions: { pending: async () => [] },
        references: { list: async () => [] },
      },
    })
    const session = createServerSession(backend)
    const stale: Session = {
      id: "ses_stale",
      slug: "ses_stale",
      projectID: "project",
      directory: "/project",
      title: "stale",
      version: "1",
      time: { created: 1, updated: 1 },
    }
    session.remember(stale)
    session.set("session_status", stale.id, { type: "busy" })

    await bootstrapDirectory({
      directory: "/project",
      scope: ServerScope.local,
      mcp: false,
      global: {
        config: {},
        path: { state: "", config: "", worktree: "/project", directory: "/project", home: "/home" },
        project: [{ id: "project", worktree: "/project" } as Project],
        provider,
      },
      backend,
      store,
      setStore,
      vcsCache: { setStore() {} } as unknown as VcsCache,
      loadSessions() {},
      translate: (key) => key,
      queryClient: new QueryClient(),
      session,
    })

    const deadline = Date.now() + 500
    while (!session.data.session_working("ses_busy") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    expect(session.data.session_status["ses_busy"]?.type).toBe("busy")
    expect(session.data.session_status[stale.id]).toBeUndefined()
  })
})

describe("query keys", () => {
  test("partitions identical directories by server scope", () => {
    const backend = Promise.resolve({} as AppClient)
    const remote = "https://debian.example" as typeof ServerScope.local

    expect([...loadPathQuery(ServerScope.local, "/repo", backend).queryKey]).toEqual(["local", "/repo", "path"])
    expect([...loadPathQuery(remote, "/repo", backend).queryKey]).toEqual(["https://debian.example", "/repo", "path"])
    expect([...loadProvidersQuery(remote, null, backend).queryKey]).toEqual([
      "https://debian.example",
      null,
      "providers",
    ])
  })
})
