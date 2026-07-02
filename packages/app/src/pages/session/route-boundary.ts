import { ErrorBoundary, createComponent, createEffect, on } from "solid-js"
import type { JSX } from "solid-js"

// Error scope for the target session route. All session tabs on a server share
// one route instance, so this must NOT key or remount per session: the subtree
// holds workspace-scoped state (notably TerminalProvider and its PTY
// WebSockets) that has to survive switching tabs within the same workspace.
// Remount boundaries live elsewhere: app.tsx keys the route per server around
// the server-scoped providers, and TargetSessionPage re-keys per workspace.
// Kept free of app contexts (and JSX) so these semantics are directly testable.
export function SessionRouteErrorBoundary(props: {
  sessionID: string | undefined
  fallback: (error: unknown) => JSX.Element
  children: JSX.Element
}) {
  return createComponent(ErrorBoundary, {
    fallback: (error: unknown, reset: () => void) => {
      // A stale error (e.g. session not found) must clear when navigating to a
      // different session tab; mirrors the panel boundary reset inside Page.
      createEffect(on(() => props.sessionID, reset, { defer: true }))
      return props.fallback(error)
    },
    get children() {
      return props.children
    },
  })
}
