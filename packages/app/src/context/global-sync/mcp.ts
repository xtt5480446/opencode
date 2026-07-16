import type { AppMcpStatus } from "../backend"

export async function toggleMcp(input: {
  status: AppMcpStatus["status"]
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  authenticate: () => Promise<void>
  refresh: () => Promise<void>
}) {
  await {
    connected: input.disconnect,
    pending: async () => {},
    needs_auth: input.authenticate,
    disabled: input.connect,
    failed: input.connect,
    needs_client_registration: input.connect,
  }[input.status]()
  await input.refresh()
}
