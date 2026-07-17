export * as Workspace from "./workspace.js"

import { WorkspaceEvent } from "./workspace-event.js"
import { WorkspaceID } from "./workspace-id.js"
import { Project } from "./project.js"
import { AbsolutePath } from "./schema.js"
import { Schema } from "effect"

export const ID = WorkspaceID
export type ID = WorkspaceID

export const Info = Schema.Struct({
  id: ID,
  name: Schema.String,
  directory: AbsolutePath,
  project: Project.Current,
}).annotate({ identifier: "Workspace.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Event = WorkspaceEvent
