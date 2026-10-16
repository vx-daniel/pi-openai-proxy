# Test-Quality Audit — `test/` (pi-openai-proxy)

## Context

**Audit target.** All 35 test files under `test/`, audited read-only on branch `dev` with a clean tree.
- Framework: Vitest through Vite+. Tests import from `vite-plus/test`, and the config is the `test` block in `vite.config.ts`. I read `references/vitest-patterns.md`.
- The gate is `pnpm run check:all`, which runs `scripts/gate.ts`. Its test step is `test:ci` = `vp test test/unit test/integration` (`package.json:60`).
- CI (`.github/workflows/ci.yml:36-48`) passes **no provider credentials** to the gate.

**What the code under test does.** It is an OpenAI-compatible HTTP proxy.

**Dominant risk shapes, judged per region:**
- **Structural transformer (stable public contract):**
  - OpenAI request → pi context and payload.
  - pi messages and events → `chat.completion` JSON and `chat.completion.chunk` SSE.
- **External-service boundary:** pi's model registry and auth.
- **Security/policy surface:**
  - Remote-image blocking.
  - Credentials kept out of responses and logs.
  - Health endpoint auth split.
- **Pure logic plus repo tooling:** config, logging, Zed sync, gate, lint rules.

**Tier 1 pre-screen** (`test_prescreen test`): 54 findings across 35 files, **1 HIGH, 0 MEDIUM, 53 LOW**.
- The single HIGH (`swallowed-errors`, `test/unit/lint-naming.test.ts:39`) is a false positive. The line is a RuleTester `code:` string (`'try { run() } catch (er) {}'`), not a catch block in a test body.
- The 53 LOW are `toBeDefined()` calls. Most narrow a value before a specific `toBe` (see "Not flagging").
- Evasion is **not** the dominant failure mode here. The dominant failure mode is **tests that run no assertions in the CI configuration** and **missing canonical-shape locks**.

**Recent-commit lens (Step 2.5).** These commits served as precedents:
- `7ab6e143`: tool-result `toolName` resolved from assistant tool_calls.
- `1d1610bf` and `7e03c463`: the token endpoint's response leaked into verify errors; a throwing check now answers 503.
- `3c3ac919`: raw upstream and fs error text kept at debug.
- `0e0eaed4`: an SSE usage test checked only `typeof`, which hid a bug.
- `49b68d1e`, `12b6b74c`, `01dc51a1`: the upstream idle timeout.
- `1cc10264`: removed the dependence on the user's real config.

**Readers.** I dispatched three readers, one per region. I reviewed region 4 (conformance) myself and did not dispatch a reader for it. I spot-checked every S1 at file:line before ranking it.

## Verdict by region

| Region | Verdict | Headline risk |
|---|---|---|
| 1. Translation layer: `test/unit/` messages, tools, json-schema-to-typebox, responses, response-conformance, sse, sse-conformance, payload-passthrough×3, validate, errors, complete, upstream-idle (14 files) | **Mixed** | The `7ab6e143` regression (tool name) is unguarded. No full-shape lock on `chat.completion`, chunks or tool schemas. `complete.test.ts` tests nothing in `complete.ts`. The upstream-idle, sse-log and passthrough tests are strong. |
| 2. HTTP, exposure and security: `test/integration/*` (6) plus `test/unit/` model-exposure, registry, security, auth-error-summary (10 files) | **Weak in CI** | Credential-gated `if (…) return` guards mean the security and model-detail tests assert nothing in the gate. The registry auth-error path next to `1d1610bf` is unguarded. The health and timeout tests are strong. |
| 3. Config, logging, tooling, sync: `test/unit/` config-schema, log-level-config, logging, gate, lint-naming, secret-scan, zed-sync (7 files) | **Solid, with gaps** | Redaction covers 2 of 9 field names. The `3c3ac919` Zed error-code logging is untested. The `upstreamTimeoutSec` bounds are untested. |
| 4. Conformance: `test/conformance/*` (4 files) | **Not audited in depth** | These are live-provider SDK end-to-end tests, outside the gate. Shape checks are `typeof`-level (for example `sdk-chat.test.ts:37-40`), but this layer's lens is "does the SDK parse it". |

## Findings, ranked by severity

### S1-1 — In CI, the security and model-detail tests return before asserting anything

**Files:**
- `test/unit/security.test.ts:44,58,72,86,100,115,129`: every test starts with `if (modelId === undefined) return`. `modelId` comes from `getAvailableModels()` on the user's real pi agent dir (`:17-25`).
- `test/integration/models.test.ts:41,46,49,70,75,78,96,99,116,119`, plus `:31`, a `slice(0,1)` loop that runs zero times on an empty list.
- `test/integration/model-exposure.test.ts:30,49,59,84,103,121,147,150,179,205,208,217,220`.
- `test/integration/chat-validation.test.ts:85,88` and `test/integration/chat-request-log.test.ts:62`.

```ts
test('rejects oversized base64 payload', async () => {
  if (modelId === undefined) return
```

**Why S1.**
- The gate runs these suites, and CI supplies no credentials or agent dir (`ci.yml:36-48`). Every guarded test passes green with zero assertions.
- `vitest/expect-expect` is satisfied statically, so the lint rule does not catch it.

**What becomes unguarded in CI:**
- The HTTP 400 path for remote, localhost and private-range image URLs.
- The **20 MB image size limit**. "exceeds maximum size" is asserted only at `security.test.ts:111`, nowhere else in `test/`.
- The success path of `GET /v1/models/{url-encoded id}`, an AGENTS.md hard constraint (`models.test.ts:51,80,101`). Only the 404 at `:133` runs unconditionally.
- Exposure-mode filtering through HTTP.

**Partial cover:** `messages.test.ts:84-98` still checks remote-URL rejection at unit level.

**The fix pattern already exists in the suite.** `health.test.ts:22-31` and `upstream-timeout.test.ts:91` point `PI_CODING_AGENT_DIR` at a throwaway dir with a `models.json` provider. That makes the tests deterministic and credential-free.

**Fix direction (follow-up issue):** Move these files onto a fixture agent dir with a literal-key `models.json` provider, as `health.test.ts` does. Then replace each `if (x === undefined) return` with an assertion that `x` exists, so a missing fixture fails loudly. For the conformance layer, the early return is acceptable because it is documented and outside the gate.

### S1-2 — The `7ab6e143` regression (empty tool name on tool results) is unguarded

**Files:** `test/unit/messages.test.ts:58-79`.

```ts
const toolResult = result.context.messages[2]
expect(toolResult?.role).toBe('toolResult')
```

**Why S1.**
- Commit `7ab6e143` fixed Gemini rejecting tool results with `function_response.name: REQUIRED_FIELD_MISSING`, by building `collectToolCallNames` (`src/openai/messages.ts:116-126`).
- The test feeds exactly the right fixture (`tc_1` → `get_weather`) but asserts only `role`.
- `toolName` appears **nowhere** under `test/`. If `src/openai/messages.ts:85` sent `toolName ?? ''` with an always-empty map, the commit's precedent would ship again silently.
- The same test also misses `toolCallId` and `content`.
- The assistant-history test (`:43-55`) never checks that `tool_calls` become `toolCall` parts with parsed `arguments`.

**Fix direction:** Lock the converted tool-result message with `toEqual`, using `expect.any(Number)` for the timestamp, so `toolName: 'get_weather'` is asserted. Add the unknown-`tool_call_id` fallback case. Lock the assistant `toolCall` part, including the invalid-JSON arguments fallback.

### S1-3 — The raw `getAuth` error can reach the 401 body, and no test guards it (`1d1610bf` class)

**Files:**
- `src/pi/registry.ts:99-107`: the catch returns `{ ok: false, error: message }` with the raw message.
- `src/server/routes.ts:254-270`: interpolates `requestAuth.error` into the HTTP 401 body.
- `test/unit/registry.test.ts:30-35`: tests only the `credentials === undefined` branch.

**Why S1.**
- `1d1610bf` and `7e03c463` showed that pi's credential errors carry `body=…; details=…; stack=…`, which quote the token endpoint's response. They added `summarizeAuthError` (`registry.ts:163`) for `/healthz/creds`.
- The chat-completions pre-check uses the same `getAuth` call, and its error is not summarized.
- There is no test for a throwing credential on `POST /v1/chat/completions`.
- `health.test.ts:166-195` already builds such a credential (`apiKey: '!exit 3'`) and could be reused.

This is direct precedent, one call site over. Whether it is a live leak is a source question (see out-of-scope notes). The missing guard is the finding.

**Fix direction:** Add an integration test that sends a chat request for a provider whose models.json credential throws. Assert a 401, and assert the body contains none of the error's `body=` or `stack=` content.

### S2-1 — Public output shapes have no canonical `toEqual` lock

Per `assertion-shape.md`: "at least one test must `toEqual` the full canonical output for a representative input."

**Instances:**
- **`chat.completion`:** `test/unit/response-conformance.test.ts:76-87`. No test asserts `x_pi` (`src/openai/responses.ts:166`), `system_fingerprint` or the whole object. Dropping `x_pi` or moving it to the top level would pass. That would violate the AGENTS.md rule to namespace pi metadata under `x_pi`.
- **Tool-call SSE deltas:** `test/unit/sse-conformance.test.ts:391,394` check `index` and `arguments` only with `toBeTypeOf`. This is the same shape as the `0e0eaed4` precedent ("only asserted that prompt_tokens was a number"). An off-by-one tool index or empty argument deltas would pass. No test streams two tool calls. Text deltas are also only type-checked (`:182`).
- **Tool parameters:** `test/unit/tools.test.ts:38,58` check only `type === 'object'`. A converter that ignored `parameters` and emitted `Type.Object({})` would pass. `test/unit/json-schema-to-typebox.test.ts:82-92` (optional handling) is decorative, and `:158,185` check `anyOf` only for existence.
- **Passthrough payload:** `test/unit/payload-passthrough.test.ts:91-106` uses no whole-result `toEqual`, so an extra forwarded field would pass. The codex exclusion at `:125-128` is good.
- **Health bodies:** `test/integration/health.test.ts:89,108,126` and **JSONL log records** at `test/unit/logging.test.ts:36` use `toMatchObject`. Both are surfaces where an *extra* field is the leak risk.

**Fix direction:** One `toEqual` (or inline snapshot) lock per surface: completion, final chunk, a tool-call delta sequence with two calls, a converted tool schema, and a passthrough payload per API family.

### S2-2 — `complete.test.ts` tests nothing in `src/pi/complete.ts`

**Files:** `test/unit/complete.test.ts:8`. It imports only `mapFinishReason` and `mapUsage` from `@proxy/openai/responses`, and its header (`:1-13`) admits it.

**Untested as a result:**
- `REASONING_EFFORT_MAP`.
- Temperature dropping for codex.
- `abortCause`.
- The non-streaming upstream-error logging. `sse.test.ts:131-142` pins the streaming half of `3c3ac919`; the `complete.ts` half has no counterpart.

**Fix direction:** Either rename and merge the file into `responses.test.ts`, or give `complete.ts` real tests: the effort map, codex parameter filtering, and debug-only raw error text on the non-streaming path.

### S2-3 — `mapUpstreamError` tests check status only, never the body

**Files:** `test/unit/errors.test.ts:31-58`.
- `src/server/errors.ts:74-76` promises "Never leaks secrets." No test checks that `body.error.message` is the fixed text and not `err.message`.
- Only `ETIMEDOUT` is tested. Removing `message.includes('timeout')` (`errors.ts:86`) passes.

**Fix direction:** `toEqual` on `{ status, body }` for each branch, with an input message containing a fake secret that must not appear.

### S2-4 — Health detail endpoints: the error paths are half covered

**Covered:** `test/integration/health.test.ts:115-127` covers models-check-throws → 503.

**Not covered:**
- `/healthz/creds` throwing → 503 (`src/server/health.ts:105-111`, from `7e03c463`).
- `modelsJsonError` is returned raw in the HTTP body (`health.ts:63`). The test checks only `null` (`:94`). No broken-`models.json` case shows that a literal key in the file is not echoed.

**Fix direction:** Add both cases, reusing the `loadAgentDir` fixture.

### S2-5 — Logging policy: most of the redaction list and two log-leak paths are unguarded

**Redaction coverage:**
- `test/unit/logging.test.ts:85-97` exercises 2 of 9 names in `REDACTED_FIELDS` (`src/logging/index.ts:64-74`).
- Removing `authorization`, `apiKey` or `proxyAuthToken` would pass. The file-sink redaction path is untested.

**`3c3ac919` Zed precedent:** Zed sync logs `errorCode(error)` and not the fs message. `test/unit/zed-sync.test.ts` has no read or write failure test (`src/sync/zed.ts:260-283`), so a revert to the message would pass.

**Chat-request log:**
- `test/integration/chat-request-log.test.ts` greps for the prompt and tokens (`:89,170-171`, good).
- It never sends `X-Pi-Upstream-Api-Key` and checks the log for it.
- That test is also credential-gated (`:62`, part of S1-1).

### S2-6 — Config and sync edge cases from recent changes

- **Config bounds:** `upstreamTimeoutSec` (changed in `49b68d1e`) and `maxBodySizeMb` bounds are untested. `test/unit/config-schema.test.ts:162` passes only an in-range 300, so dropping the clamp passes.
- **Malformed JSONC:** the header of `test/unit/zed-sync.test.ts:10` promises a "malformed JSONC" edge case, but no test has one. This code writes the user's real settings file.

### S2-7 — Tautological exposure-mode tests

**Files:** `test/integration/model-exposure.test.ts`:
- `:61-70`: asserts only `toBeTypeOf('string')` on IDs, and only when there are no collisions.
- `:96`: count only.
- `:119`: scoped vs all, equal by construction because `testApp` always passes `enabledModels: undefined` (`test/helpers.ts:115`).

The unit file `test/unit/model-exposure.test.ts` covers the logic properly. These HTTP versions add little beyond S1-1.

### S3 — Smells worth tracking (grouped)

- `test/unit/tools.test.ts:82,146,170`: count- or `ok`-only assertions.
- `test/unit/payload-passthrough-tool-strict.test.ts:127-131`: `not.toThrow` is the only assertion.
- `test/unit/payload-passthrough-providers.test.ts`: Google named `tool_choice` → ANY is untested. The skip tests at `:45-77` send one field each.
- `test/unit/validate.test.ts:101`: the unknown-field test does not check `param`.
- `test/unit/auth-error-summary.test.ts`: no input exercises `response=` or a `[` literal in `AUTH_ERROR_DETAIL` (`src/pi/registry.ts:161`).
- `test/unit/model-exposure.test.ts:227-240`: `toContain` with no length check passes if both prefixed and unprefixed IDs are emitted.
- `test/integration/chat-validation.test.ts:57,294`: these get a 404 before the named feature runs, so they are decorative. `:262` checks only `not.toBe(413)`.
- `test/unit/config-schema.test.ts:13`: expected value is the code's own `DEFAULT_CONFIG` (tautological). `:155-166` checks field by field.
- `test/unit/zed-sync.test.ts:271-273,407-408`: written file checked with `toContain`, not parsed.
- `test/unit/gate.test.ts`: stderr chunk-boundary `carry` (`scripts/gate.ts:208-210`) untested.
- `test/unit/lint-naming.test.ts`: the `AccessorProperty` and `TSMethodSignature` visitors (`lint/naming.ts:101-109`) have no cases.
- `test/unit/registry.test.ts:10` and the files in S1-1 call `initRegistry()` against the user's real pi agent dir. This is the `1cc10264` determinism class.

## What I'm explicitly **not** flagging

- **The single Tier 1 HIGH** (`lint-naming.test.ts:39`): a RuleTester code fixture, not a swallowed catch.
- **Most of the 53 LOW `toBeDefined()` hits.** Most narrow a value for `noUncheckedIndexedAccess` and are followed by a specific `toBe`/`toEqual`. Examples: `sse-conformance.test.ts:357-372` ends in `toBe('call_abc')` and `toBe('get_weather')`; `model-exposure.test.ts:399-421` is followed by provider checks. Only those cited in S2-1 are load-bearing.
- **`test/conformance/*` early returns on missing credentials.** They are documented ("Skips when no credentials are available", `sdk-chat.test.ts:6`) and excluded from the gate (`test:ci`). Their `typeof`-level checks fit an "SDK parses it" lens.
- **Real timers in `test/integration/upstream-timeout.test.ts`.** This is documented (15 × 100 ms chunks against a 1 s idle timeout). It guards `49b68d1e` at `:119`. `test/unit/upstream-idle.test.ts` covers the same logic with fake timers (`:95-108`, `:142-151`, `:163-176` pin all three timeout precedents).
- **Mock anti-patterns: none found.**
  - There is no `vi.mock` or `vi.fn` in the suite.
  - The only test doubles are `vi.stubEnv` and models.json fake providers on `127.0.0.1:9`. That is the minimal-mock pattern the checklist recommends.
  - No `restoreMocks` config is needed for that shape. `vi.unstubAllEnvs()` is called in `afterAll`, for example in `health.test.ts:52`.
- **`secret-scan.test.ts` and `gate.test.ts`.** They run real `git` and the real gate script against throwaway dirs. These are strong tests and I have nothing to flag.
- **The sse log-level tests** (`sse.test.ts:131-142`) guard `3c3ac919` on the streaming path at both info and debug.

## Recommended follow-ups (file as separate issues)

1. **(S1-1)** Put `security.test.ts`, `models.test.ts`, `model-exposure.test.ts` (integration), `chat-validation.test.ts` and `chat-request-log.test.ts` on a fixture agent dir. Replace each early return with an assertion that the value exists. Verify the gate's assertion count rises.
2. **(S1-2)** Lock the tool-result and assistant-tool-call conversion in `messages.test.ts` with `toEqual`, including `toolName`.
3. **(S1-3)** Add a chat-completions test with a throwing credential that asserts no upstream body or stack in the 401. Decide whether `routes.ts` should use `summarizeAuthError` (source change, owner sign-off).
4. **(S2-1)** Add canonical-shape locks for completion, final chunk, a two-tool-call SSE sequence, the tool schema and the passthrough payloads.
5. **(S2-2, S2-3)** Give `complete.ts` real tests. Assert `mapUpstreamError` bodies and the `timeout` branch.
6. **(S2-4, S2-5)** Health creds-throws → 503; a `modelsJsonError` echo case; parameterize redaction over all 9 names; Zed fs-failure logging; the upstream-key header kept out of the chat log.
7. **(S2-6, S2-7)** Config bound clamps; a malformed-JSONC Zed case; prune or strengthen the tautological HTTP exposure tests.
8. **(S3)** Batch the S3 list into one cleanup issue.

## Verification

- For each S-level finding, open the cited file:line and confirm the quoted assertion or guard matches.
- **Baseline:** run `pnpm run check:all` (or `vp run test:ci`) once to confirm the suite passes.
- **S1-1:** run `vp run test:ci` with `PI_CODING_AGENT_DIR` pointed at an empty temp dir and provider env vars unset. It should still pass, which demonstrates the vacuity. Compare the assertion counts with a credentialed run.
- **S1-2:** temporarily change `src/openai/messages.ts:85` to pass `''`. `messages.test.ts` should still pass.
- **Scoping:** before filing each issue, grep to confirm the scope (for example `rg "=== undefined\) return" test/unit test/integration`).

This audit ran no tests and changed no files.

## Out-of-scope notes (source, not tests)

- `src/pi/registry.ts:106` → `src/server/routes.ts:266`: the raw credential error is interpolated into the 401 body without `summarizeAuthError`. Possibly a live leak; needs a source fix decision.
- `src/config/schema.ts:195`: an invalid `logLevel` in the config file falls back silently with no log. That may conflict with AGENTS.md "Reject unsupported parameters clearly", although that rule is about the API. Locked by `test/unit/log-level-config.test.ts:68`.
- `src/server/errors.ts:79-108`: upstream errors are classified by substring heuristics (`'rate'` && `'limit'`, `'401'`). That is fragile, but it is a design concern.

## Critical files referenced

- test/unit/security.test.ts:17-25,44,58,72,86,100,111,115,129
- test/integration/models.test.ts:31,41,46,49,51,70,75,78,80,96,99,101,116,119,133
- test/integration/model-exposure.test.ts:30,49,59,61-70,84,96,103,119,121,147,150,179,205,208,217,220
- test/integration/chat-validation.test.ts:57,85,88,262,294
- test/integration/chat-request-log.test.ts:62,89,170-171
- test/integration/health.test.ts:22-31,52,89,94,108,115-127,166-195
- test/integration/upstream-timeout.test.ts:91,119
- test/unit/messages.test.ts:43-55,58-79,84-98
- test/unit/registry.test.ts:10,30-35
- test/unit/response-conformance.test.ts:76-87
- test/unit/sse-conformance.test.ts:182,357-372,391,394
- test/unit/sse.test.ts:131-142
- test/unit/tools.test.ts:38,58,82,146,170
- test/unit/json-schema-to-typebox.test.ts:82-92,158,185
- test/unit/payload-passthrough.test.ts:91-106,125-128
- test/unit/payload-passthrough-tool-strict.test.ts:127-131
- test/unit/payload-passthrough-providers.test.ts:45-77
- test/unit/validate.test.ts:101
- test/unit/complete.test.ts:1-13,8
- test/unit/errors.test.ts:31-58
- test/unit/logging.test.ts:36,85-97
- test/unit/config-schema.test.ts:13,155-166,162
- test/unit/log-level-config.test.ts:68
- test/unit/zed-sync.test.ts:10,271-273,407-408
- test/unit/model-exposure.test.ts:227-240,399-421
- test/unit/upstream-idle.test.ts:95-108,142-151,163-176
- test/unit/lint-naming.test.ts:39
- test/conformance/sdk-chat.test.ts:6,37-40
- test/helpers.ts:115
- src/openai/messages.ts:85,116-126
- src/pi/registry.ts:99-107,161,163
- src/server/routes.ts:254-270
- src/server/health.ts:63,105-111
- src/server/errors.ts:74-76,86
- src/logging/index.ts:64-74
- src/sync/zed.ts:260-283
- .github/workflows/ci.yml:36-48
- package.json:60
