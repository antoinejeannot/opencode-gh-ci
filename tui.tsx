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
import type { CICache, DetailLevel, HideFilters, JobsDetailOptions, WorkflowJob, WorkflowRun } from "./shared"

type Api = Parameters<TuiPlugin>[0]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dotColor(theme: any, status: string, conclusion: string | null) {
  if (status === "completed" && conclusion === "success") return theme.success
  if (status === "completed" && conclusion === "failure") return theme.error
  if (status === "in_progress") return theme.warning
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

function countItems(items: { status: string; conclusion: string | null }[]): string {
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

async function readCache(filePath: string): Promise<CICache> {
  try { return readCacheText(await readFile(filePath, "utf8")) }
  catch { return emptyCache() }
}

async function discoverCachePath(registryPath: string): Promise<string | null> {
  const entries = await readRegistry(registryPath)
  return entries.find((e) => e.pid === process.pid)?.cachePath ?? null
}

// ---------------------------------------------------------------------------
// Job row
// ---------------------------------------------------------------------------

const JobRow = (props: {
  job: WorkflowJob; theme: any; nowSec: number; pulseFrame: number
  indent: string; maxLen: number; rightAlign: boolean
}) => {
  const elapsed = () => getJobElapsed(props.job, props.nowSec)
  const isActive = () => props.job.status === "in_progress"
  const dot = () => isActive() ? PULSE_FRAMES[props.pulseFrame % PULSE_FRAMES.length] : DOT
  const nameLen = () => props.maxLen - props.indent.length

  const label = () => (
    <text flexGrow={props.rightAlign ? 1 : undefined}>
      <span style={{ fg: dotColor(props.theme, props.job.status, props.job.conclusion) }}>
        {props.indent}{dot()}
      </span>
      <span style={{ fg: props.theme.text }}>
        {" "}{truncate(props.job.name, nameLen())}
      </span>
      {!props.rightAlign && elapsed() ? <span style={{ fg: props.theme.textMuted }}> {elapsed()}</span> : null}
    </text>
  )

  if (!props.rightAlign) return label()

  return (
    <box flexDirection="row" width="100%" gap={0}>
      {label()}
      {elapsed() ? <text fg={props.theme.textMuted}>{elapsed()}</text> : null}
    </box>
  )
}

// ---------------------------------------------------------------------------
// Workflow row (multi-workflow mode)
// ---------------------------------------------------------------------------

const WorkflowRow = (props: {
  run: WorkflowRun; theme: any; nowSec: number; pulseFrame: number
  expanded: boolean; onToggle: () => void; maxLen: number; rightAlign: boolean
}) => {
  const arrowColor = () => dotColor(props.theme, props.run.status, props.run.conclusion)
  const visibleJobs = createMemo(() => props.expanded ? props.run.jobs : [])

  return (
    <box flexDirection="column" gap={0}>
      <text onMouseDown={() => props.onToggle()}>
        {"  "}
        <span style={{ fg: arrowColor() }}>
          {props.expanded ? "▼" : "▶"}
        </span>
        <span style={{ fg: props.theme.text }}>
          {" "}{truncate(props.run.name, props.maxLen)}
        </span>
      </text>
      <Index each={visibleJobs()}>
        {(job) => (
          <JobRow job={job()} theme={props.theme} nowSec={props.nowSec} pulseFrame={props.pulseFrame}
            indent={"    "} maxLen={props.maxLen} rightAlign={props.rightAlign} />
        )}
      </Index>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Main sidebar card
// ---------------------------------------------------------------------------

const CICard = (props: {
  api: Api; theme: any; tuiPollMs: number; hide: HideFilters
  detail: DetailLevel; jobsDetail: JobsDetailOptions
  maxNameLength: number; rightAlignElapsed: boolean
}) => {
  const [cache, setCache] = createSignal<CICache>(emptyCache())
  const [nowSec, setNowSec] = createSignal(Math.floor(Date.now() / 1000))
  const [collapsed, setCollapsed] = createSignal(false)
  const [pulseFrame, setPulseFrame] = createSignal(0)
  const [cachePath, setCachePath] = createSignal<string | null>(null)
  const [expandedMap, setExpandedMap] = createSignal<Record<number, boolean>>({})

  const toggleRun = (id: number) =>
    setExpandedMap((m) => ({ ...m, [id]: m[id] === undefined ? false : !m[id] }))
  const isRunExpanded = (id: number) => expandedMap()[id] ?? true

  const registryPath = buildRegistryPath(props.api.state.path.directory)

  const load = async () => {
    let p = cachePath()
    if (!p) { p = await discoverCachePath(registryPath); if (p) setCachePath(p) }
    if (p) setCache(await readCache(p))
  }

  onMount(() => {
    void load()
    const poll = setInterval(() => void load(), props.tuiPollMs)
    const tick = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000)
    onCleanup(() => { clearInterval(poll); clearInterval(tick) })
  })

  const hasActive = createMemo(() =>
    (cache().runs ?? []).some((r) =>
      r.status === "in_progress" || r.jobs.some((j) => j.status === "in_progress"),
    ),
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

  const canToggle = () => props.detail !== "overall"
  const isSingle = createMemo(() =>
    props.detail === "jobs" && props.jobsDetail.collapse_single_workflow && runs().length === 1,
  )

  const summary = createMemo(() => {
    const all = runs()
    if (!all.length) return ""
    return `(${isSingle() ? countItems(all[0].jobs) : countItems(all)})`
  })

  const globalIcon = createMemo(() => {
    const o = overall()
    if (!o) return { icon: "", color: "" }
    if (o.status === "in_progress" || o.status === "queued")
      return { icon: PULSE_FRAMES[pulseFrame() % PULSE_FRAMES.length], color: props.theme.warning }
    if (o.conclusion === "success") return { icon: "\u2713", color: props.theme.success }
    if (o.conclusion === "failure") return { icon: "\u2717", color: props.theme.error }
    return { icon: "-", color: props.theme.textMuted }
  })

  // Computed arrays — empty arrays produce zero DOM nodes
  const statusMessages = createMemo(() => {
    if (error()) return [{ text: ` ${error()}`, color: props.theme.error }]
    if (!hasRuns()) return [{ text: " waiting...", color: props.theme.textMuted }]
    return [] as { text: string; color: any }[]
  })

  // "workflows" detail: workflow names with status dots
  const workflowRows = createMemo(() => {
    if (props.detail !== "workflows" || !hasRuns() || collapsed()) return []
    return runs()
  })

  // "jobs" detail with single workflow collapsed: flat job list
  const flatJobs = createMemo(() => {
    if (props.detail !== "jobs" || !hasRuns() || collapsed() || !isSingle()) return []
    return runs()[0]?.jobs ?? []
  })

  // "jobs" detail with multiple workflows
  const displayRuns = createMemo(() => {
    if (props.detail !== "jobs" || !hasRuns() || collapsed() || isSingle()) return []
    return runs()
  })

  return (
    <box flexDirection="column" gap={0}>
      {/* Header */}
      <box flexDirection="row" width="100%" gap={0} onMouseDown={() => canToggle() && hasRuns() && setCollapsed((c) => !c)}>
        <text flexGrow={1} fg={props.theme.text}>
          <Show when={hasRuns()} fallback={<b>CI</b>}>
            <span>
              {canToggle() ? (collapsed() ? "▶ " : "▼ ") : ""}<b>CI</b>
              <span style={{ fg: props.theme.textMuted }}>{" "}{summary()}</span>
            </span>
          </Show>
        </text>
        <Show when={hasRuns()}>
          <text fg={globalIcon().color}>{globalIcon().icon}</text>
        </Show>
      </box>
      {/* Status messages (error / waiting) */}
      <Index each={statusMessages()}>
        {(msg) => <text fg={msg().color}>{msg().text}</text>}
      </Index>
      {/* Workflows detail */}
      <Index each={workflowRows()}>
        {(run) => (
          <text>
            <span style={{ fg: dotColor(props.theme, run().status, run().conclusion) }}>
              {"  "}{DOT}
            </span>
            <span style={{ fg: props.theme.text }}>
              {" "}{truncate(run().name, props.maxNameLength)}
            </span>
          </text>
        )}
      </Index>
      {/* Jobs detail: single workflow collapsed */}
      <Index each={flatJobs()}>
        {(job) => (
          <JobRow job={job()} theme={props.theme} nowSec={nowSec()} pulseFrame={pulseFrame()}
            indent={""} maxLen={props.maxNameLength} rightAlign={props.rightAlignElapsed} />
        )}
      </Index>
      {/* Jobs detail: multiple workflows */}
      <For each={displayRuns()}>
        {(run) => (
          <WorkflowRow
            run={run} theme={props.theme} nowSec={nowSec()} pulseFrame={pulseFrame()}
            expanded={isRunExpanded(run.id)} onToggle={() => toggleRun(run.id)}
            maxLen={props.maxNameLength} rightAlign={props.rightAlignElapsed}
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
        return (
          <CICard
            api={api} theme={ctx.theme.current} tuiPollMs={opts.tui_poll_ms}
            hide={opts.hide} detail={opts.detail} jobsDetail={opts.jobs_detail}
            maxNameLength={opts.max_name_length} rightAlignElapsed={opts.right_align_elapsed}
          />
        )
      },
    },
  })
}

export default { id: PLUGIN_ID, tui } satisfies TuiPluginModule & { id: string }
