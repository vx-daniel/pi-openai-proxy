/**
 * Record and replay real provider traffic.
 *
 * Recording (`pnpm run test:live:record`, on demand only) puts a pass-through server between pi
 * and the real provider: pi's `models.json` points the provider's `baseUrl` at it, it forwards each
 * request unchanged and saves the response, chunk by chunk, with the request pi sent minus its
 * credentials. Replay (offline, the default) serves a saved response from the mock provider
 * (`test/fixtures/mock-provider.ts`), so a test drives pi's real client over real HTTP with
 * real-shaped provider output, without a login or a network.
 *
 * Plain relative imports only: `scripts/record-fixtures.ts` runs this under Node directly, where the
 * `@proxy/*` aliases do not resolve.
 */

import { once } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'

import * as z from 'zod'

/** Where recordings live: `<api>/<scenario>.json`. */
export const RECORDINGS_DIR = join(import.meta.dirname, 'recordings')

const RECORDING_VERSION = 1
/** Recordings are committed and reviewed: pretty-printed, so a re-recording diffs readably. */
const JSON_INDENT = 2

/** Request headers worth keeping: a pi upgrade that changes them shows up as a diff. */
const KEPT_REQUEST_HEADERS = new Set([
  'anthropic-beta',
  'anthropic-version',
  'content-type',
  'user-agent',
  'x-app'
])

const RecordingSchema = z.object({
  version: z.literal(RECORDING_VERSION),
  api: z.string().trim(),
  scenario: z.string().trim(),
  model: z.string().trim(),
  recordedAt: z.string().trim(),
  piVersion: z.string().trim(),
  request: z.object({
    path: z.string().trim(),
    headers: z.record(z.string().trim(), z.string().trim()),
    body: z.unknown()
  }),
  response: z.object({
    status: z.int(),
    contentType: z.string().trim(),
    /** The body as the provider sent it, split where it arrived, so replay keeps the boundaries. */
    // oxlint-disable-next-line zod/prefer-string-schema-with-trim -- SSE framing is whitespace: trimming would merge events
    chunks: z.array(z.string())
  })
})

export type Recording = z.infer<typeof RecordingSchema>

/** What the recorder captured for one request, before it is named and saved. */
export type CapturedExchange = Pick<Recording, 'request' | 'response'>

export function recordingPath(api: string, scenario: string, directory = RECORDINGS_DIR): string {
  return join(directory, api, `${scenario}.json`)
}

export function loadRecording(
  api: string,
  scenario: string,
  directory = RECORDINGS_DIR
): Recording {
  const parsed = RecordingSchema.safeParse(
    JSON.parse(readFileSync(recordingPath(api, scenario, directory), 'utf8'))
  )
  if (!parsed.success) {
    throw new Error(`Recording ${api}/${scenario} is malformed: ${parsed.error.message}`)
  }
  return parsed.data
}

/** Credential-shaped text a recording must never contain, whatever the request headers held. */
const CREDENTIAL_PATTERN = /sk-ant-[a-z]{3}\d{2}-|Bearer\s+\S{20,}/

/**
 * Save a recording, unless it contains a credential: any of `secrets` (the values the request's
 * auth headers carried) or anything shaped like one. Refuses rather than redacts, so a leak is
 * noticed instead of silently patched.
 */
export function saveRecording(
  recording: Recording,
  secrets: readonly string[],
  directory = RECORDINGS_DIR
): string {
  const text = `${JSON.stringify(recording, null, JSON_INDENT)}\n`
  const leaked = secrets.filter((secret) => secret !== '' && text.includes(secret))
  if (leaked.length > 0 || CREDENTIAL_PATTERN.test(text)) {
    throw new Error(
      `Refusing to save ${recording.api}/${recording.scenario}: it contains a credential`
    )
  }
  const path = recordingPath(recording.api, recording.scenario, directory)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

/** The credential values a request carried, which its recording must not contain. */
export function credentialsIn(headers: IncomingHttpHeaders): string[] {
  const values: string[] = []
  for (const headerName of ['authorization', 'x-api-key', 'cookie']) {
    const headerValue = headers[headerName]
    if (typeof headerValue === 'string') {
      values.push(headerValue, headerValue.replace(/^Bearer\s+/i, ''))
    }
  }
  return values
}

function keptHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (KEPT_REQUEST_HEADERS.has(headerName) && typeof headerValue === 'string') {
      kept[headerName] = headerValue
    }
  }
  return kept
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export interface Recorder {
  readonly baseUrl: string
  /** Every exchange so far, in order, with the credentials each request carried. */
  readonly exchanges: readonly { readonly exchange: CapturedExchange; readonly secrets: string[] }[]
  close(): Promise<void>
}

/**
 * A pass-through server on 127.0.0.1 that forwards every request to `upstreamOrigin` (for example
 * `https://api.anthropic.com`) and keeps what came back. Point a provider's `baseUrl` at
 * `recorder.baseUrl` plus the provider's own path prefix, if it has one.
 */
export async function startRecorder(upstreamOrigin: string): Promise<Recorder> {
  const exchanges: { exchange: CapturedExchange; secrets: string[] }[] = []
  const server: Server = createServer((incoming, response) => {
    let text = ''
    incoming.on('data', (part: Buffer) => {
      text += part.toString()
    })
    incoming.on('end', () => {
      const request = { path: incoming.url ?? '/', headers: incoming.headers, body: text }
      void record(upstreamOrigin, request, response, exchanges)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('recorder not on TCP')
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    exchanges,
    async close() {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    }
  }
}

/** Headers that describe the hop to the recorder, not the request: never forwarded. */
const HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding'])
const HTTP_BAD_GATEWAY = 502

/** One request pi sent to the recorder. */
interface IncomingRequest {
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

async function forward(
  upstreamOrigin: string,
  { path, headers, body }: IncomingRequest,
  response: ServerResponse
): Promise<{ exchange: CapturedExchange; secrets: string[] }> {
  const forwarded = new Headers()
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (!HOP_HEADERS.has(headerName) && typeof headerValue === 'string') {
      forwarded.set(headerName, headerValue)
    }
  }
  const upstream = await fetch(`${upstreamOrigin}${path}`, {
    method: 'POST',
    headers: forwarded,
    body
  })
  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
  response.writeHead(upstream.status, { 'content-type': contentType })
  const chunks: string[] = []
  if (upstream.body !== null) {
    const decoder = new TextDecoder()
    const reader = upstream.body.getReader()
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      const part: unknown = read.value
      if (!(part instanceof Uint8Array)) throw new TypeError('upstream body yielded non-bytes')
      const decoded = decoder.decode(part, { stream: true })
      chunks.push(decoded)
      response.write(decoded)
    }
  }
  response.end()
  return {
    exchange: {
      request: { path, headers: keptHeaders(headers), body: parseJson(body) },
      response: { status: upstream.status, contentType, chunks }
    },
    secrets: credentialsIn(headers)
  }
}

/** Forward one request and keep the exchange; if the upstream cannot be reached, say so to pi. */
async function record(
  upstreamOrigin: string,
  request: IncomingRequest,
  response: ServerResponse,
  exchanges: { exchange: CapturedExchange; secrets: string[] }[]
): Promise<void> {
  try {
    exchanges.push(await forward(upstreamOrigin, request, response))
  } catch (error) {
    response.writeHead(HTTP_BAD_GATEWAY, { 'content-type': 'text/plain' })
    response.end(`recorder could not reach ${upstreamOrigin}: ${String(error)}`)
  }
}

/** Serve a recording: its status, content type and body chunks, in the order they arrived. */
export function replay(recording: Recording): (response: ServerResponse) => void {
  return (response) => {
    response.writeHead(recording.response.status, {
      'content-type': recording.response.contentType
    })
    for (const part of recording.response.chunks) response.write(part)
    response.end()
  }
}
