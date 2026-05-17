import { cmd } from "@/cli/cmd/cmd"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { Filesystem } from "@/util/filesystem"
import { Rpc } from "@/util/rpc"
import { errorMessage } from "@/util/error"
import { withTimeout } from "@/util/timeout"
import { Flag } from "@opencode-ai/core/flag/flag"
import * as Log from "@opencode-ai/core/util/log"
import {
  OPENCODE_PROCESS_ROLE,
  OPENCODE_RUN_ID,
  ensureRunID,
  sanitizedProcessEnv,
} from "@opencode-ai/core/util/opencode-process"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import type { SimulationMcpRuntimeState } from "./simulation-mcp"
import type { rpc } from "./worker"
import { SimulationDebugLog } from "../../../testing/simulation/debug-log"
import { fileURLToPath } from "url"
import { writeHeapSnapshot } from "v8"

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>
const simulatedDirectory = "/opencode"
const simulatedCwdEnv = "OPENCODE_SIMULATION_CWD"

function fakeCwd(directory: string) {
  process.env.PWD = directory
  Object.defineProperty(process, "cwd", {
    value: () => directory,
    configurable: true,
  })
}

interface Transport {
  readonly url: string
  readonly fetch: typeof fetch
  readonly events: EventSource
}

interface RunningInstance {
  readonly client: RpcClient
  readonly done: Promise<void>
  readonly stopTui: () => Promise<void>
  readonly stopWorker: () => Promise<void>
}

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    SimulationDebugLog.write("simulate.fetch.start", { method: request.method, url: request.url })
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    SimulationDebugLog.write("simulate.fetch.end", { method: request.method, url: request.url, status: result.status })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient, onSubscribe?: () => void): EventSource {
  return {
    subscribe: async (handler) => {
      // SimulationDebugLog.write("simulate.events.subscribe")
      onSubscribe?.()
      return client.on<GlobalEvent>("global.event", (e) => {
        // SimulationDebugLog.write("simulate.events.received", {
        //   directory: e.directory,
        //   workspace: e.workspace,
        //   type: e.payload?.type,
        //   sync: e.payload?.type === "sync",
        // })
        handler(e)
      })
    },
  }
}

async function target() {
  const workerPath = Reflect.get(globalThis, "OPENCODE_WORKER_PATH")
  if (typeof workerPath === "string") return workerPath
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("./worker.ts", import.meta.url)
}

export const SimulateCommand = cmd({
  command: "simulate",
  describe: "start restartable simulated opencode tui",
  handler: async () => {
    SimulationDebugLog.reset()
    fakeCwd(simulatedDirectory)
    const file = await target()
    const cwd = simulatedDirectory
    const config = await TuiConfig.get()
    const simulationMcpMode = Flag.OPENCODE_SIMULATION ? "stdio" : "remote"

    let currentInstance: RunningInstance | undefined
    let currentRuntime: SimulationMcpRuntimeState | undefined
    let restartRequested = false
    let restartWaiter:
      | {
          readonly promise: Promise<{ restarted: true }>
          readonly resolve: (value: { restarted: true }) => void
          readonly reject: (error: unknown) => void
        }
      | undefined

    const error = (e: unknown) => {
      Log.Default.error("process error", { error: errorMessage(e) })
    }
    const reload = () => {
      currentInstance?.client.call("reload", undefined).catch((err) => {
        Log.Default.warn("worker reload failed", {
          error: errorMessage(err),
        })
      })
    }
    process.on("uncaughtException", error)
    process.on("unhandledRejection", error)
    process.on("SIGUSR2", reload)

    const simulationMcpModule = await import("./simulation-mcp")
    const simulationMcp = await simulationMcpModule.TuiSimulationMcp.createSimulationMcpServer({
      mode: simulationMcpMode,
      runtime: {
        current: () => currentRuntime,
        restart: async () => {
          if (restartWaiter) return restartWaiter.promise
          if (!currentInstance) throw new Error("Simulation TUI is not ready")
          restartRequested = true
          let resolve!: (value: { restarted: true }) => void
          let reject!: (error: unknown) => void
          const promise = new Promise<{ restarted: true }>((resolvePromise, rejectPromise) => {
            resolve = resolvePromise
            reject = rejectPromise
          })
          restartWaiter = { promise, resolve, reject }
          currentInstance.stopTui().catch((err) => restartWaiter?.reject(err))
          return promise
        },
      },
    })

    const stopWorker = async (client: RpcClient, worker: Worker) => {
      await withTimeout(client.call("shutdown", undefined), 5000).catch((err) => {
        Log.Default.warn("worker shutdown failed", {
          error: errorMessage(err),
        })
      })
      worker.terminate()
    }

    const start = async (): Promise<RunningInstance> => {
      const worker = new Worker(file, {
        env: sanitizedProcessEnv({
          [OPENCODE_PROCESS_ROLE]: "worker",
          [OPENCODE_RUN_ID]: ensureRunID(),
          PWD: simulatedDirectory,
          [simulatedCwdEnv]: simulatedDirectory,
          // Simulated filesystem lives in InMemoryFs — SQLite needs to be in-memory
          // too, since real fs writes to `/opencode/.local/share/opencode/...` will
          // fail (the directory only exists in the sim FS).
          OPENCODE_DB: ":memory:",
        }),
      })
      worker.onerror = (e) => {
        Log.Default.error("thread error", {
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          colno: e.colno,
          error: e.error,
        })
      }

      const client = Rpc.client<typeof rpc>(worker)
      let eventSubscribedResolve!: () => void
      const eventSubscribed = new Promise<void>((resolve) => {
        eventSubscribedResolve = resolve
      })
      const transport: Transport = {
        url: "http://opencode.internal",
        fetch: createWorkerFetch(client),
        events: createEventSource(client, eventSubscribedResolve),
      }

      const { tui } = await import("./app")
      const simulationRenderer = Flag.OPENCODE_SIMULATION
        ? await (await import("./simulation")).TuiSimulation.createSimulationRenderer()
        : undefined

      let stopTui = async () => {}
      let stopReadyResolve!: () => void
      const stopReady = new Promise<void>((resolve) => {
        stopReadyResolve = resolve
      })
      let readyResolve!: () => void
      let readyReject!: (error: unknown) => void
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve
        readyReject = reject
      })
      const done = tui({
        url: transport.url,
        async onSnapshot() {
          const tui = writeHeapSnapshot("tui.heapsnapshot")
          const server = await client.call("snapshot", undefined)
          return [tui, server]
        },
        config,
        directory: cwd,
        fetch: transport.fetch,
        events: transport.events,
        renderer: simulationRenderer?.renderer,
        mode: simulationRenderer ? "dark" : undefined,
        onStop: (stop) => {
          stopTui = stop
          stopReadyResolve()
        },
        onReady: async (ctx) => {
          try {
            currentRuntime = {
              harness: simulationRenderer
                ? simulationMcpModule.TuiSimulationMcp.harnessFromSimulationRenderer(simulationRenderer)
                : simulationMcpModule.TuiSimulationMcp.harnessFromRenderer(ctx.renderer),
              controlUrl: transport.url,
              controlFetch: transport.fetch,
            }
            if (simulationRenderer) await simulationRenderer.renderOnce()
            readyResolve()
            return { simulationMcpUrl: simulationMcp.url }
          } catch (err) {
            readyReject(err)
            throw err
          }
        },
        args: {},
      })

      await Promise.all([ready, stopReady, eventSubscribed])
        return {
          client,
          done,
          stopTui: () => stopTui(),
          stopWorker: async () => {
            simulationRenderer?.destroy()
            await stopWorker(client, worker)
          },
        }
      }

    try {
      while (true) {
        try {
          currentInstance = await start()
          restartWaiter?.resolve({ restarted: true })
          restartWaiter = undefined
          restartRequested = false
        } catch (err) {
          restartWaiter?.reject(err)
          throw err
        }

        await currentInstance.done
        currentRuntime = undefined
        await currentInstance.stopWorker()
        currentInstance = undefined
        if (!restartRequested) break
      }
    } finally {
      currentRuntime = undefined
      await currentInstance?.stopTui().catch(() => {})
      await currentInstance?.stopWorker()
      await simulationMcp.stop()
      process.off("uncaughtException", error)
      process.off("unhandledRejection", error)
      process.off("SIGUSR2", reload)
    }
  },
})

export * as TuiSimulate from "./simulate"
