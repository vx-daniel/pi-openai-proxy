/**
 * Proxy process management: PID file, reachability probe, start/stop/status.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { configToEnv, loadConfigFromFile } from '@victor-software-house/pi-openai-proxy/config'

import { type ProxyState, proxyUrl } from './state'

/** Abort a reachability probe after this long. */
const PROBE_TIMEOUT_MS = 2000
/** How long `/proxy start` waits for a freshly spawned proxy to answer. */
const READY_TIMEOUT_MS = 3000
/** Poll interval while waiting for a spawned proxy to answer. */
const READY_POLL_INTERVAL_MS = 300
/** Pause after killing a proxy so its port is released before the next start. */
const PROCESS_SETTLE_DELAY_MS = 500

interface RuntimeStatus {
  reachable: boolean
  models: number
}

interface ProbeBody {
  data: unknown[]
}

function isProbeBody(value: unknown): value is ProbeBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (!('data' in value)) return false
  const candidate: { data: unknown } = value
  return Array.isArray(candidate.data)
}

// Resolve pi-proxy binary: try local dev build, then installed package, then PATH
function findProxyBinary(packageRoot: string): string {
  // Local development: dist/index.mjs in the same package root
  const localBin = resolve(packageRoot, 'dist', 'index.mjs')
  if (existsSync(localBin)) return localBin
  // Installed as dependency: node_modules/pi-proxy/dist/index.mjs
  const depBin = resolve(packageRoot, 'node_modules', 'pi-proxy', 'dist', 'index.mjs')
  if (existsSync(depBin)) return depBin
  // Fallback: assume pi-proxy is in PATH
  return 'pi-proxy'
}

// A built entry runs on the runtime hosting pi (Node); anything else is an executable on PATH.
function proxyCommand(bin: string): { command: string; args: string[] } {
  return bin.endsWith('.mjs')
    ? { command: process.execPath, args: [bin] }
    : { command: bin, args: [] }
}

// --- PID file ---

function getPidPath(): string {
  const piDir =
    process.env['PI_CODING_AGENT_DIR'] ?? resolve(process.env['HOME'] ?? '~', '.pi', 'agent')
  return resolve(piDir, 'proxy.pid')
}

function readPid(): number | undefined {
  const pidPath = getPidPath()
  if (!existsSync(pidPath)) return undefined
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim()
    const pid = Number.parseInt(raw, 10)
    if (!Number.isFinite(pid) || pid <= 0) return undefined
    try {
      process.kill(pid, 0)
      return pid
    } catch {
      unlinkSync(pidPath)
      return undefined
    }
  } catch {
    return undefined
  }
}

function writePid(pid: number): void {
  const pidPath = getPidPath()
  mkdirSync(dirname(pidPath), { recursive: true })
  writeFileSync(pidPath, String(pid), 'utf-8')
}

function removePid(): void {
  const pidPath = getPidPath()
  if (existsSync(pidPath)) {
    try {
      unlinkSync(pidPath)
    } catch {
      // ignore
    }
  }
}

// --- Reachability ---

async function probe(state: ProxyState): Promise<RuntimeStatus> {
  try {
    const headers: Record<string, string> = {}
    if (state.config.authToken.length > 0) {
      headers['authorization'] = `Bearer ${state.config.authToken}`
    }
    const response = await fetch(`${proxyUrl(state.config)}/v1/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers
    })
    if (response.ok) {
      const body: unknown = await response.json()
      let modelCount = 0
      if (isProbeBody(body)) {
        modelCount = body.data.length
      }
      return { reachable: true, models: modelCount }
    }
  } catch {
    // not reachable
  }
  return { reachable: false, models: 0 }
}

async function waitForReady(state: ProxyState, timeoutMs: number): Promise<RuntimeStatus> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await probe(state)
    if (status.reachable) return status
    await sleep(READY_POLL_INTERVAL_MS)
  }
  return { reachable: false, models: 0 }
}

export async function refreshStatus(state: ProxyState, context: ExtensionContext): Promise<void> {
  const status = await probe(state)
  if (status.reachable) {
    context.ui.setStatus(
      'proxy',
      `proxy: ${proxyUrl(state.config)} (${String(status.models)} models)`
    )
  } else {
    context.ui.setStatus('proxy', undefined)
  }
}

// --- Start ---

function startDetached(bin: string, env: Record<string, string>): void {
  const { command, args } = proxyCommand(bin)

  const child = spawn(command, args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
    env: { ...process.env, ...env }
  })

  child.once('error', () => {
    if (child.pid !== undefined) removePid()
  })

  if (child.pid === undefined) {
    throw new Error('No PID returned from spawn')
  }

  child.unref()
  writePid(child.pid)
}

function startSessionTied(
  state: ProxyState,
  context: ExtensionContext,
  bin: string,
  env: Record<string, string>
): void {
  if (state.sessionProcess !== undefined) {
    context.ui.notify('Session proxy already running', 'info')
    return
  }

  const { command, args } = proxyCommand(bin)

  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, ...env }
  })
  state.sessionProcess = child

  child.on('exit', (code) => {
    state.sessionProcess = undefined
    if (code !== null && code !== 0) {
      context.ui.notify(`Proxy exited with code ${String(code)}`, 'warning')
    }
    context.ui.setStatus('proxy', undefined)
  })

  child.on('error', (err) => {
    state.sessionProcess = undefined
    context.ui.notify(`Proxy error: ${err.message}`, 'error')
    context.ui.setStatus('proxy', undefined)
  })
}

async function killStalePid(context: ExtensionContext): Promise<void> {
  const existingPid = readPid()
  if (existingPid === undefined) return
  context.ui.notify(`Stale proxy process ${String(existingPid)} -- killing`, 'warning')
  try {
    process.kill(existingPid, 'SIGTERM')
  } catch {
    // already dead
  }
  removePid()
  await sleep(PROCESS_SETTLE_DELAY_MS)
}

async function spawnProxy(state: ProxyState, context: ExtensionContext): Promise<void> {
  const proxyEnv = configToEnv(state.config)
  const bin = findProxyBinary(state.packageRoot)

  if (state.config.lifetime === 'detached') {
    startDetached(bin, proxyEnv)
  } else {
    startSessionTied(state, context, bin, proxyEnv)
  }

  const ready = await waitForReady(state, READY_TIMEOUT_MS)
  if (ready.reachable) {
    const mode = state.config.lifetime === 'detached' ? 'background' : 'session'
    context.ui.notify(
      `Proxy started at ${proxyUrl(state.config)} (${String(ready.models)} models) [${mode}]`,
      'info'
    )
  } else {
    context.ui.notify(`Proxy spawned but not yet reachable at ${proxyUrl(state.config)}`, 'warning')
  }
  await refreshStatus(state, context)
}

export async function startProxy(state: ProxyState, context: ExtensionContext): Promise<void> {
  state.config = loadConfigFromFile()

  const status = await probe(state)
  if (status.reachable) {
    context.ui.notify(
      `Proxy already running at ${proxyUrl(state.config)} (${String(status.models)} models)`,
      'info'
    )
    await refreshStatus(state, context)
    return
  }

  // Clean up stale PID
  await killStalePid(context)

  context.ui.setStatus('proxy', 'proxy: starting...')

  try {
    await spawnProxy(state, context)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    context.ui.notify(`Failed to start proxy: ${message}`, 'error')
    context.ui.setStatus('proxy', undefined)
  }
}

// --- Stop / restart / status ---

export async function stopProxy(state: ProxyState, context: ExtensionContext): Promise<void> {
  if (state.sessionProcess !== undefined) {
    state.sessionProcess.kill('SIGTERM')
    state.sessionProcess = undefined
    context.ui.notify('Session proxy stopped', 'info')
    context.ui.setStatus('proxy', undefined)
    return
  }

  const pid = readPid()
  if (pid !== undefined) {
    try {
      process.kill(pid, 'SIGTERM')
      removePid()
      context.ui.notify(`Proxy stopped (pid ${String(pid)})`, 'info')
      context.ui.setStatus('proxy', undefined)
      return
    } catch {
      removePid()
    }
  }

  const status = await probe(state)
  if (status.reachable) {
    context.ui.notify(
      `Proxy at ${proxyUrl(state.config)} was not started by /proxy -- stop it manually`,
      'info'
    )
  } else {
    context.ui.notify('Proxy is not running', 'info')
    context.ui.setStatus('proxy', undefined)
  }
}

export async function restartProxy(state: ProxyState, context: ExtensionContext): Promise<void> {
  await stopProxy(state, context)
  await sleep(PROCESS_SETTLE_DELAY_MS)
  await startProxy(state, context)
}

export async function showStatus(state: ProxyState, context: ExtensionContext): Promise<void> {
  const status = await probe(state)
  const pid = readPid()
  const pidTag = pid === undefined ? '' : ` [pid ${String(pid)}]`

  if (status.reachable) {
    context.ui.notify(
      `${proxyUrl(state.config)} -- ${String(status.models)} models available${pidTag}`,
      'info'
    )
  } else {
    context.ui.notify('Proxy not running. Use /proxy start', 'info')
  }
  await refreshStatus(state, context)
}

/** Kill a session-tied proxy when the pi session ends. */
export function stopSessionProcess(state: ProxyState): void {
  if (state.sessionProcess !== undefined) {
    state.sessionProcess.kill('SIGTERM')
    state.sessionProcess = undefined
  }
}
