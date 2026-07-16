import type {
  AppClient,
  AppConfig,
  AppPathInfo,
  AppPermissionRequest,
  AppProject,
  AppProviderAuthResponse,
  AppQuestionRequest,
  AppReference,
  AppSession,
  ProviderCatalog,
} from "../backend"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { retry } from "@opencode-ai/core/util/retry"
import { batch } from "solid-js"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { ProviderStore, State, StoreConfig, VcsCache } from "./types"
import type { ServerSession } from "../server-session"
import { cmp } from "./utils"
import { formatServerError } from "@/utils/server-errors"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import { loadMcpQuery, loadMcpResourcesQuery } from "../server-sync"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"

type GlobalStore = {
  ready: boolean
  path: AppPathInfo
  project: AppProject[]
  provider: ProviderStore
  provider_auth: AppProviderAuthResponse
  config: StoreConfig
  reload: undefined | "pending" | "complete"
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

const providerRev = new Map<string, number>()

export function clearProviderRev(scope: ServerScope, directory: string) {
  providerRev.delete(ScopedKey.from(scope, directory))
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

function showErrors(input: {
  errors: unknown[]
  title: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
}) {
  if (input.errors.length === 0) return
  const message = formatServerError(input.errors[0], input.translate)
  const more = input.errors.length > 1 ? input.formatMoreCount(input.errors.length - 1) : ""
  showToast({
    variant: "error",
    title: input.title,
    description: message + more,
  })
}

export const loadGlobalConfigQuery = (scope: ServerScope, backend: Promise<AppClient>) =>
  queryOptions({
    queryKey: [scope, "config"],
    queryFn: () => retry(async () => (await backend).capabilities.configuration?.getGlobal() ?? {}),
  })

export const loadProjectsQuery = (scope: ServerScope, backend: Promise<AppClient>) =>
  queryOptions({
    queryKey: [scope, "project"],
    queryFn: () =>
      retry(() =>
        backend
          .then((client) => client.capabilities.projectList?.list() ?? [])
          .then((projects) => {
            return projects
              .filter((p) => !!p?.id)
              .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
              .slice()
              .sort((a, b) => cmp(a.id, b.id))
          }),
      ),
  })

export async function bootstrapGlobal(input: {
  backend: Promise<AppClient>
  scope: ServerScope
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  const slow = [
    () => input.queryClient.fetchQuery(loadGlobalConfigQuery(input.scope, input.backend)),
    () => input.queryClient.fetchQuery(loadProvidersQuery(input.scope, null, input.backend)),
    () => input.queryClient.fetchQuery(loadPathQuery(input.scope, null, input.backend)),
    () =>
      input.queryClient
        .fetchQuery(loadProjectsQuery(input.scope, input.backend))
        .then((data) => input.setGlobalStore("project", data)),
  ]
  await runAll(slow)
  // showErrors({
  //   errors: errors(),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: readonly AppProject[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: AppSession) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  backend: AppClient
  location: { directory: string }
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.backend.common.sessions.get({ sessionID, location: input.location })).then((x) => {
        if (!x?.id) return
        mergeSession(input.setStore, x)
      }),
    ),
  ).then(() => undefined)
}

export const loadProvidersQuery = (scope: ServerScope, directory: string | null, backend: Promise<AppClient>) =>
  queryOptions({
    queryKey: [scope, directory, "providers"],
    queryFn: () =>
      retry(() => backend.then((client) => client.common.catalog.providers(location(directory)).then(toProviderStore))),
  })

export const loadAgentsQuery = (scope: ServerScope, directory: string, backend: Promise<AppClient>) =>
  queryOptions({
    queryKey: [scope, directory, "agents"],
    queryFn: () =>
      retry(() =>
        backend.then((client) => client.common.catalog.agents(location(directory)).then((agents) => [...agents])),
      ),
  })

export const loadPathQuery = (scope: ServerScope, directory: string | null, backend: Promise<AppClient>) =>
  queryOptions<AppPathInfo>({
    queryKey: [scope, directory, "path"],
    queryFn: async () => {
      const client = await backend
      return retry(
        () => client.capabilities.pathInfo?.get(location(directory)) ?? Promise.resolve(emptyPath(directory)),
      )
    },
  })

export const loadReferencesQuery = (scope: ServerScope, directory: string, backend: Promise<AppClient>) =>
  queryOptions<readonly AppReference[]>({
    queryKey: [scope, directory, "references"] as const,
    queryFn: () =>
      retry(() => backend.then((client) => client.common.references.list(location(directory)))).catch(() => []),
    placeholderData: [],
  })

export async function bootstrapDirectory(input: {
  directory: string
  scope: ServerScope
  mcp: boolean
  backend: AppClient
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: StoreConfig
    path: AppPathInfo
    project: readonly AppProject[]
    provider: ProviderStore
  }
  queryClient: QueryClient
  session?: ServerSession
}) {
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", reconcile(input.global.config, { merge: false }))
  }
  if (loading) input.setStore("status", "partial")

  const revKey = ScopedKey.from(input.scope, input.directory)
  const rev = (providerRev.get(revKey) ?? 0) + 1
  providerRev.set(revKey, rev)
  ;(async () => {
    const slow = [
      () => Promise.resolve(input.loadSessions(input.directory)),
      () =>
        input.queryClient
          .ensureQueryData(loadAgentsQuery(input.scope, input.directory, Promise.resolve(input.backend)))
          .then((data) => input.setStore("agent", data)),
      () =>
        retry(
          () =>
            input.backend.capabilities.configuration
              ?.get(location(input.directory))
              .then((config) => input.setStore("config", reconcile(config, { merge: false }))) ?? Promise.resolve(),
        ),
      () =>
        retry(() =>
          input.backend.common.sessions.activity(location(input.directory)).then(async (statuses) => {
            if (!input.session) {
              input.setStore("session_status", mapActivity(statuses))
              return
            }
            const mapped = mapActivity(statuses)
            input.session.set(
              "session_status",
              produce((draft) => {
                for (const sessionID of Object.keys(draft)) {
                  if (mapped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory === input.directory) delete draft[sessionID]
                }
              }),
            )
            for (const [sessionID, status] of Object.entries(mapped)) {
              input.session.set("session_status", sessionID, reconcile(status))
            }
            // Warm session info only after seeding statuses so a stalled session
            // fetch cannot park busy indicators behind it, mirroring how live
            // session.status events apply first and resolve info in the background.
            await Promise.all(
              Object.keys(mapped).map((sessionID) => input.session!.resolve(sessionID).catch(() => undefined)),
            )
          }),
        ),
      !seededProject &&
        (() =>
          retry(() => input.backend.common.projects.current(location(input.directory))).then((project) =>
            input.setStore("project", project.id),
          )),
      !seededPath &&
        (() =>
          input.queryClient
            .ensureQueryData(loadPathQuery(input.scope, input.directory, Promise.resolve(input.backend)))
            .then((data) => {
              const next = projectID(data.directory ?? input.directory, input.global.project)
              if (next) input.setStore("project", next)
            })),
      () =>
        retry(() =>
          (input.backend.capabilities.vcsInfo?.get(location(input.directory)) ?? Promise.resolve(undefined)).then(
            (data) => {
              const next = data ?? input.store.vcs
              input.setStore("vcs", next)
              if (next) input.vcsCache.setStore("value", next)
            },
          ),
        ),
      input.mcp &&
        (() =>
          retry(() => input.backend.common.commands.list(location(input.directory))).then((commands) =>
            input.setStore("command", reconcile(commands)),
          )),
      () =>
        input.queryClient.fetchQuery(loadReferencesQuery(input.scope, input.directory, Promise.resolve(input.backend))),
      () =>
        retry(() =>
          input.backend.common.permissions.pending(location(input.directory)).then((data) => {
            const permissions = data.map(
              (perm): AppPermissionRequest => perm,
            )
            const ids = permissions.map((perm) => perm.sessionID)
            const grouped = groupBySession(permissions)
            const warm = input.session
              ? Promise.all(ids.map((sessionID) => input.session!.resolve(sessionID))).then(() => undefined)
              : warmSessions({
                  ids,
                  store: input.store,
                  setStore: input.setStore,
                  backend: input.backend,
                  location: { directory: input.directory },
                })
            return warm.then(() =>
              batch(() => {
                const current = input.session?.data.permission ?? input.store.permission
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("permission", sessionID, [])
                  if (!input.session) input.setStore("permission", sessionID, [])
                }
                for (const [sessionID, permissions] of Object.entries(grouped)) {
                  const value = reconcile(
                    permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("permission", sessionID, value)
                  if (!input.session) input.setStore("permission", sessionID, value)
                }
              }),
            )
          }),
        ),
      () =>
        retry(() =>
          input.backend.common.questions.pending(location(input.directory)).then((data) => {
            const questions = data.map(
              (question): AppQuestionRequest => question,
            )
            const ids = questions.map((question) => question.sessionID)
            const grouped = groupBySession(questions)
            const warm = input.session
              ? Promise.all(ids.map((sessionID) => input.session!.resolve(sessionID))).then(() => undefined)
              : warmSessions({
                  ids,
                  store: input.store,
                  setStore: input.setStore,
                  backend: input.backend,
                  location: { directory: input.directory },
                })
            return warm.then(() =>
              batch(() => {
                const current = input.session?.data.question ?? input.store.question
                for (const sessionID of Object.keys(current)) {
                  if (grouped[sessionID]) continue
                  if (input.session?.get(sessionID)?.directory !== input.directory) continue
                  if (input.session) input.session.set("question", sessionID, [])
                  if (!input.session) input.setStore("question", sessionID, [])
                }
                for (const [sessionID, questions] of Object.entries(grouped)) {
                  const value = reconcile(
                    questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
                    { key: "id" },
                  )
                  if (input.session) input.session.set("question", sessionID, value)
                  if (!input.session) input.setStore("question", sessionID, value)
                }
              }),
            )
          }),
        ),
      () => Promise.resolve(input.loadSessions(input.directory)),
      input.mcp &&
        (() =>
          input.queryClient.fetchQuery(loadMcpQuery(input.scope, input.directory, Promise.resolve(input.backend)))),
      input.mcp &&
        (() =>
          input.queryClient.fetchQuery(
            loadMcpResourcesQuery(input.scope, input.directory, Promise.resolve(input.backend)),
          )),
      () =>
        input.queryClient
          .fetchQuery(loadProvidersQuery(input.scope, input.directory, Promise.resolve(input.backend)))
          .catch((err) => {
            const project = getFilename(input.directory)
            showToast({
              variant: "error",
              title: input.translate("toast.project.reloadFailed.title", { project }),
              description: formatServerError(err, input.translate),
            })
          }),
    ].filter(Boolean) as (() => Promise<any>)[]

    await waitForPaint()
    const slowErrs = errors(await runAll(slow))
    if (slowErrs.length > 0) {
      console.error("Failed to finish bootstrap instance", slowErrs[0])
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(slowErrs[0], input.translate),
      })
    }

    if (loading && slowErrs.length === 0) input.setStore("status", "complete")
  })()
}

function location(directory: string | null) {
  return directory === null ? undefined : { location: { directory } }
}

function emptyPath(directory: string | null): AppPathInfo {
  return { home: "", directory: directory ?? "", state: "", config: "", worktree: "" }
}

function toProviderStore(input: ProviderCatalog): ProviderStore {
  return {
    all: input.providers,
    connected: [...input.connected],
    default: { ...input.defaults },
  }
}

function mapActivity(input: Awaited<ReturnType<AppClient["common"]["sessions"]["activity"]>>) {
  return input
}
