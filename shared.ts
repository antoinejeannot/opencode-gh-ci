import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const PLUGIN_ID = "gh-ci"

const BASE_DIR = path.join(os.tmpdir(), "opencode-gh-ci")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowJob {
  name: string
  status: "queued" | "in_progress" | "completed" | "waiting"
  conclusion: string | null
  started_at: string | null
  completed_at: string | null
}

export interface WorkflowRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  head_branch: string
  jobs: WorkflowJob[]
}

export interface CICache {
  version: 1
  updatedAt: string
  branch: string
  runs: WorkflowRun[]
  error: string | null
}

export interface RegistryEntry {
  cachePath: string
  pid: number
  startedAt: string
}

export interface HideFilters {
  workflows: RegExp[]
  jobs: RegExp[]
}

export type DetailLevel = "overall" | "workflows" | "jobs"

export interface JobsDetailOptions {
  collapse_single_workflow: boolean
}

export interface PluginOptions {
  enabled: boolean
  server_poll_ms: number
  tui_poll_ms: number
  debounce_ms: number
  push_window_ms: number
  max_runs: number
  max_name_length: number
  right_align_elapsed: boolean
  refresh_on_events: string[] | false
  hide: HideFilters
  detail: DetailLevel
  jobs_detail: JobsDetailOptions
}

// ---------------------------------------------------------------------------
// Options parsing
// ---------------------------------------------------------------------------

const ALL_EVENTS = [
  "chat.message",
  "tool.execute.before",
  "tool.execute.after",
  "command.execute.before",
  "shell.env",
] as const

const DEFAULTS = {
  enabled: true,
  server_poll_ms: 10_000,
  tui_poll_ms: 5_000,
  debounce_ms: 10_000,
  push_window_ms: 60_000,
  max_runs: 10,
  max_name_length: 24,
  right_align_elapsed: true,
} as const

const DEFAULT_JOBS_DETAIL: JobsDetailOptions = { collapse_single_workflow: true }

const EMPTY_OPTIONS: PluginOptions = {
  ...DEFAULTS,
  refresh_on_events: [...ALL_EVENTS],
  hide: { workflows: [], jobs: [] },
  detail: "jobs",
  jobs_detail: { ...DEFAULT_JOBS_DETAIL },
}

const toRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : undefined

const toBool = (v: unknown, fb: boolean) => (typeof v === "boolean" ? v : fb)
const toNum = (v: unknown, fb: number, min = 0) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, v) : fb

const toRegexList = (v: unknown): RegExp[] => {
  if (!Array.isArray(v)) return []
  return v
    .filter((s): s is string => typeof s === "string")
    .map((s) => { try { return new RegExp(s, "i") } catch { return null } })
    .filter((r): r is RegExp => r !== null)
}

export function parseOptions(raw: unknown): PluginOptions {
  const rec = toRecord(raw)
  if (!rec) return EMPTY_OPTIONS

  // refresh_on_events: false | true | string[]
  const roe = rec.refresh_on_events
  const refreshOnEvents: string[] | false =
    roe === false ? false
    : roe === true ? [...ALL_EVENTS]
    : Array.isArray(roe) ? roe.filter((e): e is string => typeof e === "string")
    : [...ALL_EVENTS]

  // hide: { workflows: [...], jobs: [...] }
  const hideRec = toRecord(rec.hide)

  // detail: "overall" | "workflows" | "jobs" | { jobs: {...} } | { workflows: {} } | { overall: {} }
  const VALID_LEVELS: DetailLevel[] = ["overall", "workflows", "jobs"]
  let detail: DetailLevel = "jobs"
  let jobsDetail: JobsDetailOptions = { ...DEFAULT_JOBS_DETAIL }

  const d = rec.detail
  if (typeof d === "string" && VALID_LEVELS.includes(d as DetailLevel)) {
    detail = d as DetailLevel
  } else if (d && typeof d === "object" && !Array.isArray(d)) {
    const dRec = d as Record<string, unknown>
    if ("jobs" in dRec) {
      detail = "jobs"
      const jRec = toRecord(dRec.jobs)
      jobsDetail = {
        collapse_single_workflow: toBool(jRec?.collapse_single_workflow, DEFAULT_JOBS_DETAIL.collapse_single_workflow),
      }
    } else if ("workflows" in dRec) {
      detail = "workflows"
    } else if ("overall" in dRec) {
      detail = "overall"
    }
  }

  return {
    enabled: toBool(rec.enabled, DEFAULTS.enabled),
    server_poll_ms: toNum(rec.server_poll_ms, DEFAULTS.server_poll_ms, 5000),
    tui_poll_ms: toNum(rec.tui_poll_ms, DEFAULTS.tui_poll_ms, 1000),
    debounce_ms: toNum(rec.debounce_ms, DEFAULTS.debounce_ms, 1000),
    push_window_ms: toNum(rec.push_window_ms, DEFAULTS.push_window_ms, 10_000),
    max_runs: toNum(rec.max_runs, DEFAULTS.max_runs, 1),
    max_name_length: toNum(rec.max_name_length, DEFAULTS.max_name_length, 10),
    right_align_elapsed: toBool(rec.right_align_elapsed, DEFAULTS.right_align_elapsed),
    refresh_on_events: refreshOnEvents,
    hide: {
      workflows: toRegexList(hideRec?.workflows),
      jobs: toRegexList(hideRec?.jobs),
    },
    detail,
    jobs_detail: jobsDetail,
  }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export function filterRuns(runs: WorkflowRun[] | undefined, hide: HideFilters): WorkflowRun[] {
  if (!runs?.length) return []
  if (!hide.workflows.length && !hide.jobs.length) return runs

  return runs
    .filter((r) => !hide.workflows.some((re) => re.test(r.name)))
    .map((r) => {
      if (!hide.jobs.length) return r
      const filtered = r.jobs.filter((j) => !hide.jobs.some((re) => re.test(j.name)))
      return filtered.length === r.jobs.length ? r : { ...r, jobs: filtered }
    })
}

// ---------------------------------------------------------------------------
// Cache paths
// ---------------------------------------------------------------------------

export const nowISO = () => new Date().toISOString()

export const emptyCache = (): CICache => ({
  version: 1,
  updatedAt: nowISO(),
  branch: "",
  runs: [],
  error: null,
})

export function buildCachePath(): string {
  return path.join(BASE_DIR, randomUUID(), "ci.json")
}

export function buildRegistryPath(root: string): string {
  const digest = createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 12)
  return path.join(BASE_DIR, `${digest}.registry.json`)
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export async function readRegistry(registryPath: string): Promise<RegistryEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(registryPath, "utf8"))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeRegistry(registryPath: string, entries: RegistryEntry[]): Promise<void> {
  await mkdir(path.dirname(registryPath), { recursive: true })
  await writeFile(registryPath, JSON.stringify(entries, null, 2) + "\n", "utf8")
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export async function registerSession(registryPath: string, entry: RegistryEntry): Promise<void> {
  const entries = await readRegistry(registryPath)
  entries.push(entry)
  await writeRegistry(registryPath, entries)
}

export async function deregisterSession(registryPath: string, cachePath: string): Promise<void> {
  const entries = await readRegistry(registryPath)
  await writeRegistry(registryPath, entries.filter((e) => e.cachePath !== cachePath))
}

export async function cleanupOrphans(registryPath: string): Promise<void> {
  const entries = await readRegistry(registryPath)
  const alive: RegistryEntry[] = []

  for (const entry of entries) {
    if (isPidAlive(entry.pid)) {
      alive.push(entry)
    } else {
      try { await rm(path.dirname(entry.cachePath), { recursive: true, force: true }) } catch {}
    }
  }

  await writeRegistry(registryPath, alive)
}

export async function cleanupSession(cachePath: string): Promise<void> {
  try { await rm(path.dirname(cachePath), { recursive: true, force: true }) } catch {}
}

// ---------------------------------------------------------------------------
// Cache read/parse
// ---------------------------------------------------------------------------

export function readCacheText(text: string): CICache {
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object") return emptyCache()
    return {
      version: 1,
      updatedAt: parsed.updatedAt || nowISO(),
      branch: parsed.branch || "",
      runs: parsed.runs || [],
      error: parsed.error || null,
    }
  } catch {
    return emptyCache()
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const DOT = "\u2022"
export const PULSE_FRAMES = ["\u2022", "\u25E6"]

function formatElapsed(seconds: number): string {
  if (seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function getJobElapsed(job: WorkflowJob, nowSec: number): string {
  if (!job.started_at) return ""
  const started = Math.floor(new Date(job.started_at).getTime() / 1000)
  const end = job.completed_at
    ? Math.floor(new Date(job.completed_at).getTime() / 1000)
    : nowSec
  return formatElapsed(end - started)
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s
}
