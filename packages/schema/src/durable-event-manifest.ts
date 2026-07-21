export * as DurableEventManifest from "./durable-event-manifest"

import { AdaptiveEvent } from "./adaptive-event"
import { Event } from "./event"
import { SessionEvent } from "./session-event"
import { SessionV1 } from "./session-v1"

export const SessionDurable = {
  definitions: Event.durable(SessionEvent.DurableDefinitions),
  schema: SessionEvent.Durable,
} as const

export const AdaptiveDurable = {
  definitions: Event.durable(AdaptiveEvent.DurableDefinitions),
  schema: AdaptiveEvent.Durable,
} as const

export const Durable = Event.durable([
  ...AdaptiveEvent.DurableDefinitions,
  ...SessionV1.Event.Definitions.filter((definition) => definition.durable !== undefined),
  ...SessionEvent.DurableDefinitions,
])
