/**
 * The range `.github/workflows/secret-scan.yml` hands gitleaks is the coverage of the only gate that
 * stops a committed secret, so it is run here rather than read. Ported from zen-harness-foundation.
 *
 * A secret's remedy is rotation — rewriting history does not un-leak it. The range is one string in
 * one shell line, and the two ways to get it wrong are invisible in review:
 *
 *   1. `--no-merges` skips merge commits. A merge's conflict resolution is content that exists in
 *      NEITHER parent, so a secret written while resolving `Merge branch 'dev' into …` lands unscanned.
 *   2. `--first-parent` looks like the fix and is a regression: it limits TRAVERSAL, dropping every
 *      commit reached through a second parent, so a secret committed on a side branch and removed
 *      while resolving is walked by nothing. `--diff-merges=first-parent` changes only what a merge
 *      DISPLAYS.
 *
 * Both cases run the real `git log -p -U0` that gitleaks runs over a fixture repository, with the
 * flags read out of the workflow. gitleaks is not installed here; what is asserted is the CONTENT the
 * scanner is handed, which is the half a flag can silently lose. Then the resolver script the workflow
 * calls is run against fixture branches.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, expect, test } from 'vite-plus/test'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WORKFLOW = '.github/workflows/secret-scan.yml'
const RANGE_SCRIPT = '.github/scripts/secret-scan-range.sh'
const RANGE_UNAVAILABLE_EXIT = 2
const SHA_LENGTH = 40

/** The `--log-opts` flags the workflow passes, with its `${RANGE}` (the resolver's output) removed. */
function walkFlagsOfWorkflow(): string[] {
  const workflow = readFileSync(join(REPOSITORY_ROOT, WORKFLOW), 'utf8')
  const logOpts = /--log-opts="([^"]*)"/.exec(workflow)?.[1]
  if (logOpts === undefined) {
    throw new Error(`${WORKFLOW}: no --log-opts to read the walked range from`)
  }
  // oxlint-disable-next-line no-template-curly-in-string -- the workflow's shell variable, not a JS template
  expect(logOpts).toContain('${RANGE}')
  expect(workflow).toContain('RANGE=$(.github/scripts/secret-scan-range.sh)')
  return logOpts.split(/\s+/).filter((flag) => flag.startsWith('-'))
}

/** An absolute path for a binary, so a child can run with an environment that holds no `PATH`. */
function locate(binary: string): string {
  const found = spawnSync('sh', ['-c', `command -v ${binary}`], { encoding: 'utf8' }).stdout.trim()
  return found === '' ? binary : found
}

const GIT = locate('git')
const BASH = locate('bash')

/**
 * The fixture's git environment, fixed rather than inherited. ⚠ EVERY ambient git variable has to go:
 * this suite runs inside the gate, which runs inside the pre-commit hook, where `GIT_DIR`,
 * `GIT_WORK_TREE` and `GIT_INDEX_FILE` point at the COMMIT BEING MADE — a `git add` in a fixture
 * would stage a fixture file into the real commit (observed upstream). So the identity and config
 * are named here, and nothing else reaches the child.
 */
const FIXTURE_GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'secret scan fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'secret scan fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
}

function git(root: string, ...args: string[]): string {
  const run = spawnSync(GIT, args, { cwd: root, env: FIXTURE_GIT_ENV, encoding: 'utf8' })
  return `${run.stdout}${run.stderr}`
}

/** Every fixture repository this file made, removed together: each one is a real `git init`. */
const fixtureRoots: string[] = []
afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true })
})

function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-proxy-secret-scan-'))
  fixtureRoots.push(root)
  return root
}

/**
 * AWS's own canonical example access key, allowlisted by the workflow's baseline and reserved by AWS
 * so it can never be real. These tests do not run gitleaks — they assert that `git log -p` HANDS it
 * this line — so the marker only has to be distinctive, and this one cannot trip this repository's
 * own scan.
 */
const MARKER = 'AKIAIOSFODNN7EXAMPLE'

/**
 * A repository shaped like a pull-request branch that merged another branch. `resolution` decides
 * where the marker is: written while resolving the conflict (in neither parent), or committed on the
 * side branch and dropped by the resolution (in the second parent only).
 */
function mergeFixture(resolution: 'writes-the-marker' | 'drops-the-marker'): {
  root: string
  range: string
} {
  const root = fixtureRepository()
  git(root, 'init', '-q', '-b', 'main', '.')
  writeFileSync(join(root, 'config.txt'), 'shared = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'base')
  const base = git(root, 'rev-parse', 'HEAD').trim()

  git(root, 'switch', '-qc', 'side')
  writeFileSync(
    join(root, 'config.txt'),
    resolution === 'drops-the-marker' ? `key = ${MARKER}\n` : 'shared = 2\n'
  )
  git(root, 'commit', '-qam', 'the side branch edits config')
  git(root, 'switch', '-q', 'main')
  git(root, 'switch', '-qc', 'feature')
  writeFileSync(join(root, 'config.txt'), 'shared = 3\n')
  git(root, 'commit', '-qam', 'the branch edits config')
  git(root, 'merge', 'side') // conflicts on purpose: a resolution is a commit of its own
  writeFileSync(
    join(root, 'config.txt'),
    resolution === 'writes-the-marker' ? `key = ${MARKER}\n` : 'shared = 4\n'
  )
  git(root, 'add', 'config.txt')
  git(root, 'commit', '-qm', "Merge branch 'side' into feature")
  return { root, range: `${base}..${git(root, 'rev-parse', 'HEAD').trim()}` }
}

test('⚠ the secret gate walks a secret written while RESOLVING a merge', () => {
  const { root, range } = mergeFixture('writes-the-marker')
  const walked = git(root, 'log', '-p', '-U0', ...walkFlagsOfWorkflow(), range)
  // `--no-merges` hands gitleaks a patch without this line.
  expect(walked).toContain(MARKER)
})

test('⚠ the secret gate still walks a secret a merge resolution REMOVED', () => {
  const { root, range } = mergeFixture('drops-the-marker')
  const walked = git(root, 'log', '-p', '-U0', ...walkFlagsOfWorkflow(), range)
  // `--first-parent` would drop the side commit from the traversal, and the merge's own diff does not
  // carry a line the resolution deleted: the secret would be scanned by nothing.
  expect(walked).toContain(MARKER)
})

/**
 * THE RANGE A PUSH RESOLVES TO. `github.event.before` is forty zeroes on a branch's first push and
 * unreachable after a force-push; a fallback to the head's first parent would scan ONE commit of a
 * branch that may carry many.
 */
const NO_BEFORE = '0'.repeat(SHA_LENGTH)

/** The resolver, with the event's values in its environment; `[exit code, stdout]`. */
function resolveRange(root: string, event: Record<string, string>): [number | null, string] {
  const run = spawnSync(BASH, [join(REPOSITORY_ROOT, RANGE_SCRIPT)], {
    cwd: root,
    // Only git's and bash's directories: the script needs those two and nothing else.
    env: {
      PATH: `${dirname(GIT)}:${dirname(BASH)}`,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      ...event
    },
    encoding: 'utf8'
  })
  return [run.status, run.stdout.trim()]
}

/** `main` with two commits (the second is `origin/main` too), `feature` two commits past it. */
function branchFixture(): { root: string; mainTip: string; firstFeature: string; feature: string } {
  const root = fixtureRepository()
  git(root, 'init', '-q', '-b', 'main', '.')
  writeFileSync(join(root, 'a.txt'), '1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'one')
  writeFileSync(join(root, 'a.txt'), '2\n')
  git(root, 'commit', '-qam', 'two')
  const mainTip = git(root, 'rev-parse', 'HEAD').trim()
  git(root, 'update-ref', 'refs/remotes/origin/main', mainTip)
  git(root, 'switch', '-qc', 'feature')
  writeFileSync(join(root, 'a.txt'), '3\n')
  git(root, 'commit', '-qam', 'three')
  const firstFeature = git(root, 'rev-parse', 'HEAD').trim()
  writeFileSync(join(root, 'a.txt'), '4\n')
  git(root, 'commit', '-qam', 'four')
  return { root, mainTip, firstFeature, feature: git(root, 'rev-parse', 'HEAD').trim() }
}

test("⚠ a branch's first push scans every commit since it left the default branch, not only the tip", () => {
  const { root, mainTip, firstFeature, feature } = branchFixture()
  const event = { HEAD_SHA: feature, REF_NAME: 'feature', DEFAULT_BRANCH: 'main' }
  // No usable `before`: the merge-base with origin/main, so both commits are in the range.
  expect(resolveRange(root, { ...event, BASE_SHA: NO_BEFORE })).toEqual([
    0,
    `${mainTip}..${feature}`
  ])
  // A `before` that exists is used as it is — the branch's second push scans only what it added.
  expect(resolveRange(root, { ...event, BASE_SHA: firstFeature })).toEqual([
    0,
    `${firstFeature}..${feature}`
  ])
})

test('on the default branch with no usable before, the first parent; with no SHAs at all, no range and exit 2', () => {
  const { root, mainTip } = branchFixture()
  const parent = git(root, 'rev-parse', `${mainTip}^`).trim()
  const onMain = { HEAD_SHA: mainTip, REF_NAME: 'main', DEFAULT_BRANCH: 'main' }
  expect(resolveRange(root, { ...onMain, BASE_SHA: NO_BEFORE })).toEqual([
    0,
    `${parent}..${mainTip}`
  ])
  expect(resolveRange(root, { ...onMain, BASE_SHA: '' })).toEqual([RANGE_UNAVAILABLE_EXIT, ''])
})
