// @ts-nocheck
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import {
  PLUGIN_ID,
  parseOptions,
  buildCachePath,
  buildRegistryPath,
  registerSession,
  deregisterSession,
  cleanupOrphans,
  cleanupSession,
  emptyCache,
  nowISO,
} from "./shared"

import type { WorkflowJob, WorkflowRun, CICache } from "./shared"

// ---------------------------------------------------------------------------
// Git branch detection
// ---------------------------------------------------------------------------

async function detectBranch(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) return ""
  return out.trim()
}

// ---------------------------------------------------------------------------
// GitHub CLI data fetching
// ---------------------------------------------------------------------------

async function runCmd(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`exit ${code}: ${args.join(" ")}`)
  return out.trim()
}

async function fetchJobsForRun(runId: number, cwd: string): Promise<WorkflowJob[]> {
  const jobsRaw = await runCmd(
    ["gh", "api",
     `repos/{owner}/{repo}/actions/runs/${runId}/jobs`,
     "--jq", ".jobs[] | {name,status,conclusion,started_at,completed_at}"],
    cwd,
  )
  return jobsRaw
    .split("\n")
    .filter((l: string) => l.trim())
    .map((l: string) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

async function fetchRuns(
  branch: string,
  cwd: string,
  maxRuns: number,
  pushWindowMs: number,
): Promise<WorkflowRun[]> {
  const raw = await runCmd(
    ["gh", "run", "list", "--branch", branch, "--limit", String(maxRuns),
     "--json", "databaseId,name,status,conclusion,headBranch,createdAt"],
    cwd,
  )
  const allRuns = JSON.parse(raw)
  if (!allRuns?.length) return []

  const latestTime = new Date(allRuns[0].createdAt).getTime()
  const pushRuns = allRuns.filter(
    (r: any) => Math.abs(new Date(r.createdAt).getTime() - latestTime) < pushWindowMs
  )

  const results: WorkflowRun[] = await Promise.all(
    pushRuns.map(async (r: any) => {
      const jobs = await fetchJobsForRun(r.databaseId, cwd)
      return {
        id: r.databaseId,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        head_branch: r.headBranch,
        jobs,
      }
    })
  )

  return results
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

async function readCache(filePath: string): Promise<CICache> {
  try {
    const text = await readFile(filePath, "utf8")
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

async function writeCache(filePath: string, cache: CICache): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8")
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

const server: Plugin = async (input, options) => {
  const opts = parseOptions(options)
  if (!opts.enabled) return {}

  const cwd = input.directory
  const cachePath = buildCachePath()
  const registryPath = buildRegistryPath(cwd)

  // Clean up orphaned sessions from dead processes
  await cleanupOrphans(registryPath)

  // Register this session
  await registerSession(registryPath, {
    cachePath,
    pid: process.pid,
    startedAt: nowISO(),
  })

  // Global last-refresh timestamp — shared by poll timer and event handlers
  let lastRefreshAt = 0

  const refresh = async () => {
    try {
      const branch = await detectBranch(cwd)
      if (!branch) {
        await writeCache(cachePath, { ...emptyCache(), error: "Not a git repo" })
        return
      }

      const runs = await fetchRuns(branch, cwd, opts.max_runs, opts.push_window_ms)
      await writeCache(cachePath, {
        version: 1,
        updatedAt: nowISO(),
        branch,
        runs,
        error: null,
      })
    } catch (e: any) {
      const prev = await readCache(cachePath)
      await writeCache(cachePath, {
        ...prev,
        updatedAt: nowISO(),
        error: e?.message ?? "fetch failed",
      })
    }
    lastRefreshAt = Date.now()
  }

  // Global debounce — skips if any source (poll or event) already refreshed recently
  const maybeRefresh = () => {
    if (Date.now() - lastRefreshAt >= opts.debounce_ms) {
      void refresh()
    }
  }

  // Initial fetch + periodic poll (also debounced)
  void refresh()
  const timer = setInterval(() => maybeRefresh(), opts.server_poll_ms)
  timer.unref?.()

  // Cleanup on graceful shutdown
  const cleanup = async () => {
    clearInterval(timer)
    await cleanupSession(cachePath)
    await deregisterSession(registryPath, cachePath)
  }

  const onExit = () => { void cleanup() }
  process.on("exit", onExit)
  process.on("SIGINT", onExit)
  process.on("SIGTERM", onExit)

  // Build return object with dynamic event handlers
  const handlers: Record<string, unknown> = { dispose: cleanup }

  if (opts.refresh_on_events) {
    for (const event of opts.refresh_on_events) {
      handlers[event] = async () => {
        maybeRefresh()
      }
    }
  }

  return handlers
}

export default {
  id: PLUGIN_ID,
  server,
}
