// @ts-nocheck
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import {
  PLUGIN_ID,
  parseOptions,
  readCacheText,
  buildCachePath,
  buildRegistryPath,
  registerSession,
  deregisterSession,
  cleanupOrphans,
  cleanupSession,
  emptyCache,
  nowISO,
} from "./shared"
import type { WorkflowJob, WorkflowRun } from "./shared"

async function runCmd(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error(`exit: ${args.join(" ")}`)
  return out.trim()
}

const detectBranch = (cwd: string): Promise<string> =>
  runCmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd).catch(() => "")

async function fetchJobsForRun(runId: number, cwd: string): Promise<WorkflowJob[]> {
  const raw = await runCmd(
    ["gh", "api", `repos/{owner}/{repo}/actions/runs/${runId}/jobs`,
     "--jq", ".jobs[] | {name,status,conclusion,started_at,completed_at}"],
    cwd,
  )
  return raw.split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

async function fetchRuns(
  branch: string, cwd: string, maxRuns: number, pushWindowMs: number,
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
    (r: any) => Math.abs(new Date(r.createdAt).getTime() - latestTime) < pushWindowMs,
  )

  return Promise.all(
    pushRuns.map(async (r: any) => ({
      id: r.databaseId,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      head_branch: r.headBranch,
      jobs: await fetchJobsForRun(r.databaseId, cwd),
    })),
  )
}

async function readCache(filePath: string) {
  try { return readCacheText(await readFile(filePath, "utf8")) }
  catch { return emptyCache() }
}

async function writeCache(filePath: string, cache: any): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(cache, null, 2) + "\n", "utf8")
}

const server: Plugin = async (input, options) => {
  const opts = parseOptions(options)
  if (!opts.enabled) return {}

  const cwd = input.directory
  const cachePath = buildCachePath()
  const registryPath = buildRegistryPath(cwd)

  await cleanupOrphans(registryPath)
  await registerSession(registryPath, { cachePath, pid: process.pid, startedAt: nowISO() })

  let lastRefreshAt = 0

  const refresh = async () => {
    try {
      const branch = await detectBranch(cwd)
      if (!branch) {
        await writeCache(cachePath, { ...emptyCache(), error: "Not a git repo" })
        return
      }
      await writeCache(cachePath, {
        version: 1, updatedAt: nowISO(), branch,
        runs: await fetchRuns(branch, cwd, opts.max_runs, opts.push_window_ms),
        error: null,
      })
    } catch (e: any) {
      const prev = await readCache(cachePath)
      await writeCache(cachePath, { ...prev, updatedAt: nowISO(), error: e?.message ?? "fetch failed" })
    }
    lastRefreshAt = Date.now()
  }

  const maybeRefresh = () => {
    if (Date.now() - lastRefreshAt >= opts.debounce_ms) void refresh()
  }

  void refresh()
  const timer = setInterval(maybeRefresh, opts.server_poll_ms)
  timer.unref?.()

  const cleanup = async () => {
    clearInterval(timer)
    await cleanupSession(cachePath)
    await deregisterSession(registryPath, cachePath)
  }

  for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void cleanup())
  }

  const handlers: Record<string, unknown> = { dispose: cleanup }
  if (opts.refresh_on_events) {
    for (const event of opts.refresh_on_events) {
      handlers[event] = async () => maybeRefresh()
    }
  }

  return handlers
}

export default { id: PLUGIN_ID, server }
