// @ts-nocheck
/** @jsxImportSource @opentui/solid */
import { readFile } from "node:fs/promises"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Show, Index, For } from "solid-js"
import { createSignal, createEffect, onCleanup, onMount, createMemo } from "solid-js"
import {
  PLUGIN_ID,
  parseOptions,
  filterRuns,
  DOT,
  PULSE_FRAMES,
  buildRegistryPath,
  readRegistry,
  emptyCache,
  readCacheText,
  getJobElapsed,
  truncate,
} from "./shared"
import type { CICache, HideFilters, WorkflowJob, WorkflowRun } from "./shared"

type Api = Parameters<TuiPlugin>[0]

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function dotColor(theme: any, status: string, conclusion: string | null) {
  if (status === "completed" && conclusion === "success") return theme.success
  if (status === "completed" && conclusion === "failure") return theme.error
  if (status === "completed" && conclusion === "skipped") return theme.textMuted
  if (status === "completed" && conclusion === "cancelled") return theme.textMuted
  if (status === "in_progress") return theme.warning
  if (status === "queued" || status === "waiting") return theme.textMuted
  return theme.textMuted
}

function overallStatus(runs: WorkflowRun[]): { status: string; conclusion: string | null } {
  if (runs.some((r) => r.status === "in_progress")) return { status: "in_progress", conclusion: null }
  if (runs.some((r) => r.status === "queued")) return { status: "queued", conclusion: null }
  if (runs.every((r) => r.status === "completed" && r.conclusion === "success"))
    return { status: "completed", conclusion: "success" }
  if (runs.some((r) => r.status === "completed" && r.conclusion === "failure"))
    return { status: "completed", conclusion: "failure" }
  return { status: "completed", conclusion: runs[0]?.conclusion ?? null }
}

// ---------------------------------------------------------------------------
// Read cache from disk
// ---------------------------------------------------------------------------

async function readCache(filePath: string): Promise<CICache> {
  try {
    return readCacheText(await readFile(filePath, "utf8"))
  } catch {
    return emptyCache()
  }
}

/** Find this session's cache file via the registry (matched by PID) */
async function discoverCachePath(registryPath: string): Promise<string | null> {
  const entries = await readRegistry(registryPath)
  const mine = entries.find((e) => e.pid === process.pid)
  return mine?.cachePath ?? null
}

// ---------------------------------------------------------------------------
// Per-workflow row (stateless — toggle state lifted to parent)
// ---------------------------------------------------------------------------

const WorkflowRow = (props: {
  run: WorkflowRun
  theme: any
  nowSec: number
  pulseFrame: number
  expanded: boolean
  onToggle: () => void
}) => {
  const arrowColor = () => dotColor(props.theme, props.run.status, props.run.conclusion)

  return (
    <box flexDirection="column" gap={0}>
      <text onMouseDown={() => props.onToggle()}>
        {"  "}
        <span style={{ fg: arrowColor() }}>
          {props.expanded ? "▼" : "▶"}
        </span>
        <span style={{ fg: props.theme.text }}>
          {" "}{truncate(props.run.name, 28)}
        </span>
      </text>
      <Show when={props.expanded}>
        <Index each={props.run.jobs}>
          {(job) => {
            const elapsed = () => getJobElapsed(job(), props.nowSec)
            const isJobActive = () => job().status === "in_progress"
            const jobDot = () => isJobActive() ? PULSE_FRAMES[props.pulseFrame % PULSE_FRAMES.length] : DOT
            return (
              <box flexDirection="row" width="100%" gap={0}>
                <text flexGrow={1}>
                  <span style={{ fg: dotColor(props.theme, job().status, job().conclusion) }}>
                    {"    "}{jobDot()}
                  </span>
                  <span style={{ fg: props.theme.text }}>
                    {" "}{truncate(job().name, 22)}
                  </span>
                </text>
                <Show when={elapsed()}>
                  <text fg={props.theme.textMuted}>{elapsed()}</text>
                </Show>
              </box>
            )
          }}
        </Index>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Main sidebar card
// ---------------------------------------------------------------------------

const CICard = (props: { api: Api; theme: any; tuiPollMs: number; hide: HideFilters; collapseSingleWorkflow: boolean }) => {
  const [cache, setCache] = createSignal<CICache>(emptyCache())
  const [nowSec, setNowSec] = createSignal(Math.floor(Date.now() / 1000))
  const [collapsed, setCollapsed] = createSignal(false)
  const [pulseFrame, setPulseFrame] = createSignal(0)
  const [cachePath, setCachePath] = createSignal<string | null>(null)

  // Toggle state keyed by run ID — persists across cache updates
  const [expandedMap, setExpandedMap] = createSignal<Record<number, boolean>>({})

  const toggleRun = (runId: number) => {
    setExpandedMap((prev) => ({
      ...prev,
      [runId]: prev[runId] === undefined ? false : !prev[runId],
    }))
  }

  const isRunExpanded = (runId: number) => {
    const map = expandedMap()
    return map[runId] === undefined ? true : map[runId]
  }

  const registryPath = buildRegistryPath(props.api.state.path.directory)

  const load = async () => {
    // Discover cache path if not yet found
    let path = cachePath()
    if (!path) {
      path = await discoverCachePath(registryPath)
      if (path) setCachePath(path)
    }
    if (!path) return

    setCache(await readCache(path))
  }

  onMount(() => {
    void load()
    const pollTimer = setInterval(() => void load(), props.tuiPollMs)
    const tickTimer = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    onCleanup(() => {
      clearInterval(pollTimer)
      clearInterval(tickTimer)
    })
  })

  // Pulse animation — only runs when something is in progress
  const hasActive = createMemo(() =>
    (cache().runs ?? []).some((r) =>
      r.status === "in_progress" || r.jobs.some((j) => j.status === "in_progress")
    )
  )

  createEffect(() => {
    if (!hasActive()) return
    const id = setInterval(() => setPulseFrame((f) => f + 1), 500)
    onCleanup(() => clearInterval(id))
  })

  const runs = createMemo(() => filterRuns(cache().runs, props.hide))
  const error = createMemo(() => cache().error)
  const hasRuns = createMemo(() => runs().length > 0)
  const overall = createMemo(() => hasRuns() ? overallStatus(runs()) : null)

  const isSingleCollapsed = createMemo(() =>
    props.collapseSingleWorkflow && runs().length === 1
  )

  function countItems(items: { status: string; conclusion: string | null }[]) {
    const pending = items.filter((i) => i.status === "in_progress" || i.status === "queued" || i.status === "waiting").length
    const success = items.filter((i) => i.status === "completed" && i.conclusion === "success").length
    const failed = items.filter((i) => i.status === "completed" && i.conclusion === "failure").length
    const skipped = items.filter((i) => i.status === "completed" && (i.conclusion === "skipped" || i.conclusion === "cancelled")).length
    const parts: string[] = []
    if (pending) parts.push(`${pending} pending`)
    if (success) parts.push(`${success} passed`)
    if (failed) parts.push(`${failed} failed`)
    if (skipped) parts.push(`${skipped} skipped`)
    return parts.join(", ")
  }

  const summary = createMemo(() => {
    const all = runs()
    if (!all.length) return ""
    const text = isSingleCollapsed() ? countItems(all[0].jobs) : countItems(all)
    return `(${text})`
  })

  // Global status icon: checkmark, cross, or spinner
  const globalStatusIcon = createMemo(() => {
    const o = overall()
    if (!o) return { icon: "", color: "" }
    if (o.status === "in_progress" || o.status === "queued")
      return { icon: PULSE_FRAMES[pulseFrame() % PULSE_FRAMES.length], color: props.theme.warning }
    if (o.status === "completed" && o.conclusion === "success")
      return { icon: "\u2713", color: props.theme.success }
    if (o.status === "completed" && o.conclusion === "failure")
      return { icon: "\u2717", color: props.theme.error }
    if (o.status === "completed" && (o.conclusion === "skipped" || o.conclusion === "cancelled"))
      return { icon: "-", color: props.theme.textMuted }
    return { icon: "?", color: props.theme.textMuted }
  })

  // Flat list of displayable jobs for single-collapsed mode
  const flatJobs = createMemo(() => {
    if (!hasRuns() || collapsed() || !isSingleCollapsed()) return []
    return runs()[0]?.jobs ?? []
  })

  // Runs to display in multi-workflow mode
  const displayRuns = createMemo(() => {
    if (!hasRuns() || collapsed() || isSingleCollapsed()) return []
    return runs()
  })

  // Status messages as a computed array (empty = no node rendered)
  const statusMessages = createMemo(() => {
    if (error()) return [{ text: ` ${error()}`, color: props.theme.error }]
    if (!hasRuns()) return [{ text: " waiting...", color: props.theme.textMuted }]
    return [] as { text: string; color: any }[]
  })

  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" width="100%" gap={0} onMouseDown={() => hasRuns() && setCollapsed((c) => !c)}>
        <text flexGrow={1} fg={props.theme.text}>
          <Show when={hasRuns()} fallback={<b>CI</b>}>
            <span>
              {collapsed() ? "▶" : "▼"}{" "}<b>CI</b>
              <span style={{ fg: props.theme.textMuted }}>
                {" "}{summary()}
              </span>
            </span>
          </Show>
        </text>
        <Show when={hasRuns()}>
          <text fg={globalStatusIcon().color}>{globalStatusIcon().icon}</text>
        </Show>
      </box>
      <Index each={statusMessages()}>
        {(msg) => <text fg={msg().color}>{msg().text}</text>}
      </Index>
      <Index each={flatJobs()}>
        {(job) => {
          const elapsed = () => getJobElapsed(job(), nowSec())
          const isJobActive = () => job().status === "in_progress"
          const jobDot = () => isJobActive() ? PULSE_FRAMES[pulseFrame() % PULSE_FRAMES.length] : DOT
          return (
            <box flexDirection="row" width="100%" gap={0}>
              <text flexGrow={1}>
                <span style={{ fg: dotColor(props.theme, job().status, job().conclusion) }}>
                  {jobDot()}
                </span>
                <span style={{ fg: props.theme.text }}>
                  {" "}{truncate(job().name, 28)}
                </span>
              </text>
              <Show when={elapsed()}>
                <text fg={props.theme.textMuted}>{elapsed()}</text>
              </Show>
            </box>
          )
        }}
      </Index>
      <For each={displayRuns()}>
        {(run) => (
          <WorkflowRow
            run={run}
            theme={props.theme}
            nowSec={nowSec()}
            pulseFrame={pulseFrame()}
            expanded={isRunExpanded(run.id)}
            onToggle={() => toggleRun(run.id)}
          />
        )}
      </For>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

const tui: TuiPlugin = async (api, options) => {
  const opts = parseOptions(options)
  if (!opts.enabled) return

  api.slots.register({
    order: 350,
    slots: {
      sidebar_content(ctx) {
        return <CICard api={api} theme={ctx.theme.current} tuiPollMs={opts.tui_poll_ms} hide={opts.hide} collapseSingleWorkflow={opts.collapse_single_workflow} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
