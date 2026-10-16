/**
 * Proxy process management: PID file, reachability probe, start/stop/status.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { configToEnv, loadConfigFromFile } from '@vx-daniel/pi-openai-proxy/config'
import { proxyLogger } from '@vx-daniel/pi-openai-proxy/logging'

import { type ProxyState, proxyUrl } from './state'

/** Abort a reachability probe after this long. */
const PROBE_TIMEOUT_MS = 2000
/** How long `/proxy start` waits for a freshly spawned proxy to answer. */
const READY_TIMEOUT_MS = 3000
/** Poll interval while waiting for a spawned proxy to answer. */
const READY_POLL_INTERVAL_MS = 300
/** Pause after killing a proxy so its port is released before the next start. */
const PROCESS_SETTLE_DELAY_MS = 500

const processLogger = proxyLogger('extension', 'process')

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

// The proxy entry point: the built `dist/index.mjs` this package ships beside the extension, or
// failing that the package's `pi-openai-proxy` bin on PATH.
function findProxyBinary(packageRoot: string): string {
  const localBin = resolve(packageRoot, 'dist', 'index.mjs')
  if (existsSync(localBin)) {
    processLogger.debug('Resolved proxy binary to built entry {bin}', { bin: localBin })
    return localBin
  }
  processLogger.debug('No built entry at {localBin}; using {bin} from PATH', {
    localBin,
    bin: 'pi-openai-proxy'
  })
  return 'pi-openai-proxy'
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
  if (!existsSync(pidPath)) {
    processLogger.debug('No PID file at {pidPath}', { pidPath })
    return undefined
  }
  try {
    const raw = readFileSync(pidPath, 'utf-8').trim()
    const pid = Number.parseInt(raw, 10)
    if (!Number.isFinite(pid) || pid <= 0) {
      processLogger.warn('Ignoring PID file {pidPath}: content is not a valid PID', { pidPath })
      return undefined
    }
    try {
      process.kill(pid, 0)
      processLogger.debug('PID file {pidPath} names live process {pid}', { pidPath, pid })
      return pid
    } catch {
      processLogger.info('Removing stale PID file {pidPath}: process {pid} is not running', {
        pidPath,
        pid
      })
      unlinkSync(pidPath)
      return undefined
    }
  } catch (error: unknown) {
    processLogger.warn('Could not read PID file {pidPath}; treating as no PID', { pidPath, error })
    return undefined
  }
}

function writePid(pid: number): void {
  const pidPath = getPidPath()
  mkdirSync(dirname(pidPath), { recursive: true })
  writeFileSync(pidPath, String(pid), 'utf-8')
  processLogger.debug('Wrote PID {pid} to {pidPath}', { pid, pidPath })
}

function removePid(): void {
  const pidPath = getPidPath()
  if (existsSync(pidPath)) {
    try {
      unlinkSync(pidPath)
      processLogger.debug('Removed PID file {pidPath}', { pidPath })
    } catch (error: unknown) {
      processLogger.warn('Could not remove PID file {pidPath}; ignoring', { pidPath, error })
    }
  }
}

// --- Reachability ---

async function probe(state: ProxyState): Promise<RuntimeStatus> {
  const url = `${proxyUrl(state.config)}/v1/models`
  try {
    const headers: Record<string, string> = {}
    if (state.config.authToken.length > 0) {
      headers['authorization'] = `Bearer ${state.config.authToken}`
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers
    })
    if (response.ok) {
      const body: unknown = await response.json()
      let modelCount = 0
      if (isProbeBody(body)) {
        modelCount = body.data.length
      } else {
        processLogger.warn('Probe of {url} returned a body without a data array', { url })
      }
      processLogger.debug('Probe of {url}: reachable with {modelCount} models', { url, modelCount })
      return { reachable: true, models: modelCount }
    }
    processLogger.debug('Probe of {url}: not reachable (HTTP {status})', {
      url,
      status: response.status
    })
  } catch (error: unknown) {
    processLogger.debug('Probe of {url}: not reachable', { url, error })
  }
  return { reachable: false, models: 0 }
}

async function waitForReady(state: ProxyState, timeoutMs: number): Promise<RuntimeStatus> {
  const start = Date.now()
  let attempts = 0
  while (Date.now() - start < timeoutMs) {
    attempts += 1
    const status = await probe(state)
    if (status.reachable) {
      processLogger.debug(
        'Proxy ready after {attempts} probe(s) in {durationMs} ms with {modelCount} models',
        { attempts, durationMs: Date.now() - start, modelCount: status.models }
      )
      return status
    }
    await sleep(READY_POLL_INTERVAL_MS)
  }
  processLogger.debug('Proxy not ready after {attempts} probe(s) in {durationMs} ms', {
    attempts,
    durationMs: Date.now() - start
  })
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

  child.once('error', (error) => {
    processLogger.error('Detached proxy process {command} failed: {message}', {
      command,
      message: error.message,
      error
    })
    if (child.pid !== undefined) removePid()
  })

  if (child.pid === undefined) {
    throw new Error('No PID returned from spawn')
  }

  child.unref()
  processLogger.info('Spawned proxy {pid} with lifetime {lifetime}', {
    pid: child.pid,
    lifetime: 'detached',
    command
  })
  writePid(child.pid)
}

function startSessionTied(
  state: ProxyState,
  context: ExtensionContext,
  bin: string,
  env: Record<string, string>
): void {
  if (state.sessionProcess !== undefined) {
    processLogger.debug('Session proxy {pid} already running; not spawning another', {
      pid: state.sessionProcess.pid
    })
    context.ui.notify('Session proxy already running', 'info')
    return
  }

  const { command, args } = proxyCommand(bin)

  const child = spawn(command, args, {
    // Discard the proxy's output: unread pipes fill up and block a proxy that logs to stderr.
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: false,
    env: { ...process.env, ...env }
  })
  state.sessionProcess = child
  processLogger.info('Spawned proxy {pid} with lifetime {lifetime}', {
    pid: child.pid,
    lifetime: 'session',
    command
  })
  processLogger.debug("Session proxy {pid}: the proxy's own stdout/stderr are discarded", {
    pid: child.pid
  })

  child.on('exit', (code, signal) => {
    state.sessionProcess = undefined
    if (code !== null && code !== 0) {
      processLogger.warn('Session proxy {pid} exited with code {code}', { pid: child.pid, code })
      context.ui.notify(`Proxy exited with code ${String(code)}`, 'warning')
    } else {
      processLogger.info('Session proxy {pid} exited (code {code}, signal {signal})', {
        pid: child.pid,
        code,
        signal
      })
    }
    context.ui.setStatus('proxy', undefined)
  })

  child.on('error', (err) => {
    processLogger.error('Session proxy process {command} failed: {message}', {
      command,
      message: err.message,
      error: err
    })
    state.sessionProcess = undefined
    context.ui.notify(`Proxy error: ${err.message}`, 'error')
    context.ui.setStatus('proxy', undefined)
  })
}

async function killStalePid(context: ExtensionContext): Promise<void> {
  const existingPid = readPid()
  if (existingPid === undefined) return
  processLogger.warn('Killing stale proxy process {pid} before starting', { pid: existingPid })
  context.ui.notify(`Stale proxy process ${String(existingPid)} -- killing`, 'warning')
  try {
    process.kill(existingPid, 'SIGTERM')
  } catch (error: unknown) {
    processLogger.debug('Stale proxy process {pid} already exited', { pid: existingPid, error })
  }
  removePid()
  await sleep(PROCESS_SETTLE_DELAY_MS)
}

async function spawnProxy(state: ProxyState, context: ExtensionContext): Promise<void> {
  const proxyEnv = configToEnv(state.config)
  const bin = findProxyBinary(state.packageRoot)
  processLogger.debug('Starting proxy for {url} with lifetime {lifetime}', {
    url: proxyUrl(state.config),
    lifetime: state.config.lifetime
  })

  if (state.config.lifetime === 'detached') {
    startDetached(bin, proxyEnv)
  } else {
    startSessionTied(state, context, bin, proxyEnv)
  }

  const ready = await waitForReady(state, READY_TIMEOUT_MS)
  if (ready.reachable) {
    const mode = state.config.lifetime === 'detached' ? 'background' : 'session'
    processLogger.info('Proxy started at {url} with {modelCount} models', {
      url: proxyUrl(state.config),
      modelCount: ready.models,
      lifetime: state.config.lifetime
    })
    context.ui.notify(
      `Proxy started at ${proxyUrl(state.config)} (${String(ready.models)} models) [${mode}]`,
      'info'
    )
  } else {
    processLogger.warn('Proxy spawned but not reachable at {url} within {timeoutMs} ms', {
      url: proxyUrl(state.config),
      timeoutMs: READY_TIMEOUT_MS
    })
    context.ui.notify(`Proxy spawned but not yet reachable at ${proxyUrl(state.config)}`, 'warning')
  }
  await refreshStatus(state, context)
}

export async function startProxy(state: ProxyState, context: ExtensionContext): Promise<void> {
  state.config = loadConfigFromFile()

  const status = await probe(state)
  if (status.reachable) {
    processLogger.info('Proxy already running at {url} with {modelCount} models; not starting', {
      url: proxyUrl(state.config),
      modelCount: status.models
    })
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
    processLogger.error('Failed to start proxy: {message}', { message, error: err })
    context.ui.notify(`Failed to start proxy: ${message}`, 'error')
    context.ui.setStatus('proxy', undefined)
  }
}

// --- Stop / restart / status ---

export async function stopProxy(state: ProxyState, context: ExtensionContext): Promise<void> {
  if (state.sessionProcess !== undefined) {
    const sent = state.sessionProcess.kill('SIGTERM')
    processLogger.info('Stopped session proxy {pid} (signal delivered: {sent})', {
      pid: state.sessionProcess.pid,
      sent
    })
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
      processLogger.info('Stopped proxy {pid}', { pid })
      context.ui.notify(`Proxy stopped (pid ${String(pid)})`, 'info')
      context.ui.setStatus('proxy', undefined)
      return
    } catch (error: unknown) {
      processLogger.warn('Could not signal proxy {pid}; removing its PID file', { pid, error })
      removePid()
    }
  }

  const status = await probe(state)
  if (status.reachable) {
    processLogger.info('Proxy at {url} was not started by this extension; leaving it running', {
      url: proxyUrl(state.config)
    })
    context.ui.notify(
      `Proxy at ${proxyUrl(state.config)} was not started by /proxy -- stop it manually`,
      'info'
    )
  } else {
    processLogger.debug('Stop requested but no proxy is running')
    context.ui.notify('Proxy is not running', 'info')
    context.ui.setStatus('proxy', undefined)
  }
}

export async function restartProxy(state: ProxyState, context: ExtensionContext): Promise<void> {
  processLogger.info('Restarting proxy')
  await stopProxy(state, context)
  await sleep(PROCESS_SETTLE_DELAY_MS)
  await startProxy(state, context)
}

export async function showStatus(state: ProxyState, context: ExtensionContext): Promise<void> {
  const status = await probe(state)
  const pid = readPid()
  const pidTag = pid === undefined ? '' : ` [pid ${String(pid)}]`
  processLogger.debug('Status: reachable {reachable}, {modelCount} models, pid {pid}', {
    reachable: status.reachable,
    modelCount: status.models,
    pid
  })

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
    processLogger.info('Stopping session proxy {pid} at session shutdown', {
      pid: state.sessionProcess.pid
    })
    state.sessionProcess.kill('SIGTERM')
    state.sessionProcess = undefined
  }
}
