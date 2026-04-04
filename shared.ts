import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const PLUGIN_ID = "gh-ci"

const BASE_DIR = path.join(os.tmpdir(), "opencode-gh-ci")

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

// All plugin trigger events that can be subscribed to
const ALL_EVENTS = [
  "chat.message",
  "tool.execute.before",
  "tool.execute.after",
  "command.execute.before",
  "shell.env",
] as const

const DEFAULT_EVENTS = [...ALL_EVENTS] as string[]

const DEFAULTS = {
  enabled: true,
  server_poll_ms: 10_000,
  tui_poll_ms: 5_000,
  debounce_ms: 10_000,
  push_window_ms: 60_000,
  max_runs: 10,
} as const

export interface HideFilters {
  workflows: RegExp[]
  jobs: RegExp[]
}

export interface PluginOptions {
  enabled: boolean
  server_poll_ms: number
  tui_poll_ms: number
  debounce_ms: number
  push_window_ms: number
  max_runs: number
  refresh_on_events: string[] | false
  hide: HideFilters
  collapse_single_workflow: boolean
}

const toRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : undefined

const toBool = (v: unknown, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback

const toRegexList = (v: unknown): RegExp[] => {
  if (!Array.isArray(v)) return []
  return v
    .filter((s): s is string => typeof s === "string")
    .map((s) => { try { return new RegExp(s, "i") } catch { return null } })
    .filter((r): r is RegExp => r !== null)
}

const toNum = (v: unknown, fallback: number, min = 0): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback
  return Math.max(min, v)
}

export function parseOptions(raw: unknown): PluginOptions {
  const rec = toRecord(raw)
  if (!rec) return { ...DEFAULTS, refresh_on_events: [...DEFAULT_EVENTS], hide: { workflows: [], jobs: [] }, collapse_single_workflow: true }

  // Parse refresh_on_events:
  //   false                          → disabled
  //   true                           → all available events
  //   undefined                      → default events (chat.message)
  //   ["chat.message", "tool.execute.after"]  → specific events
  let refreshOnEvents: string[] | false
  const roe = rec.refresh_on_events
  if (roe === false) {
    refreshOnEvents = false
  } else if (roe === true) {
    refreshOnEvents = [...ALL_EVENTS]
  } else if (Array.isArray(roe)) {
    refreshOnEvents = roe.filter((e): e is string => typeof e === "string")
  } else {
    refreshOnEvents = [...DEFAULT_EVENTS]
  }

  // Parse hide: { workflows: [...], jobs: [...] }
  const hideRec = toRecord(rec.hide)
  const hide: HideFilters = {
    workflows: toRegexList(hideRec?.workflows),
    jobs: toRegexList(hideRec?.jobs),
  }

  return {
    enabled: toBool(rec.enabled, DEFAULTS.enabled),
    server_poll_ms: toNum(rec.server_poll_ms, DEFAULTS.server_poll_ms, 5000),
    tui_poll_ms: toNum(rec.tui_poll_ms, DEFAULTS.tui_poll_ms, 1000),
    debounce_ms: toNum(rec.debounce_ms, DEFAULTS.debounce_ms, 1000),
    push_window_ms: toNum(rec.push_window_ms, DEFAULTS.push_window_ms, 10_000),
    max_runs: toNum(rec.max_runs, DEFAULTS.max_runs, 1),
    refresh_on_events: refreshOnEvents,
    hide,
    collapse_single_workflow: toBool(rec.collapse_single_workflow, true),
  }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Filter runs and jobs based on hide regexes. Returns a new array (no mutation). */
export function filterRuns(runs: WorkflowRun[] | undefined, hide: HideFilters): WorkflowRun[] {
  if (!runs?.length) return []
  if (!hide.workflows.length && !hide.jobs.length) return runs

  return runs
    .filter((r) => !hide.workflows.some((re) => re.test(r.name)))
    .map((r) => {
      if (!hide.jobs.length) return r
      const filteredJobs = r.jobs.filter((j) => !hide.jobs.some((re) => re.test(j.name)))
      return filteredJobs.length === r.jobs.length ? r : { ...r, jobs: filteredJobs }
    })
}

// ---------------------------------------------------------------------------
// Domain types
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

// ---------------------------------------------------------------------------
// Cache path helpers
// ---------------------------------------------------------------------------

export const nowISO = () => new Date().toISOString()

export const emptyCache = (): CICache => ({
  version: 1,
  updatedAt: nowISO(),
  branch: "",
  runs: [],
  error: null,
})

/** Random per-session cache directory: <tmpdir>/opencode-gh-ci/<uuid>/ci.json */
export function buildCachePath(): string {
  return path.join(BASE_DIR, randomUUID(), "ci.json")
}

/** Deterministic registry file per project: <tmpdir>/opencode-gh-ci/<hash>.registry.json */
export function buildRegistryPath(root: string): string {
  const digest = createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 12)
  return path.join(BASE_DIR, `${digest}.registry.json`)
}

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

export async function readRegistry(registryPath: string): Promise<RegistryEntry[]> {
  try {
    const text = await readFile(registryPath, "utf8")
    const parsed = JSON.parse(text)
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
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Register this session in the registry */
export async function registerSession(
  registryPath: string,
  entry: RegistryEntry,
): Promise<void> {
  const entries = await readRegistry(registryPath)
  entries.push(entry)
  await writeRegistry(registryPath, entries)
}

/** Remove this session from the registry */
export async function deregisterSession(
  registryPath: string,
  cachePath: string,
): Promise<void> {
  const entries = await readRegistry(registryPath)
  const filtered = entries.filter((e) => e.cachePath !== cachePath)
  await writeRegistry(registryPath, filtered)
}

/** Scan registry, remove entries with dead PIDs, delete their cache directories */
export async function cleanupOrphans(registryPath: string): Promise<void> {
  const entries = await readRegistry(registryPath)
  const alive: RegistryEntry[] = []

  for (const entry of entries) {
    if (isPidAlive(entry.pid)) {
      alive.push(entry)
    } else {
      try {
        const dir = path.dirname(entry.cachePath)
        await rm(dir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }

  await writeRegistry(registryPath, alive)
}

/** Delete this session's cache directory */
export async function cleanupSession(cachePath: string): Promise<void> {
  try {
    const dir = path.dirname(cachePath)
    await rm(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
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
      runs: parsed.runs || (parsed.run ? [parsed.run] : []),
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

export function formatElapsed(seconds: number): string {
  if (seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function getJobElapsed(job: WorkflowJob, nowSec: number): string {
  if (!job.started_at) return ""
  const started = Math.floor(new Date(job.started_at).getTime() / 1000)
  if (job.completed_at) {
    const completed = Math.floor(new Date(job.completed_at).getTime() / 1000)
    return formatElapsed(completed - started)
  }
  return formatElapsed(nowSec - started)
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s
}
