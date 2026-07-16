import type {
  Config,
  Event,
  GlobalEvent,
  Message,
  Model,
  OpencodeClient,
  Part,
  Project,
  Provider,
  Session,
} from "@opencode-ai/sdk-v1/v2/client"
import type {
  AppAgent,
  AppClient,
  AppCommand,
  AppConfig,
  AppEvent,
  AppEventEnvelope,
  AppFileDiff,
  AppModel,
  AppPermissionRequest,
  AppProject,
  AppProvider,
  AppQuestionRequest,
  AppReference,
  AppSession,
  CommandInput,
  DecoratedFileContent,
  FileContent,
  FileEntry,
  LocationInput,
  LocationRef,
  Page,
  PromptFile,
  PromptInput,
  PtyTransportConfig,
  ProviderCatalog,
  RequestOptions,
  SessionActivity,
  TimelineContent,
  TimelineItem,
  ToolState,
} from "./backend"

type CachedMessage = {
  info: Message
  parts: Part[]
}

export function createV1Backend(
  client: OpencodeClient,
  defaultLocation?: LocationRef,
  eventClient: OpencodeClient = client,
  transportConfig?: PtyTransportConfig,
): AppClient {
  const messages = new Map<string, CachedMessage>()

  const options = (input?: RequestOptions) => ({ signal: input?.signal, throwOnError: true as const })
  const location = (input?: LocationInput) => legacyLocation(input?.location ?? defaultLocation)
  const cache = (input: CachedMessage) => {
    messages.set(input.info.id, input)
    return toTimelineItem(input.info, input.parts)
  }

  const loadMessage = async (
    input: LocationInput & { sessionID: string; messageID: string },
    request?: RequestOptions,
    force?: boolean,
  ) => {
    const cached = messages.get(input.messageID)
    if (cached && !force) return cached
    const result = await client.session.message(
      { sessionID: input.sessionID, messageID: input.messageID, ...location(input) },
      options(request),
    )
    messages.set(input.messageID, result.data)
    return result.data
  }
  const sessionActions = {
    remove: async (input: LocationInput & { sessionID: string }, request?: RequestOptions) => {
      const result = await client.session.delete(
        { sessionID: input.sessionID, ...location(input) },
        options(request),
      )
      return result.data
    },
    fork: async (input: LocationInput & { sessionID: string; messageID?: string }, request?: RequestOptions) => {
      const result = await client.session.fork(
        { sessionID: input.sessionID, messageID: input.messageID, ...location(input) },
        options(request),
      )
      return toSession(result.data)
    },
    rename: async (input: LocationInput & { sessionID: string; title: string }, request?: RequestOptions) => {
      await client.session.update(
        { sessionID: input.sessionID, title: input.title, ...location(input) },
        options(request),
      )
    },
    command: async (input: CommandInput, request?: RequestOptions) => {
      await client.session.command(
        {
          sessionID: input.sessionID,
          messageID: input.id,
          command: input.command,
          arguments: input.arguments ?? "",
          agent: input.agent,
          model: input.model && `${input.model.providerID}/${input.model.id}`,
          variant: input.model?.variant,
          parts: input.files?.map(toFilePart),
          ...location(input),
        },
        options(request),
      )
    },
  }

  return {
    version: "v1",
    common: {
      health: {
        get: async (request) => {
          const result = await client.global.health(options(request))
          return result.data
        },
      },
      projects: {
        current: async (input, request) => {
          const params = location(input)
          const [project, path] = await Promise.all([
            client.project.current(params, options(request)),
            client.path.get(params, options(request)),
          ])
          return { id: project.data.id, directory: path.data.directory }
        },
      },
      catalog: {
        providers: async (input, request) => {
          const result = await client.provider.list(location(input), options(request))
          return toProviderCatalog(result.data)
        },
        agents: async (input, request) => {
          const result = await client.app.agents(location(input), options(request))
          return normalizeAgents(result.data).map(toAgent)
        },
      },
      commands: {
        list: async (input, request) => {
          const result = await client.command.list(location(input), options(request))
          return result.data.map(toCommand)
        },
      },
      references: {
        list: async (input, request) => {
          const result = await client.v2.reference.list(
            { location: apiLocation(input?.location ?? defaultLocation) },
            options(request),
          )
          return result.data.data.map(toReference)
        },
      },
      sessions: {
        list: async (input, request) => {
          const cursor = input?.cursor === undefined ? undefined : Number(input.cursor)
          if (cursor !== undefined && !Number.isFinite(cursor))
            throw new Error(`Invalid session cursor: ${input?.cursor}`)
          const result = await client.experimental.session.list(
            {
              ...location(input),
              roots: input?.roots,
              limit: input?.limit,
              search: input?.search,
              cursor,
            },
            options(request),
          )
          return {
            items: result.data.map(toSession),
            older: result.response.headers.get("x-next-cursor") ?? undefined,
          }
        },
        create: async (input, request) => {
          const result = await client.session.create(
            {
              ...location(input),
              agent: input?.agent,
              model: input?.model,
            },
            options(request),
          )
          return toSession(result.data)
        },
        get: async (input, request) => {
          const result = await client.session.get({ sessionID: input.sessionID, ...location(input) }, options(request))
          return toSession(result.data)
        },
        interrupt: async (input, request) => {
          await client.session.abort({ sessionID: input.sessionID, ...location(input) }, options(request))
        },
        activity: async (input, request) => {
          const result = await client.session.status(location(input), options(request))
          return Object.fromEntries(
            Object.entries(result.data).flatMap(([sessionID, status]) => {
              const activity = toActivity(status)
              return activity ? [[sessionID, activity] as const] : []
            }),
          )
        },
        history: async (input, request) => {
          const result = await client.session.messages(
            {
              sessionID: input.sessionID,
              limit: input.limit,
              before: input.cursor,
              ...location(input),
            },
            options(request),
          )
          return {
            items: result.data.map(cache),
            older: result.response.headers.get("x-next-cursor") ?? undefined,
          }
        },
        message: async (input, request) => cache(await loadMessage(input, request, true)),
        prompt: async (input, request) => {
          await client.session.promptAsync(
            {
              sessionID: input.sessionID,
              messageID: input.id,
              agent: input.selection?.agent,
              model: input.selection?.model && {
                providerID: input.selection.model.providerID,
                modelID: input.selection.model.id,
              },
              variant: input.selection?.model?.variant,
              parts: toPromptParts(input),
              ...location(input),
            },
            options(request),
          )
        },
      },
      files: {
        list: async (input, request) => {
          const result = await client.file.list({ path: input.path ?? "", ...location(input) }, options(request))
          return result.data.map((item) => ({
            path: item.path,
            name: item.name,
            absolute: item.absolute,
            type: item.type,
            ignored: false,
          }))
        },
        find: async (input, request) => {
          const find = async (type: FileEntry["type"]) => {
            const result = await client.find.files(
              { query: input.query, type, limit: input.limit, ...location(input) },
              options(request),
            )
            return result.data.map((path) => ({ path, type }))
          }
          if (input.type) return find(input.type)
          const result = await Promise.all([find("file"), find("directory")])
          return [...new Map(result.flat().map((item) => [item.path, item])).values()]
        },
        read: async (input, request) => {
          const result = await client.file.read({ path: input.path, ...location(input) }, options(request))
          return toFileContent(result.data)
        },
      },
      permissions: {
        pending: async (input, request) => {
          const result = await client.permission.list(location(input), options(request))
          return result.data.map(toPermission)
        },
        reply: async (input, request) => {
          await client.permission.reply(
            {
              requestID: input.requestID,
              reply: input.reply,
              message: input.message,
              ...location(input),
            },
            options(request),
          )
        },
      },
      questions: {
        pending: async (input, request) => {
          const result = await client.question.list(location(input), options(request))
          return result.data.map(toQuestion)
        },
        reply: async (input, request) => {
          await client.question.reply(
            {
              requestID: input.requestID,
              answers: input.answers.map((answer) => [...answer]),
              ...location(input),
            },
            options(request),
          )
        },
        reject: async (input, request) => {
          await client.question.reject({ requestID: input.requestID, ...location(input) }, options(request))
        },
      },
      pty: {
        list: async (input, request) => {
          const result = await client.pty.list(location(input), options(request))
          return result.data.map(toPty)
        },
        create: async (input, request) => {
          const result = await client.pty.create(
            {
              title: input.title,
              command: input.command,
              args: input.args ? [...input.args] : undefined,
              cwd: input.cwd,
              env: input.env ? { ...input.env } : undefined,
              ...location(input),
            },
            options(request),
          )
          return toPty(result.data)
        },
        get: async (input, request) => {
          const result = await client.pty.get({ ptyID: input.ptyID, ...location(input) }, options(request))
          return toPty(result.data)
        },
        update: async (input, request) => {
          const result = await client.pty.update(
            {
              ptyID: input.ptyID,
              title: input.title,
              size: input.size,
              ...location(input),
            },
            options(request),
          )
          return toPty(result.data)
        },
        remove: async (input, request) => {
          await client.pty.remove({ ptyID: input.ptyID, ...location(input) }, options(request))
        },
      },
      events: {
        subscribe: (request) => ({
          async *[Symbol.asyncIterator]() {
            const result = await eventClient.global.event(options(request))
            for await (const input of result.stream) {
              const event = await toEvent(input, messages, loadMessage)
              yield {
                location:
                  input.directory === "global"
                    ? undefined
                    : { directory: input.directory, workspaceID: input.workspace },
                event,
              } satisfies AppEventEnvelope
            }
          },
        }),
      },
    },
    capabilities: {
      projectList: {
        list: async (request) => {
          const result = await client.project.list(undefined, options(request))
          return result.data.map(toProject)
        },
      },
      vcs: {
        status: async (input, request) => {
          const result = await client.vcs.status(location(input), options(request))
          return result.data
        },
        diff: async (input, request) => {
          const result = await client.vcs.diff(
            {
              mode: input.mode === "working" ? "git" : "branch",
              context: input.context,
              ...location(input),
            },
            options(request),
          )
          return result.data
        },
      },
      mcp: {
        list: async (input, request) => {
          const result = await client.mcp.status(location(input), options(request))
          return Object.entries(result.data).map(([name, status]) => ({ name, status }))
        },
        resources: async (input, request) => {
          const result = await client.experimental.resource.list(location(input), options(request))
          return {
            resources: Object.values(result.data).map((item) => ({
              server: item.client,
              name: item.name,
              uri: item.uri,
              description: item.description,
              mimeType: item.mimeType,
            })),
            templates: [],
          }
        },
      },
      sessionActionsV1: sessionActions,
      configuration: {
        getGlobal: async (request) => {
          const result = await client.global.config.get(options(request))
          return toConfig(result.data)
        },
        updateGlobal: async (config, request) => {
          const current = await client.global.config.get(options(request))
          await client.global.config.update({ config: { ...current.data, ...fromConfig(config) } }, options(request))
        },
        get: async (input, request) => {
          const result = await client.config.get(location(input), options(request))
          return toConfig(result.data)
        },
      },
      providerAuthV1: {
        methods: async (input, request) => {
          const result = await client.provider.auth(location(input), options(request))
          return result.data
        },
        authorize: async (input, request) => {
          const result = await client.provider.oauth.authorize(
            {
              providerID: input.providerID,
              method: input.method,
              inputs: input.values ? { ...input.values } : undefined,
              ...location(input),
            },
            options(request),
          )
          return result.data
        },
        callback: async (input, request) => {
          await client.provider.oauth.callback(
            {
              providerID: input.providerID,
              method: input.method,
              code: input.code,
              ...location(input),
            },
            options(request),
          )
        },
        setApiKey: async (input, request) => {
          await client.auth.set(
            {
              providerID: input.providerID,
              auth: { type: "api", key: input.key, metadata: input.metadata && { ...input.metadata } },
            },
            options(request),
          )
        },
        remove: async (input, request) => {
          await client.auth.remove(input, options(request))
        },
      },
      projectEditing: {
        update: async (input, request) => {
          const result = await client.project.update(
            {
              projectID: input.projectID,
              name: input.name,
              icon: input.icon,
              commands: input.commands,
              ...location(input),
            },
            options(request),
          )
          return toProject(result.data)
        },
        initGit: async (input, request) => {
          const result = await client.project.initGit(location(input), options(request))
          return toProject(result.data)
        },
      },
      worktreesV1: {
        list: async (input, request) => {
          const result = await client.worktree.list(location(input), options(request))
          return result.data
        },
        create: async (input, request) => {
          const result = await client.worktree.create(location(input), options(request))
          return { directory: result.data.directory, branch: result.data.branch }
        },
        remove: async (input, request) => {
          const result = await client.worktree.remove(
            { ...location(input), worktreeRemoveInput: { directory: input.directory } },
            options(request),
          )
          return result.data
        },
        reset: async (input, request) => {
          const result = await client.worktree.reset(
            { ...location(input), worktreeResetInput: { directory: input.directory } },
            options(request),
          )
          return result.data
        },
      },
      sessionExtrasV1: {
        archive: async (input, request) => {
          await client.session.update(
            { sessionID: input.sessionID, time: { archived: input.archivedAt }, ...location(input) },
            options(request),
          )
        },
        share: async (input, request) => {
          const result = await client.session.share(
            { sessionID: input.sessionID, ...location(input) },
            options(request),
          )
          if (!result.data.share) throw new Error(`Session ${input.sessionID} was shared without a URL`)
          return result.data.share.url
        },
        unshare: async (input, request) => {
          await client.session.unshare({ sessionID: input.sessionID, ...location(input) }, options(request))
        },
        diff: async (input, request) => {
          const result = await client.session.diff({ sessionID: input.sessionID, ...location(input) }, options(request))
          return result.data.flatMap((item) => (item.file ? [{ ...item, file: item.file }] : []))
        },
        todos: async (input, request) => {
          const result = await client.session.todo({ sessionID: input.sessionID, ...location(input) }, options(request))
          return result.data.map((item) => ({
            content: item.content,
            status: item.status,
            priority: item.priority,
          }))
        },
        summarize: async (input, request) => {
          await client.session.summarize(
            {
              sessionID: input.sessionID,
              providerID: input.model.providerID,
              modelID: input.model.id,
              ...location(input),
            },
            options(request),
          )
        },
        revert: async (input, request) => {
          const result = await client.session.revert(
            { sessionID: input.sessionID, messageID: input.messageID, ...location(input) },
            options(request),
          )
          return toSession(result.data)
        },
        clearRevert: async (input, request) => {
          const result = await client.session.unrevert(
            { sessionID: input.sessionID, ...location(input) },
            options(request),
          )
          return toSession(result.data)
        },
        shell: async (input, request) => {
          await client.session.shell(
            {
              sessionID: input.sessionID,
              messageID: input.id,
              command: input.command,
              agent: input.agent,
              model: input.model && { providerID: input.model.providerID, modelID: input.model.id },
              ...location(input),
            },
            options(request),
          )
        },
      },
      lsp: {
        status: async (input, request) => {
          const result = await client.lsp.status(location(input), options(request))
          return result.data.map((item) => ({ id: item.id, name: item.name, status: item.status }))
        },
      },
      mcpControl: {
        connect: async (input, request) => {
          await client.mcp.connect({ name: input.name, ...location(input) }, options(request))
        },
        disconnect: async (input, request) => {
          await client.mcp.disconnect({ name: input.name, ...location(input) }, options(request))
        },
        authenticate: async (input, request) => {
          await client.mcp.auth.authenticate({ name: input.name, ...location(input) }, options(request))
        },
      },
      pathInfo: {
        get: async (input, request) => {
          const result = await client.path.get(location(input), options(request))
          return result.data
        },
      },
      vcsInfo: {
        get: async (input, request) => {
          const result = await client.vcs.get(location(input), options(request))
          return { branch: result.data.branch, defaultBranch: result.data.default_branch }
        },
      },
      decoratedFiles: {
        read: async (input, request) => {
          const result = await client.file.read({ path: input.path, ...location(input) }, options(request))
          return toDecoratedFile(result.data)
        },
      },
      ptyTransport: transportConfig && {
        connectToken: async (input, request) => {
          const result = await client.pty.connectToken(
            { ptyID: input.ptyID, ...location(input) },
            {
              signal: request?.signal,
              throwOnError: false,
              headers: { "x-opencode-ticket": "1" },
            },
          )
          return { status: result.response.status, ticket: result.data?.ticket }
        },
        exists: async (input, request) => {
          const result = await client.pty.get(
            { ptyID: input.ptyID, ...location(input) },
            { signal: request?.signal, throwOnError: false },
          )
          return result.response.status !== 404
        },
        connectURL: (input) => ptyConnectURL(transportConfig, "/pty", input, legacyLocation(input.location)),
      },
      shellDiscovery: {
        list: async (input, request) => {
          const result = await client.pty.shells(location(input), options(request))
          return result.data
        },
      },
      runtimeV1: {
        disposeLocation: async (input, request) => {
          await client.instance.dispose(location(input), options(request))
        },
        disposeAll: async (request) => {
          await client.global.dispose(options(request))
        },
      },
    },
  }
}

function ptyConnectURL(
  config: PtyTransportConfig,
  root: string,
  input: { ptyID: string; cursor: number; ticket?: string },
  location: { directory?: string; workspace?: string },
) {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, "")}${root}/${encodeURIComponent(input.ptyID)}/connect`)
  if (location.directory) url.searchParams.set("directory", location.directory)
  if (location.workspace) url.searchParams.set("workspace", location.workspace)
  url.searchParams.set("cursor", String(input.cursor))
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  if (input.ticket) {
    url.searchParams.set("ticket", input.ticket)
    return url
  }
  if (config.password && (!config.sameOrigin || config.authToken))
    url.searchParams.set("auth_token", btoa(`${config.username ?? "opencode"}:${config.password}`))
  return url
}

function legacyLocation(input?: LocationRef) {
  if (!input) return {}
  return {
    directory: input.directory,
    workspace: input.workspaceID,
  }
}

function apiLocation(input?: LocationRef) {
  if (!input) return
  return {
    directory: input.directory,
    workspace: input.workspaceID,
  }
}

function toProject(input: Project): AppProject {
  return {
    id: input.id,
    worktree: input.worktree,
    vcs: input.vcs,
    time: { ...input.time, updated: input.time.updated ?? input.time.created },
    name: input.name,
    icon: input.icon,
    commands: input.commands,
    sandboxes: input.sandboxes,
  }
}

function toSession(input: Session): AppSession {
  return {
    id: input.id,
    slug: input.slug,
    version: input.version,
    parentID: input.parentID,
    projectID: input.projectID,
    location: { directory: input.directory, workspaceID: input.workspaceID },
    directory: input.directory,
    workspaceID: input.workspaceID,
    title: input.title,
    cost: input.cost ?? 0,
    tokens: input.tokens,
    time: input.time,
    share: input.share,
    revert: input.revert && { messageID: input.revert.messageID },
  }
}

function toModel(input: Model): AppModel {
  return {
    id: input.id,
    providerID: input.providerID,
    name: input.name,
    family: input.family,
    releaseDate: input.release_date,
    cost: {
      input: input.cost.input,
      output: input.cost.output,
      cacheRead: input.cost.cache.read,
      cacheWrite: input.cost.cache.write,
    },
    capabilities: {
      reasoning: input.capabilities.reasoning,
      input: input.capabilities.input,
    },
    limit: input.limit,
    variants: input.variants,
  }
}

function toProvider(input: Provider): AppProvider {
  return {
    id: input.id,
    name: input.name,
    source: input.source,
    models: Object.fromEntries(
      Object.entries(input.models).flatMap(([id, model]) =>
        model.status === "deprecated" ? [] : [[id, toModel(model)]],
      ),
    ),
  }
}

function toProviderCatalog(input: {
  all: Provider[]
  connected: string[]
  default: Record<string, string>
}): ProviderCatalog {
  return {
    providers: new Map(input.all.map((provider) => [provider.id, toProvider(provider)])),
    connected: input.connected,
    defaults: input.default,
  }
}

function normalizeAgents(input: unknown) {
  const valid = (item: unknown): item is import("@opencode-ai/sdk-v1/v2/client").Agent => {
    if (!item || typeof item !== "object") return false
    if (!("name" in item) || typeof item.name !== "string") return false
    if (!("mode" in item)) return false
    return item.mode === "subagent" || item.mode === "primary" || item.mode === "all"
  }
  if (Array.isArray(input)) return input.filter(valid)
  if (valid(input)) return [input]
  if (!input || typeof input !== "object") return []
  return Object.values(input).filter(valid)
}

function toAgent(input: import("@opencode-ai/sdk-v1/v2/client").Agent): AppAgent {
  return {
    id: input.name,
    name: input.name,
    description: input.description,
    mode: input.mode,
    hidden: input.hidden ?? false,
    color: input.color,
    model: input.model && {
      id: input.model.modelID,
      providerID: input.model.providerID,
      variant: input.variant,
    },
  }
}

function toCommand(input: import("@opencode-ai/sdk-v1/v2/client").Command): AppCommand {
  return { name: input.name, description: input.description, source: input.source }
}

function toReference(input: import("@opencode-ai/sdk-v1/v2/client").ReferenceInfo): AppReference {
  return input
}

function toActivity(input: import("@opencode-ai/sdk-v1/v2/client").SessionStatus): SessionActivity {
  if (input.type === "idle") return { type: "idle" }
  if (input.type === "busy") return { type: "running" }
  return input
}

function toTimelineItem(info: Message, parts: readonly Part[]): TimelineItem {
  if (info.role === "user") {
    return {
      type: "user",
      id: info.id,
      sessionID: info.sessionID,
      created: info.time.created,
      content: parts.flatMap(toTimelineContent),
      agent: info.agent,
      model: {
        id: info.model.modelID,
        providerID: info.model.providerID,
        variant: info.model.variant,
      },
      format: info.format,
      summary: info.summary,
      system: info.system,
      tools: info.tools,
    }
  }
  return {
    type: "assistant",
    id: info.id,
    sessionID: info.sessionID,
    parentID: info.parentID,
    created: info.time.created,
    completed: info.time.completed,
    content: parts.flatMap(toTimelineContent),
    agent: info.agent,
    model: { id: info.modelID, providerID: info.providerID, variant: info.variant },
    tokens: info.tokens,
    error: info.error,
    mode: info.mode,
    path: info.path,
    cost: info.cost,
    structured: info.structured,
    finish: info.finish,
    summary: info.summary,
  }
}

function toTimelineContent(input: Part): TimelineContent[] {
  if (input.type === "text")
    return [
      {
        type: input.type,
        id: input.id,
        text: input.text,
        synthetic: input.synthetic,
        ignored: input.ignored,
        metadata: input.metadata,
        time: input.time,
      },
    ]
  if (input.type === "reasoning")
    return [{ type: input.type, id: input.id, text: input.text, metadata: input.metadata, time: input.time }]
  if (input.type === "file")
    return [
      {
        type: input.type,
        id: input.id,
        uri: input.url,
        name: input.filename,
        mime: input.mime,
        source: input.source && {
          ...input.source,
          text: {
            text: input.source.text.value,
            start: input.source.text.start,
            end: input.source.text.end,
          },
        },
      },
    ]
  if (input.type === "agent")
    return [
      {
        type: input.type,
        id: input.id,
        name: input.name,
        source: input.source && { text: input.source.value, start: input.source.start, end: input.source.end },
      },
    ]
  if (input.type === "tool")
    return [
      {
        type: input.type,
        id: input.id,
        callID: input.callID,
        tool: input.tool,
        state: toToolState(input.state),
        metadata: input.metadata,
      },
    ]
  if (input.type === "subtask")
    return [
      {
        type: input.type,
        id: input.id,
        prompt: input.prompt,
        description: input.description,
        agent: input.agent,
        model: input.model && { id: input.model.modelID, providerID: input.model.providerID },
        command: input.command,
      },
    ]
  if (input.type === "step-start") return [{ type: input.type, id: input.id, snapshot: input.snapshot }]
  if (input.type === "step-finish")
    return [
      {
        type: input.type,
        id: input.id,
        reason: input.reason,
        snapshot: input.snapshot,
        cost: input.cost,
        tokens: input.tokens,
      },
    ]
  if (input.type === "snapshot") return [{ type: input.type, id: input.id, snapshot: input.snapshot }]
  if (input.type === "patch") return [{ type: input.type, id: input.id, hash: input.hash, files: input.files }]
  if (input.type === "retry")
    return [{ type: input.type, id: input.id, attempt: input.attempt, error: input.error, time: input.time }]
  if (input.type === "compaction") return [{ type: input.type, id: input.id, auto: input.auto }]
  return []
}

function toToolState(input: import("@opencode-ai/sdk-v1/v2/client").ToolState): ToolState {
  if (input.status === "pending") return { status: input.status, input: input.input, raw: input.raw }
  if (input.status === "running")
    return { status: input.status, input: input.input, title: input.title, metadata: input.metadata, time: input.time }
  if (input.status === "completed")
    return {
      status: input.status,
      input: input.input,
      output: input.output,
      title: input.title,
      metadata: input.metadata,
      time: input.time,
      attachments: input.attachments,
    }
  return { status: input.status, input: input.input, error: input.error, metadata: input.metadata, time: input.time }
}

function toFilePart(input: PromptFile) {
  return {
    type: "file" as const,
    mime: input.mime ?? "text/plain",
    filename: input.name,
    url: input.uri,
    source: input.source?.path
      ? {
          type: "file" as const,
          path: input.source.path,
          text: { value: input.source.text, start: input.source.start, end: input.source.end },
        }
      : undefined,
  }
}

function toPromptParts(input: PromptInput) {
  if (input.parts) return input.parts.map(toPromptPart)
  return [
    { type: "text" as const, text: input.text },
    ...(input.files?.map(toFilePart) ?? []),
    ...(input.agents?.map((agent) => ({
      type: "agent" as const,
      name: agent.name,
      source:
        agent.text !== undefined && agent.start !== undefined && agent.end !== undefined
          ? { value: agent.text, start: agent.start, end: agent.end }
          : undefined,
    })) ?? []),
  ]
}

function toPromptPart(input: NonNullable<PromptInput["parts"]>[number]) {
  if (input.type === "file" && input.source?.type === "resource") return { ...input, source: undefined }
  return { ...input }
}

function toFileContent(input: import("@opencode-ai/sdk-v1/v2/client").FileContent): FileContent {
  if (input.encoding !== "base64") {
    return { bytes: new TextEncoder().encode(input.content), kind: input.type, mimeType: input.mimeType }
  }
  return {
    bytes: Uint8Array.from(atob(input.content), (character) => character.charCodeAt(0)),
    kind: input.type,
    mimeType: input.mimeType,
  }
}

function toDecoratedFile(input: import("@opencode-ai/sdk-v1/v2/client").FileContent): DecoratedFileContent {
  return {
    type: input.type,
    content: input.content,
    diff: input.diff,
    encoding: input.encoding,
    mimeType: input.mimeType,
    patch: input.patch,
  }
}

function toPermission(input: import("@opencode-ai/sdk-v1/v2/client").PermissionRequest): AppPermissionRequest {
  return {
    id: input.id,
    sessionID: input.sessionID,
    action: input.permission,
    resources: input.patterns,
    permission: input.permission,
    patterns: input.patterns,
    always: input.always,
    metadata: input.metadata ?? {},
  }
}

function toQuestion(input: import("@opencode-ai/sdk-v1/v2/client").QuestionRequest): AppQuestionRequest {
  return {
    id: input.id,
    sessionID: input.sessionID,
    questions: input.questions.map((question) => ({
      ...question,
      header: question.header ?? "",
      options: question.options.map((option) => ({ ...option, description: option.description ?? "" })),
    })),
  }
}

function toPty(input: import("@opencode-ai/sdk-v1/v2/client").Pty) {
  return { id: input.id, title: input.title }
}

async function toEvent(
  envelope: GlobalEvent,
  messages: Map<string, CachedMessage>,
  loadMessage: (input: LocationInput & { sessionID: string; messageID: string }) => Promise<CachedMessage>,
): Promise<AppEvent> {
  const input = envelope.payload as Event
  const eventLocation =
    envelope.directory === "global"
      ? undefined
      : { location: { directory: envelope.directory, workspaceID: envelope.workspace } }
  if (input.type === "server.connected") {
    messages.clear()
    return { type: input.type }
  }
  if (input.type === "global.disposed") return { type: "server.disposed" }
  if (input.type === "server.instance.disposed")
    return { type: "instance.disposed", location: { directory: input.properties.directory } }
  if (input.type === "project.updated") return { type: input.type, project: toProject(input.properties) }
  if (input.type === "session.created" || input.type === "session.updated")
    return { type: input.type, session: toSession(input.properties.info) }
  if (input.type === "session.deleted") {
    for (const [messageID, message] of messages) {
      if (message.info.sessionID === input.properties.sessionID) messages.delete(messageID)
    }
    return { type: input.type, sessionID: input.properties.sessionID }
  }
  if (input.type === "session.status") {
    const activity = toActivity(input.properties.status)
    if (activity.type === "idle") {
      for (const [messageID, message] of messages) {
        if (message.info.sessionID === input.properties.sessionID) messages.delete(messageID)
      }
    }
    return { type: "session.activity", sessionID: input.properties.sessionID, activity }
  }
  if (input.type === "session.diff")
    return {
      type: input.type,
      sessionID: input.properties.sessionID,
      diff: input.properties.diff.flatMap((item) => (item.file ? [{ ...item, file: item.file }] : [])),
    }
  if (input.type === "todo.updated")
    return {
      type: input.type,
      sessionID: input.properties.sessionID,
      todos: input.properties.todos.map((todo) => ({
        content: todo.content,
        status: todo.status,
        priority: todo.priority,
      })),
    }
  if (input.type === "session.error")
    return { type: input.type, sessionID: input.properties.sessionID, error: input.properties.error }
  if (input.type === "message.updated") {
    const cached = messages.get(input.properties.info.id)
    const value = { info: input.properties.info, parts: cached?.parts ?? [] }
    messages.set(input.properties.info.id, value)
    return { type: "timeline.updated", item: toTimelineItem(value.info, value.parts) }
  }
  if (input.type === "message.part.updated") {
    const messageID = input.properties.part.messageID
    const value = await loadMessage({ sessionID: input.properties.sessionID, messageID, ...eventLocation })
    const parts = [...value.parts.filter((part) => part.id !== input.properties.part.id), input.properties.part]
    const next = { info: value.info, parts }
    messages.set(messageID, next)
    return { type: "timeline.updated", item: toTimelineItem(next.info, next.parts) }
  }
  if (input.type === "message.removed") {
    messages.delete(input.properties.messageID)
    return { type: "timeline.removed", sessionID: input.properties.sessionID, itemID: input.properties.messageID }
  }
  if (input.type === "message.part.removed") {
    const cached = messages.get(input.properties.messageID)
    if (cached)
      messages.set(input.properties.messageID, {
        ...cached,
        parts: cached.parts.filter((part) => part.id !== input.properties.partID),
      })
    return {
      type: "timeline.part.removed",
      sessionID: input.properties.sessionID,
      itemID: input.properties.messageID,
      contentID: input.properties.partID,
    }
  }
  if (input.type === "message.part.delta") {
    const cached = messages.get(input.properties.messageID)
    const part = cached?.parts.find((part) => part.id === input.properties.partID)
    if (cached && part) {
      const current = part[input.properties.field as keyof Part]
      if (typeof current === "string")
        messages.set(input.properties.messageID, {
          ...cached,
          parts: cached.parts.map((item) =>
            item.id === part.id ? { ...item, [input.properties.field]: current + input.properties.delta } : item,
          ),
        })
    }
    return {
      type: "timeline.delta",
      sessionID: input.properties.sessionID,
      itemID: input.properties.messageID,
      contentID: input.properties.partID,
      field: input.properties.field,
      delta: input.properties.delta,
    }
  }
  if (input.type === "permission.asked")
    return { type: "permission.requested", request: toPermission(input.properties) }
  if (input.type === "permission.v2.asked")
    return {
      type: "permission.requested",
      request: {
        id: input.properties.id,
        sessionID: input.properties.sessionID,
        action: input.properties.action,
        resources: [...input.properties.resources],
        permission: input.properties.action,
        patterns: [...input.properties.resources],
        always: [],
        metadata: input.properties.metadata ?? {},
      },
    }
  if (input.type === "permission.replied" || input.type === "permission.v2.replied")
    return {
      type: "permission.replied",
      sessionID: input.properties.sessionID,
      requestID: input.properties.requestID,
    }
  if (input.type === "question.asked" || input.type === "question.v2.asked")
    return { type: "question.requested", request: toQuestion(input.properties) }
  if (input.type === "question.replied" || input.type === "question.v2.replied")
    return { type: "question.replied", sessionID: input.properties.sessionID, requestID: input.properties.requestID }
  if (input.type === "question.rejected" || input.type === "question.v2.rejected")
    return { type: "question.rejected", sessionID: input.properties.sessionID, requestID: input.properties.requestID }
  if (input.type === "file.watcher.updated")
    return { type: "file.changed", path: input.properties.file, change: input.properties.event }
  if (input.type === "vcs.branch.updated") return { type: input.type, branch: input.properties.branch }
  if (input.type === "worktree.ready")
    return { type: input.type, name: input.properties.name, branch: input.properties.branch }
  if (input.type === "worktree.failed") return { type: input.type, message: input.properties.message }
  if (input.type === "lsp.updated") return { type: input.type }
  if (input.type === "reference.updated") return { type: input.type }
  if (input.type === "mcp.tools.changed") return { type: "mcp.updated", server: input.properties.server }
  if (input.type === "pty.exited") return { type: input.type, ptyID: input.properties.id }
  return { type: "unknown", raw: input }
}

function toConfig(input: Config): AppConfig {
  return {
    shell: input.shell,
    model: input.model,
    share: input.share,
    plugin: input.plugin,
    disabledProviders: input.disabled_providers,
    provider: input.provider,
    permission: input.permission,
  }
}

function fromConfig(input: AppConfig): Config {
  return {
    shell: input.shell,
    model: input.model,
    share: input.share,
    plugin: input.plugin?.map((plugin): NonNullable<Config["plugin"]>[number] =>
      typeof plugin === "string" ? plugin : [plugin[0], { ...plugin[1] }],
    ),
    disabled_providers: input.disabledProviders ? [...input.disabledProviders] : undefined,
    provider: input.provider as Config["provider"],
    permission: input.permission as Config["permission"],
  }
}
