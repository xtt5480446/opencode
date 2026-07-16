import type {
  AppMessage,
  AppPart,
  AppPermissionRequest,
  AppQuestionRequest,
  AppSession,
  AppFileDiff,
  AppTodo,
  AppCommand,
  AppConfig,
  AppAgent,
  AppLspStatus,
  AppMcpResource,
  AppMcpStatus,
  AppPathInfo,
  AppProvider,
  AppReference,
  AppVcsInfo,
  SessionActivity,
} from "../backend"
import type { Accessor } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"

export type ProjectMeta = {
  name?: string
  icon?: {
    override?: string
    color?: string
  }
  commands?: {
    start?: string
  }
}

export type StoreConfig = {
  -readonly [Key in keyof AppConfig]: AppConfig[Key]
}

export type ProviderStore = {
  all: ReadonlyMap<string, AppProvider>
  connected: readonly string[]
  default: Readonly<Record<string, string>>
}

export type State = {
  status: "loading" | "partial" | "complete"
  agent: AppAgent[]
  command: readonly AppCommand[]
  reference: readonly AppReference[]
  project: string
  projectMeta: ProjectMeta | undefined
  icon: string | undefined
  provider_ready: boolean
  provider: ProviderStore
  config: StoreConfig
  path: AppPathInfo
  session: AppSession[]
  sessionTotal: number
  session_status: {
    [sessionID: string]: SessionActivity
  }
  session_working(id: string): boolean
  session_diff: {
    [sessionID: string]: AppFileDiff[]
  }
  todo: {
    [sessionID: string]: AppTodo[]
  }
  permission: {
    [sessionID: string]: AppPermissionRequest[]
  }
  question: {
    [sessionID: string]: AppQuestionRequest[]
  }
  mcp_ready: boolean
  mcp: {
    [name: string]: AppMcpStatus
  }
  mcp_resource: {
    [key: string]: AppMcpResource
  }
  lsp_ready: boolean
  lsp: readonly AppLspStatus[]
  vcs: AppVcsInfo | undefined
  limit: number
  message: {
    [sessionID: string]: AppMessage[]
  }
  part: {
    [messageID: string]: AppPart[]
  }
  part_text_accum_delta: {
    [partID: string]: string
  }
}

export type VcsCache = {
  store: Store<{ value: AppVcsInfo | undefined }>
  setStore: SetStoreFunction<{ value: AppVcsInfo | undefined }>
  ready: Accessor<boolean>
}

export type MetaCache = {
  store: Store<{ value: ProjectMeta | undefined }>
  setStore: SetStoreFunction<{ value: ProjectMeta | undefined }>
  ready: Accessor<boolean>
}

export type IconCache = {
  store: Store<{ value: string | undefined }>
  setStore: SetStoreFunction<{ value: string | undefined }>
  ready: Accessor<boolean>
}

export type ChildOptions = {
  bootstrap?: boolean
  mcp?: boolean
}

export type DirState = {
  lastAccessAt: number
}

export type EvictPlan = {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  now: number
}

export type DisposeCheck = {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
}

export type RootLoadArgs = {
  directory: string
  limit: number
  list: (query: { directory: string; roots: true; limit?: number }) => Promise<{ data?: AppSession[] }>
}

export type RootLoadResult = {
  data?: AppSession[]
  limit: number
  limited: boolean
}

export const MAX_DIR_STORES = 30
export const DIR_IDLE_TTL_MS = 20 * 60 * 1000
export const SESSION_RECENT_WINDOW = 4 * 60 * 60 * 1000
export const SESSION_RECENT_LIMIT = 50
