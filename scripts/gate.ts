#!/usr/bin/env node
/**
 * Ported from zen-harness-foundation's `scripts/gate.ts` (itself from slop-factory's bun example).
 * The shape is deliberately identical so improvements travel in either direction; the GATES list
 * and this header are this repository's own.
 *
 * The single repo-wide gate. One ordered list of checks; `check:all` delegates here, and both the
 * pre-commit hook (`.vite-hooks/pre-commit`) and CI (`.github/workflows/ci.yml`, and the release
 * workflow before it publishes) invoke `check:all`, so one list is the single source of what
 * "green" means everywhere. Add a check here and every caller inherits it.
 *
 * Ordering is cheap-first: a fast format or lint failure surfaces before the slower test and build
 * gates run.
 *
 * The checks, in the order GATES lists them:
 *   1. format — `vp fmt --check`: Oxfmt formatting and import order, check-only. The style is the
 *                `fmt` block of `vite.config.ts`; `vp fmt` writes it.
 *   2. lint   — `vp lint`: the `lint` block of `vite.config.ts` — the Viaanix rules, type-aware,
 *                with `typeCheck` on, so this gate is also the TypeScript type check — plus the
 *                zod, import-alias, repo (`lint/repo-rules.ts`) and naming (`lint/naming.ts`)
 *                plugins. Warnings fail it (`maxWarnings: 0`).
 *   3. test   — `vp test --project offline`: Vitest over the unit and integration suites, with
 *                no real pi login or provider credentials (test/setup/offline.ts). The live
 *                conformance suite exists only under `test:live`.
 *   4. build  — `vp pack`: the tsdown build of every published entry point and its declarations.
 *                Last, because it is the slowest and the checks above cover the source it reads.
 *
 * ⚠ Each row's name and first backticked command is CHECKED against GATES and package.json by
 * `test/unit/gate.test.ts`: this list is the documented authority for what "green" means, and a
 * header nothing checks is a header that drifts.
 *
 * ADDING A GATE. Append an entry to GATES (and its row above, and its package.json script) and
 * every caller — the pre-commit hook, CI, a developer running `pnpm run check:all` — inherits it
 * with no other edit. Put expensive behavioural checks LAST so the cheap ones fail fast.
 *
 * Runtime is node — `check:all` runs `node scripts/gate.ts`, and Node strips the TypeScript types
 * at load. Each gate shells out through `<package manager> run <script>`, so a command's
 * definition lives in exactly one place: package.json.
 */
import { spawn } from 'node:child_process'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

/**
 * The package managers this gate knows how to shell out to. Each runs a package.json script with
 * `<manager> run <script>`, so the invocation shape is identical and only the binary differs.
 */
const KNOWN_PACKAGE_MANAGERS = ['npm', 'bun', 'pnpm', 'yarn'] as const
type PackageManager = (typeof KNOWN_PACKAGE_MANAGERS)[number]

const DEFAULT_PACKAGE_MANAGER: PackageManager = 'npm'

/**
 * Which package manager to shell out to for each gate.
 *
 *   1. `npm_config_user_agent`: every major package manager sets it when running a script, and its
 *      first token is the manager's name (`pnpm/11.1.1 …`, `npm/11.17.0 …`). Authoritative when the
 *      gate was reached via `<manager> run check:all`, which is the normal path.
 *   2. The runtime itself: when the script is invoked DIRECTLY under Bun no user agent is set, but a
 *      `Bun` global means Bun is present and should be used.
 *
 * Falls back to npm, which is correct for `node scripts/gate.ts` on a normal Node install: npm runs
 * any package.json script, whichever manager installed the tree.
 */
function detectPackageManager(): PackageManager {
  const userAgent = process.env.npm_config_user_agent
  if (userAgent !== undefined) {
    const managerName = userAgent.split('/')[0]
    const knownManager = KNOWN_PACKAGE_MANAGERS.find((candidate) => candidate === managerName)
    if (knownManager !== undefined) {
      return knownManager
    }
  }
  return 'Bun' in globalThis ? 'bun' : DEFAULT_PACKAGE_MANAGER
}

const PACKAGE_MANAGER = detectPackageManager()

/** One child-process gate: a display name, a one-line description, and the script it runs. */
interface Gate {
  readonly name: string
  readonly describe: string
  /** The package.json script name — run as `<package manager> run <script>`. */
  readonly script: string
}

/** Exported for `test/unit/gate.test.ts`, which holds the header above equal to this list. */
export const GATES: readonly Gate[] = [
  {
    name: 'format',
    describe: 'oxfmt: formatting and import order (check-only)',
    script: 'format:check'
  },
  {
    name: 'lint',
    describe: 'oxlint: the rules in vite.config.ts, type-aware, with the TypeScript type check',
    script: 'lint'
  },
  {
    name: 'test',
    describe: 'vitest: the unit and integration suites',
    script: 'test:ci'
  },
  {
    name: 'build',
    describe: 'tsdown: every published entry point and its declarations',
    script: 'build'
  }
]

/**
 * A tool that died mid-run and still exited 0: the one failure a gate cannot see by asking the
 * exit code.
 *
 * Measured upstream (2026-09-10): Biome 2.5.13 with a GritQL plugin loaded overflowed a worker
 * thread's stack, printed `fatal runtime error: stack overflow, aborting`, and **exited 0**.
 * Whatever that worker held was never checked, and the gate reported green over it. Oxlint, Oxfmt
 * and tsgolint are native tools too, so the scan stays.
 *
 * Rust panics and segfaults print their own banner and are covered by the same scan. A tool that
 * dies loudly AND exits non-zero was already caught by the status check below.
 */
const WORKER_ABORT = /has overflowed its stack|fatal runtime error|panicked at|Segmentation fault/

/** Whether a tool's stderr says it aborted. Exported for `test/unit/gate.test.ts`. */
export function reportsWorkerAbort(stderr: string): boolean {
  return WORKER_ABORT.test(stderr)
}

/**
 * The overlap kept between stderr chunks so a banner split across a chunk boundary still matches —
 * comfortably longer than the longest phrase in `WORKER_ABORT`.
 */
const ABORT_SCAN_OVERLAP = 64

/**
 * Runs one gate to completion. Both of the tool's streams are piped and written straight through as
 * they arrive — live, verbatim, unbuffered, each to the stream it came from. Only stderr is scanned
 * for a runtime abort, and nothing accumulates, so there is no output size a gate can exceed.
 * Resolves the child's exit code (non-zero = failure); a child killed by a signal, one that failed
 * to spawn, or one that aborted while claiming success, fails.
 *
 * Both streams are piped rather than one, because inheriting stdout while piping stderr races a
 * direct fd against one that round-trips our event loop: a linter writing diagnostics to stdout and
 * its summary to stderr had the two spliced into each other mid-line. Delaying both by the same
 * path keeps the tool's own order.
 */
function runGate(gate: Gate): Promise<number> {
  process.stdout.write(`\n${BOLD}▶ ${gate.name}${RESET} ${DIM}— ${gate.describe}${RESET}\n`)
  return new Promise<number>((resolve) => {
    const child = spawn(PACKAGE_MANAGER, ['run', gate.script], {
      stdio: ['inherit', 'pipe', 'pipe'],
      // Piping costs the tool its TTY, and most tools drop color when they lose it. Ask for it back
      // only when both of ours are terminals: forcing it with either redirected would write escapes
      // into someone's log file.
      env:
        process.stdout.isTTY && process.stderr.isTTY
          ? { ...process.env, FORCE_COLOR: '1' }
          : process.env
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => process.stdout.write(chunk))

    // Only stderr is scanned: an abort banner is a runtime's dying words, always on stderr, and a
    // tool that quotes source on stdout (a linter printing a file that names the banners) would
    // otherwise take the gate down for reporting correctly.
    let aborted = false
    let carry = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk)
      const scanWindow = carry + chunk
      if (reportsWorkerAbort(scanWindow)) aborted = true
      carry = scanWindow.slice(-ABORT_SCAN_OVERLAP)
    })

    let settled = false
    const settle = (code: number): void => {
      if (settled) return
      settled = true
      resolve(code)
    }

    child.on('error', (error: Error) => {
      process.stderr.write(`${RED}gate "${gate.name}" failed to spawn: ${error.message}${RESET}\n`)
      settle(1)
    })

    child.on('close', (status: number | null, signal: NodeJS.Signals | null) => {
      if (aborted) {
        const exited = signal === null ? String(status) : `signal ${signal}`
        process.stderr.write(
          `${RED}gate "${gate.name}": the tool ABORTED — whatever it held was not checked, whatever it exited with (${exited}).${RESET}\n`
        )
        settle(1)
        return
      }
      settle(status ?? 1)
    })
  })
}

/**
 * Run only when EXECUTED, never when imported. `reportsWorkerAbort` is exported so its matcher can
 * be tested, and a test that imported this file would otherwise run every gate — including the
 * test suite itself — from inside the test run.
 */
async function main(): Promise<void> {
  process.stdout.write(`${DIM}gate: running via ${PACKAGE_MANAGER}${RESET}\n`)

  let failedGate: string | undefined
  for (const gate of GATES) {
    if ((await runGate(gate)) !== 0) {
      failedGate = gate.name
      break
    }
  }

  if (failedGate !== undefined) {
    process.stdout.write(`\n${RED}✗ gate "${failedGate}" failed.${RESET}\n`)
    // ⚠ `exitCode`, NEVER `process.exit`. When either stream is a pipe — CI, a file, `$(…)` — a
    // write is queued, not performed, and `process.exit` drops whatever is still queued. A gate
    // that printed megabytes before dying leaves enough backlog that the ABORTED line, written
    // microseconds earlier, never reaches the reader (measured upstream: 12 of 12 runs lost it).
    // Setting the code and returning lets the runtime drain first.
    process.exitCode = 1
    return
  }

  process.stdout.write(`\n${GREEN}✓ All gates passed.${RESET}\n`)
}

if (import.meta.main) await main()
