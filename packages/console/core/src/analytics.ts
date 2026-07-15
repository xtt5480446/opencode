import { Context, Effect, Layer, Logger, References, Schema } from "effect"

export namespace AnalyticsLogger {
  export const EventType = Schema.Literals(["completions", "llm.error"])
  export type EventType = typeof EventType.Type

  export const BillingSource = Schema.Literals(["anonymous", "free", "byok", "subscription", "lite", "balance"])
  export type BillingSource = typeof BillingSource.Type

  export const Request = Schema.Struct({
    id: Schema.String,
    sessionID: Schema.optional(Schema.String),
    projectID: Schema.optional(Schema.String),
    stream: Schema.Boolean,
    size: Schema.optional(Schema.Int),
    responseSize: Schema.optional(Schema.Int),
    status: Schema.optional(Schema.Int),
  }).annotate({ identifier: "AnalyticsLogger.Request" })
  export interface Request extends Schema.Schema.Type<typeof Request> {}

  export const Model = Schema.Struct({
    id: Schema.String,
    tier: Schema.Literals(["zen", "go"]),
    variant: Schema.optional(Schema.String),
  }).annotate({ identifier: "AnalyticsLogger.Model" })
  export interface Model extends Schema.Schema.Type<typeof Model> {}

  export const ProviderRoute = Schema.Struct({
    id: Schema.String,
    model: Schema.String,
  }).annotate({ identifier: "AnalyticsLogger.ProviderRoute" })
  export interface ProviderRoute extends Schema.Schema.Type<typeof ProviderRoute> {}

  export const Provider = Schema.Struct({
    id: Schema.String,
    model: Schema.String,
    shallow: Schema.optional(ProviderRoute),
    budgetUsage: Schema.optional(Schema.Finite),
    budgetPriority: Schema.optional(Schema.Finite),
  }).annotate({ identifier: "AnalyticsLogger.Provider" })
  export interface Provider extends Schema.Schema.Type<typeof Provider> {}

  export const Account = Schema.Struct({
    source: BillingSource,
    workspaceID: Schema.optional(Schema.String),
    userID: Schema.optional(Schema.String),
    apiKeyID: Schema.optional(Schema.String),
    subscription: Schema.optional(Schema.String),
  }).annotate({ identifier: "AnalyticsLogger.Account" })
  export interface Account extends Schema.Schema.Type<typeof Account> {}

  export const Geo = Schema.Struct({
    continent: Schema.optional(Schema.String),
    country: Schema.optional(Schema.String),
    city: Schema.optional(Schema.String),
    region: Schema.optional(Schema.String),
    latitude: Schema.optional(Schema.Finite),
    longitude: Schema.optional(Schema.Finite),
    timezone: Schema.optional(Schema.String),
  }).annotate({ identifier: "AnalyticsLogger.Geo" })
  export interface Geo extends Schema.Schema.Type<typeof Geo> {}

  export const Client = Schema.Struct({
    name: Schema.optional(Schema.String),
    userAgent: Schema.optional(Schema.String),
    ip: Schema.optional(Schema.String),
    ipPrefix: Schema.optional(Schema.String),
    geo: Schema.optional(Geo),
  }).annotate({ identifier: "AnalyticsLogger.Client" })
  export interface Client extends Schema.Schema.Type<typeof Client> {}

  export const Usage = Schema.Struct({
    input: Schema.Int,
    output: Schema.Int,
    reasoning: Schema.Int,
    cacheRead: Schema.Int,
    cacheWrite5m: Schema.Int,
    cacheWrite1h: Schema.Int,
  }).annotate({ identifier: "AnalyticsLogger.Usage" })
  export interface Usage extends Schema.Schema.Type<typeof Usage> {}

  // Model catalog prices are USD per one million tokens.
  export const Price = Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    cacheRead: Schema.optional(Schema.Finite),
    cacheWrite5m: Schema.optional(Schema.Finite),
    cacheWrite1h: Schema.optional(Schema.Finite),
  }).annotate({ identifier: "AnalyticsLogger.Price" })
  export interface Price extends Schema.Schema.Type<typeof Price> {}

  export const Cost = Schema.Struct({
    inputMicrocents: Schema.Int,
    outputMicrocents: Schema.Int,
    cacheReadMicrocents: Schema.optional(Schema.Int),
    cacheWrite5mMicrocents: Schema.optional(Schema.Int),
    cacheWrite1hMicrocents: Schema.optional(Schema.Int),
    totalMicrocents: Schema.Int,
  }).annotate({ identifier: "AnalyticsLogger.Cost" })
  export interface Cost extends Schema.Schema.Type<typeof Cost> {}

  export const Latency = Schema.Struct({
    totalMs: Schema.optional(Schema.Finite),
    firstByteMs: Schema.optional(Schema.Finite),
    firstByteAt: Schema.optional(Schema.Int),
    lastByteAt: Schema.optional(Schema.Int),
  }).annotate({ identifier: "AnalyticsLogger.Latency" })
  export interface Latency extends Schema.Schema.Type<typeof Latency> {}

  export const Error = Schema.Struct({
    code: Schema.optional(Schema.Union([Schema.String, Schema.Int])),
    llmMessage: Schema.optional(Schema.String),
    response: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.String),
    cause2: Schema.optional(Schema.String),
  }).annotate({ identifier: "AnalyticsLogger.Error" })
  export interface Error extends Schema.Schema.Type<typeof Error> {}

  export const Event = Schema.Struct({
    version: Schema.Literal(1),
    type: EventType,
    timestamp: Schema.String,
    dataset: Schema.String,
    request: Request,
    model: Model,
    provider: Schema.optional(Provider),
    account: Schema.optional(Account),
    client: Schema.optional(Client),
    usage: Schema.optional(Usage),
    price: Schema.optional(Price),
    cost: Schema.optional(Cost),
    latency: Schema.optional(Latency),
    error: Schema.optional(Error),
  }).annotate({ identifier: "AnalyticsLogger.Event" })
  export interface Event extends Schema.Schema.Type<typeof Event> {}

  type Field = string | number | boolean
  export type Fields = Readonly<Record<string, Field>>
  export type Writer = Logger.Logger<unknown, unknown>

  class Message extends Schema.TaggedClass<Message>()("AnalyticsLogger.Message", {
    event: Event,
  }) {}

  const isMessage = Schema.is(Message)

  export function fields(event: Event): Fields {
    const cacheWriteMicrocents =
      event.cost?.cacheWrite5mMicrocents === undefined && event.cost?.cacheWrite1hMicrocents === undefined
        ? undefined
        : (event.cost.cacheWrite5mMicrocents ?? 0) + (event.cost.cacheWrite1hMicrocents ?? 0)
    const values: Record<string, Field | undefined> = {
      _datalake_key: "inference.event",
      event_version: event.version,
      event_timestamp: event.timestamp,
      event_date: event.timestamp.slice(0, 10),
      event_type: event.type,
      dataset: event.dataset,
      is_stream: event.request.stream,
      session: event.request.sessionID,
      project: event.request.projectID,
      request: event.request.id,
      request_length: event.request.size,
      response_length: event.request.responseSize,
      status: event.request.status,
      client: event.client?.name,
      user_agent: event.client?.userAgent,
      ip: event.client?.ip,
      "ip.prefix": event.client?.ipPrefix,
      "cf.continent": event.client?.geo?.continent,
      "cf.country": event.client?.geo?.country,
      "cf.city": event.client?.geo?.city,
      "cf.region": event.client?.geo?.region,
      "cf.latitude": event.client?.geo?.latitude,
      "cf.longitude": event.client?.geo?.longitude,
      "cf.timezone": event.client?.geo?.timezone,
      model: event.model.id,
      "model.tier": event.model.tier,
      "model.variant": event.model.variant,
      source: event.account?.source,
      workspace: event.account?.workspaceID,
      user_id: event.account?.userID,
      api_key: event.account?.apiKeyID,
      subscription: event.account?.subscription,
      provider: event.provider?.id,
      "provider.model": event.provider?.model,
      shallowProvider: event.provider?.shallow?.id,
      "shallowProvider.model": event.provider?.shallow?.model,
      "provider.budget_usage": event.provider?.budgetUsage,
      "provider.budget_priority": event.provider?.budgetPriority,
      duration: event.latency?.totalMs,
      time_to_first_byte: event.latency?.firstByteMs,
      "timestamp.first_byte": event.latency?.firstByteAt,
      "timestamp.last_byte": event.latency?.lastByteAt,
      "tokens.input": event.usage?.input,
      "tokens.output": event.usage?.output,
      "tokens.reasoning": event.usage?.reasoning,
      "tokens.cache_read": event.usage?.cacheRead,
      "tokens.cache_write_5m": event.usage?.cacheWrite5m,
      "tokens.cache_write_1h": event.usage?.cacheWrite1h,
      "price.unit": event.price ? "usd_per_million_tokens" : undefined,
      "price.input": event.price?.input,
      "price.output": event.price?.output,
      "price.cache_read": event.price?.cacheRead,
      "price.cache_write_5m": event.price?.cacheWrite5m,
      "price.cache_write_1h": event.price?.cacheWrite1h,
      "cost.input.microcents": event.cost?.inputMicrocents,
      "cost.output.microcents": event.cost?.outputMicrocents,
      "cost.cache_read.microcents": event.cost?.cacheReadMicrocents,
      "cost.cache_write.microcents": cacheWriteMicrocents,
      "cost.cache_write_5m.microcents": event.cost?.cacheWrite5mMicrocents,
      "cost.cache_write_1h.microcents": event.cost?.cacheWrite1hMicrocents,
      "cost.total.microcents": event.cost?.totalMicrocents,
      "llm.error.code": event.error?.code,
      "llm.error.message": event.error?.llmMessage,
      "error.response": event.error?.response,
      "error.type": event.error?.type,
      "error.message": event.error?.message,
      "error.cause": event.error?.cause,
      "error.cause2": event.error?.cause2,
    }
    return Object.fromEntries(
      Object.entries(values).filter((entry): entry is [string, Field] => entry[1] !== undefined),
    )
  }

  export function writer(write: (fields: Fields) => void): Writer {
    return Logger.make<unknown, void>((options) => {
      const message =
        Array.isArray(options.message) && options.message.length === 1 ? options.message[0] : options.message
      if (!isMessage(message)) return
      write(fields(message.event))
    })
  }

  export interface Interface {
    readonly write: (event: Event) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/console/AnalyticsLogger") {}

  export function make(writers: ReadonlyArray<Writer>): Interface {
    const isolated = Logger.layer(writers, { mergeWithExisting: false })
    return Service.of({
      write: (event) =>
        Effect.logInfo(new Message({ event })).pipe(
          Effect.provide(isolated),
          Effect.provideService(References.MinimumLogLevel, "All"),
        ),
    })
  }

  export const layer = (writers: ReadonlyArray<Writer>) => Layer.succeed(Service, make(writers))

  export const write = (event: Event) => Effect.flatMap(Service, (service) => service.write(event))
}
