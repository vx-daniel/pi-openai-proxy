/**
 * The gate (scripts/gate.ts), ported with it from zen-harness-foundation.
 *
 * Its blind spot, closed: a tool that dies mid-run and still exits 0. Upstream measured Biome
 * overflowing a worker's stack, printing `fatal runtime error: stack overflow, aborting`, and
 * exiting 0, so the files that worker held went unchecked under a green gate. Every other gate
 * failure announces itself in the exit code; this one does not, so it is the one worth a test.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeEach, expect, test, vi } from 'vite-plus/test'

import { GATES, reportsWorkerAbort } from '../../scripts/gate'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const GATE_SCRIPT = join(REPOSITORY_ROOT, 'scripts', 'gate.ts')
/** Every fixture spawns node and runs each gate through npm; the megabytes case also pipes 2 MB. */
const END_TO_END_TIMEOUT_MS = 30_000
const SPAWN_BUFFER_BYTES = 64 * 1024 * 1024
const FIXTURE_LINE_COUNT = 300

test('⚠ a tool that aborts a worker is a failure whatever it exited with', () => {
  // The verbatim banner Biome 2.5.13 printed, and the other runtimes' equivalents.
  expect(
    reportsWorkerAbort("thread 'biome::workspace_worker_4' (3220082) has overflowed its stack")
  ).toBe(true)
  expect(reportsWorkerAbort('fatal runtime error: stack overflow, aborting')).toBe(true)
  expect(reportsWorkerAbort("thread 'main' panicked at src/lib.rs:42:9:")).toBe(true)
  expect(reportsWorkerAbort('Segmentation fault (core dumped)')).toBe(true)
})

test('ordinary stderr is not an abort — diagnostics, warnings and an empty stream all pass', () => {
  expect(reportsWorkerAbort('')).toBe(false)
  expect(reportsWorkerAbort('Found 214 warnings.\nChecked 185 files in 1301ms.')).toBe(false)
  expect(reportsWorkerAbort('error: script "lint" exited with code 1')).toBe(false)
  // A test NAMING the banner (this file does) is prose in someone's output, not an abort of the
  // tool that printed it — the scan reads the running tool's stderr, nothing else.
  expect(reportsWorkerAbort('the message says stack overflow when it aborts')).toBe(false)
})

/**
 * The header of `scripts/gate.ts` is the documented authority for what "green" means. Upstream it
 * drifted to name three checks where the file ran five, with the wrong commands, and nothing exited
 * non-zero. It pins the row STRUCTURE, never the prose: the ordered names and the first backticked
 * command on each row, against GATES and the package.json scripts they run.
 */
const HEADER_GATE_ROW = /^\s*\*\s+\d+\.\s+(\S+)\s+—\s+`([^`]+)`/

function isScriptTable(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((command) => typeof command === 'string')
  )
}

test('⚠ the header of scripts/gate.ts names the gates the file actually runs, with their real commands', () => {
  const rows = readFileSync(GATE_SCRIPT, 'utf8')
    .split('\n')
    .map((line) => HEADER_GATE_ROW.exec(line))
    .filter((match) => match !== null)
    .map((match) => ({ name: match[1] ?? '', command: match[2] ?? '' }))
  const manifest: unknown = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  const scripts =
    typeof manifest === 'object' && manifest !== null && 'scripts' in manifest
      ? manifest.scripts
      : undefined
  if (!isScriptTable(scripts)) throw new Error('package.json has no scripts table')
  expect(rows).toEqual(
    GATES.map((gate) => ({ name: gate.name, command: scripts[gate.script] ?? '' }))
  )
})

/** Every scratch package this file made, removed together. */
const scratchRoots: string[] = []
afterAll(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true })
})

// The gate picks its package manager from `npm_config_user_agent`. A test run started by
// `pnpm run` would hand the fixture pnpm; npm is pinned so every run takes the same path.
beforeEach(() => {
  vi.stubEnv('npm_config_user_agent', 'npm/0 test-fixture')
  return () => vi.unstubAllEnvs()
})

interface GateRun {
  status: number | null
  stdout: string
  stderr: string
  output: string
}

/**
 * Builds a throwaway package whose `lint` gate runs `body`, then runs the real `scripts/gate.ts`
 * against it. ⚠ The scripts are DERIVED FROM `GATES`, never listed: a hand-written set stops
 * matching the day a gate is added, and the fixture then fails on the missing script rather than on
 * the crash it exists to reproduce. Every gate is a no-op here except `lint`.
 */
function runGateOver(body: string): GateRun {
  const scratch = mkdtempSync(join(tmpdir(), 'pi-proxy-gate-'))
  scratchRoots.push(scratch)
  writeFileSync(join(scratch, 'crash.sh'), `#!/bin/sh\n${body}`, { mode: 0o755 })
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({
      name: 'gate-abort-fixture',
      private: true,
      scripts: {
        ...Object.fromEntries(GATES.map((gate) => [gate.script, 'true'])),
        lint: './crash.sh'
      }
    })
  )
  const run = spawnSync('node', [GATE_SCRIPT], {
    cwd: scratch,
    encoding: 'utf8',
    maxBuffer: SPAWN_BUFFER_BYTES
  })
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    output: `${run.stdout}${run.stderr}`
  }
}

test(
  '⚠ end to end: a gate script that prints the banner and exits 0 still fails the run',
  () => {
    // Exits 0 on purpose — that is the whole point.
    const run = runGateOver(
      'echo "thread \'biome::workspace_worker_0\' has overflowed its stack" >&2\necho "fatal runtime error: stack overflow, aborting" >&2\nexit 0\n'
    )
    expect(run.status).toBe(1)
    expect(run.output).toContain('ABORTED')
    // …and it stops there rather than running the gates behind it on a broken tree.
    expect(run.output).not.toContain('All gates passed')
  },
  END_TO_END_TIMEOUT_MS
)

/**
 * A tool that says a lot before it dies is still a tool that died: stderr is scanned as it passes,
 * never accumulated. And the verdict has to survive the exit — upstream, `process.exit(1)` dropped
 * the queued ABORTED and failure lines behind 2 MB of backlog in 12 of 12 runs; the gate now sets
 * `exitCode` and returns. The last assertion fails if that regresses.
 */
test(
  '⚠ megabytes of stderr before the banner does not hide the abort',
  () => {
    const run = runGateOver(
      "head -c 2000000 /dev/zero | tr '\\0' 'x' >&2\necho >&2\necho 'fatal runtime error: stack overflow, aborting' >&2\nexit 0\n"
    )
    expect(run.status).toBe(1)
    expect(run.output).toContain('ABORTED')
    expect(run.output).not.toContain('failed to spawn')
    expect(run.output).toContain('✗ gate "lint" failed.')
  },
  END_TO_END_TIMEOUT_MS
)

/**
 * Both streams are piped, so the gate is the only writer to the terminal. Every line the tool wrote
 * must arrive whole and on the stream it was written to. (Ordering ACROSS the two streams is grouped
 * in chunks, not exact; that is the price of reading either of them.)
 */
test(
  '⚠ a tool writing both streams has every line arrive whole, on the stream it came from',
  () => {
    const run = runGateOver(
      `n=0\nwhile [ $n -lt ${FIXTURE_LINE_COUNT} ]; do\n  echo "out $n"\n  echo "err $n" >&2\n  n=$((n+1))\ndone\n`
    )
    expect(run.status).toBe(0)
    const tagged = (stream: string, tag: string): string[] =>
      stream.split('\n').filter((line) => line.startsWith(tag))
    const expected = (tag: string): string[] =>
      Array.from({ length: FIXTURE_LINE_COUNT }, (_, lineNumber) => `${tag}${lineNumber}`)
    expect(tagged(run.stdout, 'out ')).toEqual(expected('out '))
    expect(tagged(run.stderr, 'err ')).toEqual(expected('err '))
  },
  END_TO_END_TIMEOUT_MS
)

/** stdout is forwarded but never scanned: a linter quoting source must not read as its own death. */
test(
  '⚠ a banner quoted on stdout is a tool reporting, not a tool dying',
  () => {
    const run = runGateOver(
      'echo "fatal runtime error: stack overflow, aborting"\necho "  > 42 | Segmentation fault"\n'
    )
    expect(run.status).toBe(0)
    expect(run.output).toContain('All gates passed')
    expect(run.output).not.toContain('ABORTED')
  },
  END_TO_END_TIMEOUT_MS
)
