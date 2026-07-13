// @ts-nocheck
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { onMount } from "solid-js"
import { DialogConnectProvider } from "./dialog-connect-provider"

function ConnectProviderDialogStory() {
  const dialog = useDialog()
  const open = () => dialog.show(() => <DialogConnectProvider v2 />)

  onMount(open)

  return (
    <Button variant="secondary" onClick={open}>
      Open connect provider dialog
    </Button>
  )
}

export default {
  title: "App/Dialogs/Connect Provider",
  id: "app-dialog-connect-provider",
}

export const V2 = {
  render: () => (
    <QueryClientProvider client={new QueryClient()}>
      <ConnectProviderDialogStory />
    </QueryClientProvider>
  ),
}
