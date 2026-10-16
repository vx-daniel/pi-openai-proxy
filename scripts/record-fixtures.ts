/**
 * Record real Anthropic traffic as replay fixtures (`test/fixtures/recordings/anthropic-messages`).
 * On demand only: `pnpm run test:live:record`. It spends a few cents of quota on the login used.
 *
 * pi's own Anthropic client sends each scenario through a pass-through recorder
 * (`test/fixtures/recording.ts`) on 127.0.0.1: pi's `models.json` points the `anthropic` provider
 * at it, so the request is exactly what pi sends in production (the Claude Code OAuth headers and
 * system prompt included), and the response is saved as it arrived, minus every credential. A
 * recording that still contains one is refused, not redacted.
 *
 * LOGIN: set PI_PROXY_RECORD_AGENT_DIR to a pi agent dir holding a login made for recording
 * (`PI_CODING_AGENT_DIR=<dir> pi`, then `/login`). pi reads and refreshes its `auth.json` in place.
 * Never point it at a copy of a login another pi or proxy uses: refreshing an expired OAuth token
 * rotates the refresh token, and every other copy stops working.
 *
 * Runs under Node directly (`node scripts/record-fixtures.ts`), so imports are relative with `.ts`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
  Type
} from '@earendil-works/pi-ai'
import { ModelRuntime, VERSION } from '@earendil-works/pi-coding-agent'

import { type Recorder, saveRecording, startRecorder } from '../test/fixtures/recording.ts'

const API = 'anthropic-messages'
const MODEL_ID = 'claude-haiku-5-5'
const DEFAULT_UPSTREAM = 'https://api.anthropic.com'

/** One recorded exchange: what pi is asked, and with which options. */
interface Scenario {
  readonly name: string
  readonly modelId?: string
  readonly context: Context
  readonly options: SimpleStreamOptions
  /** Send the same request this many times and record the last (for cache reads). */
  readonly repeat?: number
}

function userMessage(text: string): Context['messages'][number] {
  return { role: 'user', content: text, timestamp: Date.now() }
}

/** A system prompt above Anthropic's minimum cacheable length, so a repeat reads the cache. */
const LONG_SYSTEM_PROMPT = Array.from(
  { length: 700 },
  (_, lineIndex) =>
    `Reference line ${String(lineIndex)}: the recorder pads this prompt so the provider caches it.`
).join('\n')

const WEATHER_TOOLS: Context['tools'] = [
  {
    name: 'get_weather',
    description: 'Current weather for a city',
    parameters: Type.Object({ city: Type.String() })
  },
  {
    name: 'get_time',
    description: 'Current time in a time zone',
    parameters: Type.Object({ zone: Type.String() })
  }
]

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'text',
    context: { messages: [userMessage('Reply with exactly: Hello from the recorder.')] },
    options: { maxTokens: 64 }
  },
  {
    name: 'two-tool-calls',
    context: {
      messages: [
        userMessage('Call get_weather for Oslo and get_time for CET, both now, in one reply.')
      ],
      tools: WEATHER_TOOLS
    },
    options: { maxTokens: 512 }
  },
  {
    name: 'thinking',
    context: { messages: [userMessage('What is 17 times 23? Answer with the number only.')] },
    options: { maxTokens: 4096, reasoning: 'low' }
  },
  {
    name: 'cache-read',
    context: {
      systemPrompt: LONG_SYSTEM_PROMPT,
      messages: [userMessage('Reply with exactly: cached.')]
    },
    options: { maxTokens: 32 },
    repeat: 2
  },
  {
    name: 'model-not-found',
    modelId: 'claude-recorder-no-such-model',
    context: { messages: [userMessage('Hello')] },
    options: { maxTokens: 16 }
  }
]

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function recordingAgentDir(): string {
  const configured = process.env.PI_PROXY_RECORD_AGENT_DIR
  if (configured === undefined || configured === '') {
    fail(
      'Set PI_PROXY_RECORD_AGENT_DIR to a pi agent dir with a login made for recording ' +
        '(PI_CODING_AGENT_DIR=<dir> pi, then /login). See the header of scripts/record-fixtures.ts.'
    )
  }
  const agentDir = resolve(configured)
  if (agentDir === join(homedir(), '.pi', 'agent')) {
    fail(
      'PI_PROXY_RECORD_AGENT_DIR is your everyday pi agent dir. Record with a separate login, so a ' +
        'refresh during recording cannot disturb the one you use.'
    )
  }
  return agentDir
}

async function recordScenario(
  runtime: ModelRuntime,
  recorder: Recorder,
  scenario: Scenario
): Promise<string> {
  const base = runtime.getModel('anthropic', MODEL_ID)
  if (base === undefined) fail(`pi has no anthropic/${MODEL_ID}`)
  const model: Model<Api> =
    scenario.modelId === undefined ? base : { ...base, id: scenario.modelId }
  for (let attempt = 1; attempt <= (scenario.repeat ?? 1); attempt++) {
    // Sequential on purpose: a repeat must follow the request whose cache it reads.
    await runtime.streamSimple(model, scenario.context, scenario.options).result()
  }
  const captured = recorder.exchanges.at(-1)
  if (captured === undefined) fail(`${scenario.name}: the recorder saw no request`)
  return saveRecording(
    {
      version: 1,
      api: API,
      scenario: scenario.name,
      model: model.id,
      recordedAt: new Date().toISOString(),
      piVersion: VERSION,
      ...captured.exchange
    },
    captured.secrets
  )
}

async function main(): Promise<void> {
  const agentDir = recordingAgentDir()
  const recorder = await startRecorder(process.env.PI_PROXY_RECORD_UPSTREAM ?? DEFAULT_UPSTREAM)
  const modelsDir = mkdtempSync(join(tmpdir(), 'pi-proxy-record-'))
  try {
    const modelsPath = join(modelsDir, 'models.json')
    writeFileSync(
      modelsPath,
      JSON.stringify({ providers: { anthropic: { baseUrl: recorder.baseUrl } } })
    )
    process.env.PI_CODING_AGENT_DIR = agentDir
    // The login stays where it is (refreshed in place); only models.json is the recorder's.
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath })
    if (!runtime.isUsingOAuth('anthropic') && !runtime.hasConfiguredAuth('anthropic')) {
      fail(`No Anthropic login in ${agentDir}`)
    }
    for (const scenario of SCENARIOS) {
      // Sequential on purpose: each recording is the recorder's latest exchange.
      const path = await recordScenario(runtime, recorder, scenario)
      process.stdout.write(`recorded ${scenario.name} -> ${path}\n`)
    }
  } finally {
    await recorder.close()
    rmSync(modelsDir, { recursive: true, force: true })
  }
}

await main()
