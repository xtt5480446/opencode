import type {
  AgentInfo,
  FormCreateInput,
  FormInfo,
  IntegrationInfo,
  McpServer,
  ModelInfo,
  OpenCodeClient,
  OpenCodeEvent,
  PermissionV2Request,
  Project,
  QuestionV2Request,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionPendingInfo,
  ShellInfo1,
} from "@opencode-ai/client"
import type {
  AppAgent,
  AppClient,
  AppEvent,
  AppFileDiff,
  AppMcpServer,
  AppModel,
  AppPermissionRequest,
  AppProject,
  AppQuestionRequest,
  AppSession,
  FormField,
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationConnection,
  IntegrationMethod,
  LocationInput,
  LocationRef,
  PendingSessionInput,
  PromptFile,
  PromptInput,
  PtyTransportConfig,
  RequestOptions,
  SessionActivity,
  SessionLogItem,
  ShellProcess,
  TimelineContent,
  TimelineItem,
} from "./backend"

export function createV2Backend(
  client: OpenCodeClient,
  transportConfig: PtyTransportConfig,
  defaultLocation?: LocationRef,
  eventClient: OpenCodeClient = client,
): AppClient {
  const request = (input?: RequestOptions) => ({ signal: input?.signal })
  const location = (input?: LocationInput) => toLocation(input?.location ?? defaultLocation)
  const projectedContent = new Map<string, TimelineContent>()
  const projectedItems = new Map<string, TimelineItem>()
  const projectedSessions = new Map<string, AppSession>()
  const projectedPrompts = new Map<string, { sessionID: string; content: TimelineContent[] }>()
  const selections = new Map<string, { agent?: string; model?: { id: string; providerID: string; variant?: string } }>()
  const sessionAdmissions = new Map<string, Promise<void>>()
  const projectSession = (input: SessionInfo) => {
    const result = toSession(input)
    projectedSessions.set(result.id, result)
    selections.set(result.id, { agent: input.agent, model: input.model })
    return result
  }
  const loadSession = async (input: LocationInput & { sessionID: string }, options?: RequestOptions) =>
    projectSession(await client.session.get({ sessionID: input.sessionID }, request(options)))

  return {
    version: "v2",
    common: {
      health: { get: (options) => client.health.get(request(options)) },
      projects: {
        current: async (input, options) =>
          (await client.location.get({ location: location(input) }, request(options))).project,
      },
      catalog: {
        providers: async (input, options) => {
          const params = { location: location(input) }
          const [providers, models] = await Promise.all([
            client.provider.list(params, request(options)),
            client.model.list(params, request(options)),
          ])
          return {
            providers: new Map(
              providers.data.map((provider) => [
                provider.id,
                {
                  id: provider.id,
                  name: provider.name,
                  integrationID: provider.integrationID,
                  models: Object.fromEntries(
                    models.data
                      .filter((model) => model.providerID === provider.id && model.status !== "deprecated")
                      .map((model) => [model.id, toModel(model)]),
                  ),
                },
              ]),
            ),
            connected: providers.data.filter((provider) => !provider.disabled).map((provider) => provider.id),
            defaults: {},
          }
        },
        agents: async (input, options) =>
          (await client.agent.list({ location: location(input) }, request(options))).data.map(toAgent),
      },
      commands: {
        list: async (input, options) =>
          (await client.command.list({ location: location(input) }, request(options))).data.map((item) => ({
            name: item.name,
            description: item.description,
          })),
      },
      references: {
        list: async (input, options) =>
          (await client.reference.list({ location: location(input) }, request(options))).data.map((item) => ({
            name: item.name,
            path: item.path,
            description: item.description,
            hidden: item.hidden,
            source: item.source,
          })),
      },
      sessions: {
        list: async (input, options) => {
          const params = {
            workspace: input?.location?.workspaceID ?? defaultLocation?.workspaceID,
            directory: input?.location?.directory ?? defaultLocation?.directory,
            search: input?.search,
          }
          const results = new Map<string, SessionInfo>()
          const target = input?.limit ?? Number.POSITIVE_INFINITY
          let cursor = input?.cursor
          let newer: string | undefined
          const cursors = new Set<string>()
          do {
            if (cursor) {
              if (cursors.has(cursor)) break
              cursors.add(cursor)
            }
            const result = await client.session.list(
              { ...params, limit: input?.roots ? 1 : input?.limit, cursor },
              request(options),
            )
            if (newer === undefined) newer = result.cursor.previous ?? undefined
            result.data.filter((item) => !input?.roots || !item.parentID).forEach((item) => results.set(item.id, item))
            cursor = result.cursor.next ?? undefined
            if (!input?.roots || results.size >= target) break
          } while (cursor)
          return {
            items: [...results.values()].slice(0, target).map(projectSession),
            newer,
            older: cursor,
          }
        },
        create: async (input, options) =>
          projectSession(
            await client.session.create(
              { location: input?.location ?? defaultLocation, agent: input?.agent, model: input?.model },
              request(options),
            ),
          ),
        get: loadSession,
        interrupt: async (input, options) => {
          await client.session.interrupt({ sessionID: input.sessionID }, request(options))
        },
        activity: (_input, options) => client.session.active(request(options)),
        history: async (input, options) => {
          const result = await client.message.list(
            { sessionID: input.sessionID, limit: input.limit, cursor: input.cursor },
            request(options),
          )
          return {
            items: result.data.map((item) =>
              toTimelineItem(item, input.sessionID, undefined, projectedPrompts.get(item.id)?.content),
            ),
            newer: result.cursor.previous ?? undefined,
            older: result.cursor.next ?? undefined,
          }
        },
        message: async (input, options) =>
          toTimelineItem(
            await client.session.message({ sessionID: input.sessionID, messageID: input.messageID }, request(options)),
            input.sessionID,
            undefined,
            projectedPrompts.get(input.messageID)?.content,
          ),
        prompt: (input, options) => {
          const previous = sessionAdmissions.get(input.sessionID) ?? Promise.resolve()
          const admission = previous.catch(() => undefined).then(async () => {
            const selected = selections.get(input.sessionID)
            if (input.selection?.agent && input.selection.agent !== selected?.agent) {
              await client.session.switchAgent(
                { sessionID: input.sessionID, agent: input.selection.agent },
                request(options),
              )
              selections.set(input.sessionID, { ...selected, agent: input.selection.agent })
            }
            const current = selections.get(input.sessionID)
            if (input.selection?.model && !sameModel(input.selection.model, current?.model)) {
              await client.session.switchModel(
                { sessionID: input.sessionID, model: input.selection.model },
                request(options),
              )
              selections.set(input.sessionID, { ...current, model: input.selection.model })
            }
            const parts = input.parts
            if (parts) projectedPrompts.set(input.id, { sessionID: input.sessionID, content: toPromptContent(parts) })
            const response = await transportConfig.fetch(
              nativeSessionURL(transportConfig, input.sessionID, "/prompt"),
              {
                method: "POST",
                signal: options?.signal,
                headers: transportHeaders(transportConfig, false, true),
                body: JSON.stringify({
                  id: input.id,
                  prompt: {
                    text:
                      parts
                        ?.filter((part) => part.type === "text")
                        .map((part) => part.text)
                        .join("") ?? input.text,
                    files:
                      parts
                        ?.filter((part) => part.type === "file")
                        .map((file) => ({
                          uri: file.url,
                          mime: file.mime,
                          name: file.filename,
                          source: file.source && {
                            start: file.source.text.start,
                            end: file.source.text.end,
                            text: file.source.text.value,
                          },
                        })) ?? input.files?.map(toPromptFile),
                    agents:
                      parts
                        ?.filter((part) => part.type === "agent")
                        .map((agent) => ({
                          name: agent.name,
                          source: agent.source && {
                            start: agent.source.start,
                            end: agent.source.end,
                            text: agent.source.value,
                          },
                        })) ??
                      input.agents?.map((agent) => ({
                        name: agent.name,
                        source:
                          agent.start === undefined || agent.end === undefined || agent.text === undefined
                            ? undefined
                            : { start: agent.start, end: agent.end, text: agent.text },
                      })),
                  },
                  delivery: input.delivery,
                }),
              },
            )
            if (response.ok) return
            projectedPrompts.delete(input.id)
            throw new Error(`Failed to submit prompt: ${response.status} ${response.statusText}`)
          })
          sessionAdmissions.set(input.sessionID, admission)
          return admission.finally(() => {
            if (sessionAdmissions.get(input.sessionID) === admission) sessionAdmissions.delete(input.sessionID)
          })
        },
      },
      files: {
        list: async (input, options) =>
          (await client.file.list({ location: location(input), path: input.path }, request(options))).data.map((item) => ({
            ...item,
            name: item.path.split(/[\\/]/).at(-1) ?? item.path,
            absolute: item.path,
            ignored: false,
          })),
        find: async (input, options) =>
          (
            await client.file.find(
              { location: location(input), query: input.query, type: input.type, limit: input.limit },
              request(options),
            )
          ).data,
        read: async (input, options) => {
          const response = await transportConfig.fetch(
            nativeFileURL(transportConfig, input.path, input.location ?? defaultLocation),
            { signal: options?.signal, headers: transportHeaders(transportConfig) },
          )
          if (!response.ok) throw new Error(`Failed to read file: ${response.status} ${response.statusText}`)
          const mimeType = response.headers.get("content-type") ?? undefined
          return {
            bytes: new Uint8Array(await response.arrayBuffer()),
            kind: mimeType?.startsWith("text/") ? "text" : "binary",
            mimeType,
          }
        },
      },
      permissions: {
        pending: async (input, options) =>
          (await client.permission.request.list({ location: location(input) }, request(options))).data.map(toPermission),
        reply: async (input, options) => {
          await client.permission.reply(input, request(options))
        },
      },
      questions: {
        pending: async (input, options) =>
          (await client.question.request.list({ location: location(input) }, request(options))).data.map(toQuestion),
        reply: async (input, options) => {
          await client.question.reply({ ...input, answers: input.answers.map((answer) => [...answer]) }, request(options))
        },
        reject: async (input, options) => {
          await client.question.reject(input, request(options))
        },
      },
      pty: {
        list: async (input, options) =>
          (await client.pty.list({ location: location(input) }, request(options))).data.map(toPty),
        create: async (input, options) =>
          toPty(
            (
              await client.pty.create(
                {
                  location: location(input),
                  title: input.title,
                  command: input.command,
                  args: input.args,
                  cwd: input.cwd,
                  env: input.env,
                },
                request(options),
              )
            ).data,
          ),
        get: async (input, options) =>
          toPty((await client.pty.get({ ptyID: input.ptyID, location: location(input) }, request(options))).data),
        update: async (input, options) =>
          toPty(
            (
              await client.pty.update(
                { ptyID: input.ptyID, location: location(input), title: input.title, size: input.size },
                request(options),
              )
            ).data,
          ),
        remove: async (input, options) => {
          await client.pty.remove({ ptyID: input.ptyID, location: location(input) }, request(options))
        },
      },
      events: {
        subscribe: (options) => ({
          async *[Symbol.asyncIterator]() {
            for await (const input of eventClient.event.subscribe(request(options))) {
              yield {
                location: input.location,
                event: toEvent(input, projectedContent, projectedItems, projectedSessions, projectedPrompts),
              }
            }
          },
        }),
      },
    },
    capabilities: {
      ptyTransport: {
        connectToken: async (input, options) => {
          const response = await transportConfig.fetch(
            nativePtyURL(transportConfig, input.ptyID, "/connect-token", input.location ?? defaultLocation),
            {
              method: "POST",
              signal: options?.signal,
              headers: transportHeaders(transportConfig, true),
            },
          )
          const body = response.ok ? ((await response.json()) as { data?: { ticket?: string } }) : undefined
          return { status: response.status, ticket: body?.data?.ticket }
        },
        exists: async (input, options) => {
          const response = await transportConfig.fetch(
            nativePtyURL(transportConfig, input.ptyID, "", input.location ?? defaultLocation),
            { signal: options?.signal, headers: transportHeaders(transportConfig) },
          )
          return response.status !== 404
        },
        connectURL: (input) => {
          const url = nativePtyURL(transportConfig, input.ptyID, "/connect", input.location)
          url.searchParams.set("cursor", String(input.cursor))
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
          if (input.ticket) {
            url.searchParams.set("ticket", input.ticket)
            return url
          }
          if (!transportConfig.sameOrigin || transportConfig.password || transportConfig.authToken)
            throw new Error("Native PTY connections require a ticket for cross-origin or authenticated access")
          return url
        },
      },
      integrationsV2: {
        list: async (input, options) =>
          (await client.integration.list({ location: location(input) }, request(options))).data.map(toIntegration),
        get: async (input, options) => {
          const result = await client.integration.get(
            { integrationID: input.integrationID, location: location(input) },
            request(options),
          )
          return result.data ? toIntegration(result.data) : null
        },
        connectKey: async (input, options) => {
          await client.integration.connect.key({ ...input, location: location(input) }, request(options))
        },
        connectOauth: async (input, options) =>
          toIntegrationAttempt(
            (
              await client.integration.connect.oauth(
                {
                  integrationID: input.integrationID,
                  methodID: input.methodID,
                  inputs: input.values,
                  label: input.label,
                  location: location(input),
                },
                request(options),
              )
            ).data,
          ),
        attemptStatus: async (input, options) =>
          toAttemptStatus(
            (
              await client.integration.attempt.status(
                { attemptID: input.attemptID, location: location(input) },
                request(options),
              )
            ).data,
          ),
        completeAttempt: async (input, options) => {
          await client.integration.attempt.complete({ ...input, location: location(input) }, request(options))
        },
        cancelAttempt: async (input, options) => {
          await client.integration.attempt.cancel({ ...input, location: location(input) }, request(options))
        },
        renameCredential: async (input, options) => {
          await client.credential.update({ ...input, location: location(input) }, request(options))
        },
        removeCredential: async (input, options) => {
          await client.credential.remove({ ...input, location: location(input) }, request(options))
        },
      },
      sessionExtrasV2: {
        switchAgent: async (input, options) => {
          await client.session.switchAgent(input, request(options))
          selections.set(input.sessionID, { ...selections.get(input.sessionID), agent: input.agent })
        },
        switchModel: async (input, options) => {
          await client.session.switchModel(input, request(options))
          selections.set(input.sessionID, { ...selections.get(input.sessionID), model: input.model })
        },
        wait: async (input, options) => {
          await client.session.wait(input, request(options))
        },
        context: async (input, options) =>
          (await client.session.context(input, request(options))).map((item) => toTimelineItem(item, input.sessionID)),
        log: (input, options) => ({
          async *[Symbol.asyncIterator]() {
            for await (const item of nativeSessionEvents(transportConfig, input.sessionID, input.after, options)) {
              yield {
                sequence: eventSequence(item),
                event: toEvent(item, projectedContent, projectedItems, projectedSessions, projectedPrompts),
              } satisfies SessionLogItem
            }
          },
        }),
        stageRevert: async (input, options) => {
          const result = await client.session.revert.stage(
            { sessionID: input.sessionID, messageID: input.messageID, files: input.files?.length ? true : undefined },
            request(options),
          )
          return { messageID: result.messageID }
        },
        clearRevert: async (input, options) => {
          await client.session.revert.clear(input, request(options))
        },
        commitRevert: async (input, options) => {
          await client.session.revert.commit(input, request(options))
        },
      },
      projectCopiesV2: {
        create: (input, options) => client.projectCopy.create({ ...input, location: location(input) }, request(options)),
        remove: async (input, options) => {
          await client.projectCopy.remove({ ...input, location: location(input) }, request(options))
        },
        refresh: async (input, options) => {
          await client.projectCopy.refresh({ ...input, location: location(input) }, request(options))
        },
      },
      savedPermissionsV2: {
        list: (input, options) => client.permission.saved.list(input, request(options)),
        remove: async (input, options) => {
          await client.permission.saved.remove(input, request(options))
        },
      },
    },
  }
}

function toLocation(input?: LocationRef) {
  if (!input) return
  return { directory: input.directory, workspace: input.workspaceID }
}

function sameModel(
  left: { id: string; providerID: string; variant?: string },
  right?: { id: string; providerID: string; variant?: string },
) {
  return left.id === right?.id && left.providerID === right.providerID && left.variant === right.variant
}

function nativeSessionURL(config: PtyTransportConfig, sessionID: string, suffix: string) {
  return new URL(`${config.baseUrl.replace(/\/+$/, "")}/api/session/${encodeURIComponent(sessionID)}${suffix}`)
}

function nativePtyURL(config: PtyTransportConfig, ptyID: string, suffix: string, location?: LocationRef) {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, "")}/api/pty/${encodeURIComponent(ptyID)}${suffix}`)
  if (location?.directory) url.searchParams.set("location[directory]", location.directory)
  if (location?.workspaceID) url.searchParams.set("location[workspace]", location.workspaceID)
  return url
}

function nativeFileURL(config: PtyTransportConfig, path: string, location?: LocationRef) {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, "")}/api/fs/read/${encodeURIComponent(path)}`)
  if (location?.directory) url.searchParams.set("location[directory]", location.directory)
  if (location?.workspaceID) url.searchParams.set("location[workspace]", location.workspaceID)
  return url
}

function transportHeaders(config: PtyTransportConfig, ticket = false, json = false) {
  const headers = new Headers()
  if (config.password)
    headers.set("authorization", `Basic ${btoa(`${config.username ?? "opencode"}:${config.password}`)}`)
  if (ticket) headers.set("x-opencode-ticket", "1")
  if (json) headers.set("content-type", "application/json")
  return headers
}

function toProject(input: Project): AppProject {
  return {
    id: input.id,
    worktree: input.worktree,
    vcs: input.vcs === "git" ? "git" : undefined,
    time: input.time,
    name: input.name,
    icon: input.icon,
    commands: input.commands,
    sandboxes: input.sandboxes,
  }
}

function toSession(input: SessionInfo): AppSession {
  return {
    id: input.id,
    slug: input.id,
    version: "",
    parentID: input.parentID,
    projectID: input.projectID,
    location: input.location,
    directory: input.location.directory,
    workspaceID: input.location.workspaceID,
    title: input.title,
    cost: input.cost,
    tokens: input.tokens,
    time: input.time,
    revert: input.revert && { messageID: input.revert.messageID },
  }
}

function toModel(input: ModelInfo): AppModel {
  const cost = input.cost[0]
  return {
    id: input.id,
    providerID: input.providerID,
    name: input.name,
    family: input.family,
    releaseDate: new Date(input.time.released).toISOString().slice(0, 10),
    cost: cost && { input: cost.input, output: cost.output, cacheRead: cost.cache.read, cacheWrite: cost.cache.write },
    capabilities: {
      reasoning: input.capabilities.output.includes("reasoning"),
      input: {
        text: input.capabilities.input.includes("text"),
        image: input.capabilities.input.includes("image"),
        audio: input.capabilities.input.includes("audio"),
        video: input.capabilities.input.includes("video"),
        pdf: input.capabilities.input.includes("pdf"),
      },
    },
    limit: { context: input.limit.context, output: input.limit.output },
    variants: Object.fromEntries(input.variants.map((variant) => [variant.id, variant])),
  }
}

function toAgent(input: AgentInfo): AppAgent {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    mode: input.mode,
    hidden: input.hidden,
    color: input.color,
    model: input.model,
  }
}

function toTimelineItem(
  input: SessionMessageInfo,
  sessionID: string,
  parentID?: string,
  projectedPrompt?: TimelineContent[],
): TimelineItem {
  if (input.type === "user") {
    return {
      type: "user",
      id: input.id,
      sessionID,
      created: input.time.created,
      content: projectedPrompt ?? [
        { type: "text", id: `${input.id}:text`, text: input.text },
        ...(input.files?.map((file, index) => ({
          type: "file" as const,
          id: `${input.id}:file:${index}`,
          uri: file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
          name: file.name,
          mime: file.mime,
        })) ?? []),
        ...(input.agents?.map((agent, index) => ({
          type: "agent" as const,
          id: `${input.id}:agent:${index}`,
          name: agent.name,
          source: agent.mention,
        })) ?? []),
      ],
    }
  }
  if (input.type === "assistant") return toAssistant(input, sessionID, parentID)
  const type =
    input.type === "agent-switched"
      ? "agent-switch"
      : input.type === "model-switched"
        ? "model-switch"
        : input.type
  return { type, id: input.id, sessionID, created: input.time.created }
}

function toAssistant(input: SessionMessageAssistant, sessionID: string, parentID?: string): TimelineItem {
  return {
    type: "assistant",
    id: input.id,
    sessionID,
    parentID,
    created: input.time.created,
    completed: input.time.completed,
    content: input.content.flatMap((item, index): TimelineContent[] => {
      if (item.type === "text") return [{ type: "text", id: `${input.id}:text:${index}`, text: item.text }]
      if (item.type === "reasoning")
        return [{ type: "reasoning", id: `${input.id}:reasoning:${index}`, text: item.text }]
      if (item.state.status === "streaming")
        return [
          {
            type: "tool",
            id: item.id,
            tool: item.name,
            state: { status: "pending", input: {}, raw: item.state.input },
          },
        ]
      if (item.state.status === "running")
        return [
          {
            type: "tool",
            id: item.id,
            tool: item.name,
            state: {
              status: "running",
              input: item.state.input,
              metadata: item.state.structured,
              time: { start: input.time.created },
            },
          },
        ]
      if (item.state.status === "error")
        return [
          {
            type: "tool",
            id: item.id,
            tool: item.name,
            state: {
              status: "error",
              input: item.state.input,
              error: item.state.error.message,
              metadata: item.state.structured,
              time: { start: input.time.created, end: input.time.completed ?? input.time.created },
            },
          },
        ]
      return [
        {
          type: "tool",
          id: item.id,
          tool: item.name,
          state: {
            status: "completed",
            input: item.state.input,
            output: item.state.content
              .map((content) => (content.type === "text" ? content.text : content.uri))
              .join("\n"),
            title: "",
            metadata: item.state.structured,
            time: { start: input.time.created, end: input.time.completed ?? input.time.created },
          },
        },
      ]
    }),
    agent: input.agent,
    model: input.model,
    tokens: input.tokens,
    error: input.error && { name: "UnknownError", data: { message: input.error.message } },
  }
}

function toPromptFile(input: PromptFile) {
  return {
    uri: input.uri,
    mime: input.mime ?? "application/octet-stream",
    name: input.name,
    source: input.source && { start: input.source.start, end: input.source.end, text: input.source.text },
  }
}

function toPromptContent(parts: NonNullable<PromptInput["parts"]>): TimelineContent[] {
  return parts.map((part) => {
    if (part.type === "text") return { ...part }
    if (part.type === "agent")
      return {
        type: part.type,
        id: part.id,
        name: part.name,
        source: part.source && { text: part.source.value, start: part.source.start, end: part.source.end },
      }
    return {
      type: part.type,
      id: part.id,
      uri: part.url,
      name: part.filename,
      mime: part.mime,
      source:
        part.source?.type === "resource"
          ? {
              type: part.source.type,
              clientName: part.source.clientName,
              uri: part.source.uri,
              text: { text: part.source.text.value, start: part.source.text.start, end: part.source.text.end },
            }
          : part.source && {
              type: part.source.type,
              path: part.source.path,
              name: part.source.type === "symbol" ? part.source.name : undefined,
              kind: part.source.type === "symbol" ? part.source.kind : undefined,
              text: { text: part.source.text.value, start: part.source.text.start, end: part.source.text.end },
            },
    }
  })
}

function toPermission(input: PermissionV2Request): AppPermissionRequest {
  return {
    id: input.id,
    sessionID: input.sessionID,
    action: input.action,
    resources: input.resources,
    permission: input.action,
    patterns: [...input.resources],
    always: [],
    metadata: input.metadata ? { ...input.metadata } : {},
  }
}

function toQuestion(input: QuestionV2Request): AppQuestionRequest {
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

function toFileDiff(input: { file: string; patch: string; additions: number; deletions: number; status: "added" | "deleted" | "modified" }): AppFileDiff {
  return input
}

function toMcpServer(input: McpServer): AppMcpServer {
  return { name: input.name, status: input.status, integrationID: input.integrationID }
}

function toPty(input: { id: string; title: string }) {
  return { id: input.id, title: input.title }
}

function toIntegration(input: IntegrationInfo) {
  return {
    id: input.id,
    name: input.name,
    methods: input.methods.map((method): IntegrationMethod => {
      if (method.type === "oauth") return method
      if (method.type === "key") return { type: "key", label: method.label ?? "API key" }
      return { type: "environment", label: method.names.join(", ") }
    }),
    connections: input.connections.map((connection): IntegrationConnection =>
      connection.type === "credential"
        ? { id: connection.id, label: connection.label, kind: "credential" }
        : { id: connection.name, label: connection.name, kind: "environment" },
    ),
  }
}

function toIntegrationAttempt(input: {
  attemptID: string
  url: string
  instructions: string
  mode: "auto" | "code"
  time: { created: number | string; expires: number | string }
}): IntegrationAttempt {
  return {
    ...input,
    time: { created: Number(input.time.created), expires: Number(input.time.expires) },
  }
}

function toAttemptStatus(input: import("@opencode-ai/client").IntegrationAttemptStatus): IntegrationAttemptStatus {
  if (input.status === "failed") return { status: input.status, error: input.message }
  return { status: input.status }
}

function toPending(input: SessionPendingInfo): PendingSessionInput {
  return {
    id: input.id,
    sessionID: input.sessionID,
    sequence: input.admittedSeq,
    created: input.timeCreated,
    delivery: "delivery" in input ? input.delivery : undefined,
    raw: input,
  }
}

function toForm(input: FormInfo) {
  return {
    id: input.id,
    sessionID: input.sessionID,
    title: input.title,
    metadata: input.metadata,
    fields: input.fields.map((field): FormField => {
      if (field.type === "external")
        return {
          type: field.type,
          key: field.key,
          label: field.title ?? field.key,
          url: field.url,
          description: field.description,
        }
      if (field.type === "multiselect")
        return {
          type: field.type,
          key: field.key,
          label: field.title ?? field.key,
          options: field.options.map((option) => option.value),
          required: field.required,
          description: field.description,
        }
      return {
        type: field.type,
        key: field.key,
        label: field.title ?? field.key,
        required: field.required,
        description: field.description,
      }
    }),
  }
}

function fromFormField(input: FormField): FormCreateInput["fields"][number] {
  if (input.type === "external")
    return { type: input.type, key: input.key, title: input.label, url: input.url, description: input.description }
  if (input.type === "multiselect")
    return {
      type: input.type,
      key: input.key,
      title: input.label,
      options: input.options.map((option) => ({ value: option, label: option })),
      required: input.required,
      description: input.description,
    }
  return {
    type: input.type,
    key: input.key,
    title: input.label,
    required: input.type === "boolean" ? undefined : input.required,
    description: input.description,
  }
}

function toClientRecord(input: Readonly<Record<string, import("./backend").JsonValue>>) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, toClientJson(value)]))
}

function toClientJson(input: import("./backend").JsonValue): import("@opencode-ai/client").JsonValue {
  if (isJsonArray(input)) return input.map(toClientJson)
  if (input && typeof input === "object") return toClientRecord(input)
  return input
}

function isJsonArray(input: import("./backend").JsonValue): input is readonly import("./backend").JsonValue[] {
  return Array.isArray(input)
}

function toShell(input: ShellInfo1): ShellProcess {
  return {
    id: input.id,
    command: input.command,
    cwd: input.cwd,
    status: input.status === "running" ? "running" : "exited",
    created: input.time.started,
    exitCode: input.exit,
    metadata: input.metadata,
  }
}

type NativeEventData = {
  sessionID: string
  assistantMessageID: string
  messageID: string
  partID: string
  requestID: string
  textID: string
  reasoningID: string
  callID: string
  timestamp: number
  agent: string
  model: { id: string; providerID: string; variant?: string }
  finish: string
  cost: number
  tokens: import("./backend").TokenUsage
  error: { message: string }
  location: LocationRef
  revert: { messageID: string }
  prompt: { text: string; files?: { uri: string; name?: string; mime?: string }[]; agents?: { name: string; source?: import("./backend").SourceText }[] }
  text: string
  delta: string
  field: string
  name: string
  tool: string
  input: Record<string, unknown>
  structured: Record<string, unknown>
  content: import("./backend").ToolOutputContent[]
  outputPaths: string[]
  result: unknown
  provider: import("./backend").ToolProviderInfo
  providerMetadata: Record<string, unknown>
  info: unknown
  todos: { content: string; status: string; priority: string }[]
  diff: { file?: string; patch?: string; additions: number; deletions: number; status?: "added" | "deleted" | "modified" }[]
}

function toEvent(
  input: OpenCodeEvent,
  projectedContent: Map<string, TimelineContent>,
  projectedItems: Map<string, TimelineItem>,
  projectedSessions: Map<string, AppSession>,
  projectedPrompts: Map<string, { sessionID: string; content: TimelineContent[] }>,
): AppEvent {
  const type = input.type as string
  const data = input.data as unknown as NativeEventData
  if (type === "server.connected") {
    projectedContent.clear()
    projectedItems.clear()
    projectedSessions.clear()
    projectedPrompts.clear()
    return { type: "server.connected" }
  }
  if (type === "session.created" || type === "session.updated") {
    const session = eventSession(data.info)
    if (!session) return { type: "unknown", raw: input }
    projectedSessions.set(session.id, session)
    return { type: type === "session.created" ? "session.created" : "session.updated", session }
  }
  if (type === "session.deleted") {
    projectedSessions.delete(data.sessionID)
    clearSessionProjection(data.sessionID, projectedContent, projectedItems)
    clearSessionPrompts(data.sessionID, projectedPrompts)
    return { type: "session.deleted", sessionID: data.sessionID }
  }
  if (type === "session.next.moved") {
    const current = projectedSessions.get(data.sessionID)
    if (current)
      projectedSessions.set(current.id, {
        ...current,
        location: data.location,
        directory: data.location.directory,
        workspaceID: data.location.workspaceID,
      })
    return { type: "session.moved", sessionID: data.sessionID, location: data.location }
  }
  if (type === "session.next.revert.staged") {
    const revert = { messageID: data.revert.messageID }
    const current = projectedSessions.get(data.sessionID)
    if (current) projectedSessions.set(current.id, { ...current, revert })
    return { type: "session.revert", sessionID: data.sessionID, revert }
  }
  if (type === "session.next.revert.cleared" || type === "session.next.revert.committed") {
    const current = projectedSessions.get(data.sessionID)
    if (current) projectedSessions.set(current.id, { ...current, revert: undefined })
    return { type: "session.revert", sessionID: data.sessionID }
  }
  if (
    type === "integration.updated" ||
    type === "integration.connection.updated" ||
    type === "catalog.updated" ||
    type === "models-dev.refreshed"
  )
    return { type: "provider.updated" }
  if (type === "permission.v2.asked")
    return { type: "permission.requested", request: toPermission(input.data as PermissionV2Request) }
  if (type === "permission.v2.replied")
    return { type: "permission.replied", sessionID: data.sessionID, requestID: data.requestID }
  if (type === "question.v2.asked")
    return { type: "question.requested", request: toQuestion(input.data as QuestionV2Request) }
  if (type === "question.v2.replied" || type === "question.v2.rejected")
    return {
      type: type === "question.v2.replied" ? "question.replied" : "question.rejected",
      sessionID: data.sessionID,
      requestID: data.requestID,
    }
  if (type === "file.watcher.updated" || type === "filesystem.changed") {
    const changed = input.data as unknown as { file: string; event: "add" | "change" | "unlink" }
    return { type: "file.changed", path: changed.file, change: changed.event }
  }
  if (type === "pty.exited") return { type: "pty.exited", ptyID: (input.data as unknown as { id: string }).id }
  if (type === "message.removed")
    return { type: "timeline.removed", sessionID: data.sessionID, itemID: data.messageID }
  if (type === "session.next.prompted" || type === "session.next.prompt.admitted")
    return {
      type: "timeline.updated",
      item: {
        type: "user",
        id: data.messageID,
        sessionID: data.sessionID,
        created: data.timestamp,
        content: projectedPrompts.get(data.messageID)?.content ?? [
          { type: "text", id: `${data.messageID}:text`, text: data.prompt.text },
          ...(data.prompt.files?.map((file, index) => ({
            type: "file" as const,
            id: `${data.messageID}:file:${index}`,
            uri: file.uri,
            name: file.name,
            mime: file.mime,
          })) ?? []),
          ...(data.prompt.agents?.map((agent, index) => ({
            type: "agent" as const,
            id: `${data.messageID}:agent:${index}`,
            name: agent.name,
            source: agent.source,
          })) ?? []),
        ],
      },
    }
  if (type === "session.next.step.started") {
    const item = {
      type: "assistant" as const,
      id: data.assistantMessageID,
      sessionID: data.sessionID,
      created: data.timestamp,
      content: [] as TimelineContent[],
      agent: data.agent,
      model: data.model,
    }
    projectedItems.set(item.id, item)
    return { type: "session.activity", sessionID: data.sessionID, activity: { type: "running" }, item }
  }
  if (type === "session.next.step.ended") {
    const current = projectedItems.get(data.assistantMessageID)
    const item =
      current?.type === "assistant"
        ? {
            ...current,
            completed: data.timestamp,
            finish: data.finish,
            cost: data.cost,
            tokens: data.tokens,
            content: projectedMessageContent(data.assistantMessageID, projectedContent),
          }
        : undefined
    projectedItems.delete(data.assistantMessageID)
    clearMessageContent(data.assistantMessageID, projectedContent)
    clearSessionPrompts(data.sessionID, projectedPrompts)
    return { type: "session.activity", sessionID: data.sessionID, activity: { type: "idle" }, item }
  }
  if (type === "session.next.step.failed") {
    const current = projectedItems.get(data.assistantMessageID)
    const item =
      current?.type === "assistant"
        ? {
            ...current,
            completed: data.timestamp,
            error: { name: "UnknownError" as const, data: { message: data.error.message } },
            content: projectedMessageContent(data.assistantMessageID, projectedContent),
          }
        : undefined
    projectedItems.delete(data.assistantMessageID)
    clearMessageContent(data.assistantMessageID, projectedContent)
    clearSessionPrompts(data.sessionID, projectedPrompts)
    return { type: "session.activity", sessionID: data.sessionID, activity: { type: "idle" }, item }
  }
  if (type === "session.next.text.started" || type === "session.next.text.ended") {
    const content = {
      type: "text" as const,
      id: data.textID,
      text: type === "session.next.text.ended" ? data.text : "",
    }
    projectedContent.set(`${data.assistantMessageID}:${content.id}`, content)
    return {
      type: "timeline.content.updated",
      sessionID: data.sessionID,
      itemID: data.assistantMessageID,
      content,
    }
  }
  if (type === "session.next.reasoning.started" || type === "session.next.reasoning.ended") {
    const content = {
      type: "reasoning" as const,
      id: data.reasoningID,
      text: type === "session.next.reasoning.ended" ? data.text : "",
      metadata: data.providerMetadata,
      time: { start: data.timestamp, end: type === "session.next.reasoning.ended" ? data.timestamp : undefined },
    }
    projectedContent.set(`${data.assistantMessageID}:${content.id}`, content)
    return {
      type: "timeline.content.updated",
      sessionID: data.sessionID,
      itemID: data.assistantMessageID,
      content,
    }
  }
  if (
    type === "session.next.tool.input.started" ||
    type === "session.next.tool.input.ended" ||
    type === "session.next.tool.called" ||
    type === "session.next.tool.progress" ||
    type === "session.next.tool.success" ||
    type === "session.next.tool.failed"
  ) {
    const key = `${data.assistantMessageID}:${data.callID}`
    const previous = projectedContent.get(key)
    const tool = previous?.type === "tool" ? previous.tool : data.name ?? data.tool
    const priorInput = previous?.type === "tool" ? previous.state.input : {}
    const state = (() => {
      if (type === "session.next.tool.input.started")
        return { status: "pending" as const, input: {}, raw: "" }
      if (type === "session.next.tool.input.ended")
        return { status: "pending" as const, input: {}, raw: data.text }
      if (type === "session.next.tool.called")
        return {
          status: "running" as const,
          input: data.input,
          time: { start: data.timestamp },
          provider: data.provider,
        }
      if (type === "session.next.tool.progress")
        return {
          status: "running" as const,
          input: priorInput,
          metadata: data.structured,
          time: { start: data.timestamp },
          content: data.content,
        }
      if (type === "session.next.tool.failed")
        return {
          status: "error" as const,
          input: priorInput,
          error: data.error.message,
          time: { start: data.timestamp, end: data.timestamp },
          result: data.result,
          provider: data.provider,
        }
      return {
        status: "completed" as const,
        input: priorInput,
        output: data.content.map((content) => (content.type === "text" ? content.text : content.uri)).join("\n"),
        title: "",
        metadata: data.structured,
        time: { start: data.timestamp, end: data.timestamp },
        content: data.content,
        outputPaths: data.outputPaths,
        result: data.result,
        provider: data.provider,
        attachments: data.content.flatMap((content, index) =>
          content.type === "file"
            ? [
                {
                  id: `${data.callID}:attachment:${index}`,
                  sessionID: data.sessionID,
                  messageID: data.assistantMessageID,
                  type: "file" as const,
                  mime: content.mime,
                  filename: content.name,
                  url: content.uri,
                },
              ]
            : [],
        ),
      }
    })()
    const content = { type: "tool" as const, id: data.callID, callID: data.callID, tool, state }
    projectedContent.set(key, content)
    return {
      type: "timeline.content.updated",
      sessionID: data.sessionID,
      itemID: data.assistantMessageID,
      content,
    }
  }
  if (type === "todo.updated")
    return {
      type: "todo.updated",
      sessionID: data.sessionID,
      todos: data.todos.map((todo) => ({
        content: todo.content,
        status: todo.status,
        priority: todo.priority,
      })),
    }
  if (type === "reference.updated") return { type: "reference.updated" }
  if (type === "session.diff")
    return {
      type: "session.diff",
      sessionID: data.sessionID,
      diff: data.diff.flatMap((item) => (item.file ? [{ ...item, file: item.file }] : [])),
    }
  if (type === "message.part.removed") {
    projectedContent.delete(`${data.messageID}:${data.partID}`)
    return {
      type: "timeline.part.removed",
      sessionID: data.sessionID,
      itemID: data.messageID,
      contentID: data.partID,
    }
  }
  if (type === "message.part.delta")
    return projectDelta(
      {
        type: "timeline.delta",
        sessionID: data.sessionID,
        itemID: data.messageID,
        contentID: data.partID,
        field: data.field,
        delta: data.delta,
      },
      projectedContent,
    )
  if (type === "session.next.text.delta" || type === "session.next.reasoning.delta")
    return projectDelta(
      {
        type: "timeline.delta",
        sessionID: data.sessionID,
        itemID: data.assistantMessageID,
        contentID: type === "session.next.text.delta" ? data.textID : data.reasoningID,
        field: "text",
        delta: data.delta,
      },
      projectedContent,
    )
  return { type: "unknown", raw: input }
}

function clearSessionPrompts(
  sessionID: string,
  projected: Map<string, { sessionID: string; content: TimelineContent[] }>,
) {
  for (const [messageID, prompt] of projected) if (prompt.sessionID === sessionID) projected.delete(messageID)
}

function projectDelta(event: Extract<AppEvent, { type: "timeline.delta" }>, projected: Map<string, TimelineContent>) {
  const key = `${event.itemID}:${event.contentID}`
  const content = projected.get(key)
  if (content && event.field === "text" && "text" in content)
    projected.set(key, { ...content, text: content.text + event.delta })
  return event
}

function projectedMessageContent(messageID: string, projected: Map<string, TimelineContent>) {
  return [...projected.entries()].filter(([key]) => key.startsWith(`${messageID}:`)).map(([, content]) => content)
}

function clearMessageContent(messageID: string, projected: Map<string, TimelineContent>) {
  for (const key of projected.keys()) if (key.startsWith(`${messageID}:`)) projected.delete(key)
}

function clearSessionProjection(
  sessionID: string,
  projectedContent: Map<string, TimelineContent>,
  projectedItems: Map<string, TimelineItem>,
) {
  const messages = [...projectedItems.values()].filter((item) => item.sessionID === sessionID).map((item) => item.id)
  messages.forEach((messageID) => clearMessageContent(messageID, projectedContent))
  for (const [id, item] of projectedItems) if (item.sessionID === sessionID) projectedItems.delete(id)
}

function eventSession(input: unknown): AppSession | undefined {
  const info = record(input)
  if (!info || typeof info.id !== "string" || typeof info.projectID !== "string" || typeof info.title !== "string") return
  const location = record(info.location)
  const directory =
    typeof location?.directory === "string"
      ? location.directory
      : typeof info.directory === "string"
        ? info.directory
        : undefined
  if (!directory) return
  const time = record(info.time)
  if (typeof time?.created !== "number" || typeof time.updated !== "number") return
  const workspaceID =
    typeof location?.workspaceID === "string"
      ? location.workspaceID
      : typeof info.workspaceID === "string"
        ? info.workspaceID
        : undefined
  return {
    id: info.id,
    slug: typeof info.slug === "string" ? info.slug : info.id,
    version: typeof info.version === "string" ? info.version : "",
    parentID: typeof info.parentID === "string" ? info.parentID : undefined,
    projectID: info.projectID,
    location: { directory, workspaceID },
    directory,
    workspaceID,
    title: info.title,
    time: {
      created: time.created,
      updated: time.updated,
      archived: typeof time.archived === "number" ? time.archived : undefined,
    },
  }
}

function record(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  return input as Record<string, unknown>
}

function eventSequence(input: OpenCodeEvent) {
  const durable = record(record(input)?.durable)
  return typeof durable?.seq === "number" ? durable.seq : 0
}

async function* nativeSessionEvents(
  config: PtyTransportConfig,
  sessionID: string,
  after: number | undefined,
  options?: RequestOptions,
): AsyncIterable<OpenCodeEvent> {
  const url = nativeSessionURL(config, sessionID, "/event")
  if (after !== undefined) url.searchParams.set("after", String(after))
  const response = await config.fetch(url, { signal: options?.signal, headers: transportHeaders(config) })
  if (!response.ok) throw new Error(`Failed to read session events: ${response.status} ${response.statusText}`)
  if (!response.body) return
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  while (true) {
    const result = await reader.read()
    buffer += result.value ?? ""
    const records = buffer.split("\n\n")
    buffer = records.pop() ?? ""
    for (const entry of records) {
      const payload = entry
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (payload) yield JSON.parse(payload) as OpenCodeEvent
    }
    if (result.done) break
  }
}
