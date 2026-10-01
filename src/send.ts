// dsh-ntfy send path: channel resolution, pre-validation, chunked publish to the
// ntfy endpoint, and the first-failure-abort semantics. The send call never throws:
// every outcome (including unexpected ones) is reported through the result object,
// and error text never contains auth material or the full server+topic URL (the
// channel name stands in; the server's own error text is passed through, trimmed).
import { Buffer } from 'node:buffer'
import type { ChannelsResult, ChannelView, NtfyConfig, SendParams, SendResult } from './types.js'
import { resolveChannel } from './config.js'
import { chunkUtf8 } from './chunk.js'
import { errMsg } from './util.js'

/** Per-request timeout (bounds the publish call; the ntfy docs advise clients to do so). */
export const SEND_TIMEOUT_MS = 10_000
/** Pre-validation budget: the ntfy title limit. */
export const TITLE_MAX_BYTES = 1024
/** Pre-validation budget: the ntfy tags limit. */
export const TAGS_MAX_BYTES = 512
/** Response error text kept in the reported error (the server error text, trimmed). */
export const ERROR_TEXT_MAX = 300

/**
 * UTF-8 byte length of a string.
 * @param s the string to measure.
 * @returns the byte count of its UTF-8 encoding.
 */
export function utf8Bytes(s: string): number {
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

/**
 * Build the ntfy publish headers for one send (all chunks of one send share the
 * same headers). Absent parameters contribute no header.
 * @param p the send parameters.
 * @returns the header map (Content-Type always present).
 */
export function buildHeaders(p: SendParams): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'text/plain; charset=utf-8' }
  if (p.title !== undefined) h['X-Title'] = encodeHeaderValue(p.title)
  if (p.priority !== undefined) h['X-Priority'] = p.priority
  if (p.tags !== undefined) h['X-Tags'] = encodeHeaderValue(Array.isArray(p.tags) ? p.tags.join(',') : p.tags)
  if (p.click !== undefined) h['X-Click'] = encodeHeaderValue(p.click)
  if (p.delay !== undefined) h['X-Delay'] = encodeHeaderValue(p.delay)
  if (p.actions !== undefined) h['X-Actions'] = encodeHeaderValue(p.actions)
  if (p.attach !== undefined) h['X-Attach'] = encodeHeaderValue(p.attach)
  if (p.markdown === true) h['X-Markdown'] = 'yes'
  if (p.icon !== undefined) h['X-Icon'] = encodeHeaderValue(p.icon)
  if (p.filename !== undefined) h['X-Filename'] = encodeHeaderValue(p.filename)
  if (p.email !== undefined) h['X-Email'] = encodeHeaderValue(p.email)
  if (p.call !== undefined) h['X-Call'] = encodeHeaderValue(p.call)
  if (p.cache === false) h['X-Cache'] = 'no'
  if (p.firebase === false) h['X-Firebase'] = 'no'
  return h
}

/**
 * Send one message to a channel: resolve the target, pre-validate, chunk the
 * body, publish the chunks sequentially, and abort at the first failed chunk.
 * @param cfg the parsed plugin config.
 * @param params the send parameters.
 * @returns the result object (never throws; ok=false carries the error reason).
 */
export async function send(cfg: NtfyConfig, params: SendParams): Promise<SendResult> {
  const target = resolveChannel(cfg, params.channel)
  if ('error' in target) {
    const result: { ok: false; channel?: string; chunks: number; delivered: number; error: string } = {
      ok: false,
      chunks: 0,
      delivered: 0,
      error: target.error,
    }
    if (params.channel !== undefined) result.channel = params.channel
    return result
  }
  const ch = target.channel

  if (typeof params.body !== 'string' || params.body.trim() === '') {
    return { ok: false, channel: ch.name, chunks: 0, delivered: 0, error: 'body is required (non-empty message body)' }
  }
  if (params.title !== undefined && utf8Bytes(params.title) > TITLE_MAX_BYTES) {
    return {
      ok: false,
      channel: ch.name,
      chunks: 0,
      delivered: 0,
      error: `title exceeds 1 KB (${utf8Bytes(params.title)} bytes)`,
    }
  }
  const tagsText = params.tags !== undefined ? (Array.isArray(params.tags) ? params.tags.join(',') : params.tags) : undefined
  if (tagsText !== undefined && utf8Bytes(tagsText) > TAGS_MAX_BYTES) {
    return {
      ok: false,
      channel: ch.name,
      chunks: 0,
      delivered: 0,
      error: `tags exceed 512 bytes (${utf8Bytes(tagsText)} bytes)`,
    }
  }

  const chunks = chunkUtf8(params.body)
  const headers = buildHeaders(params)
  if (ch.auth !== null && ch.auth.kind === 'basic') {
    headers['Authorization'] = `Basic ${Buffer.from(`${ch.auth.user}:${ch.auth.pass}`, 'utf8').toString('base64')}`
  } else if (ch.auth !== null && ch.auth.kind === 'token') {
    headers['Authorization'] = `Bearer ${ch.auth.token}`
  }
  // The server URL keeps no trailing slash; the topic charset needs no escaping
  // as a path segment.
  const url = `${ch.server.replace(/\/+$/, '')}/${ch.topic}`

  const ids: (string | null)[] = []
  let delivered = 0
  for (let i = 0; i < chunks.length; i++) {
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body: chunks[i], signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
    } catch (err) {
      const name = (err as { name?: unknown } | null)?.name
      if (name === 'AbortError' || name === 'TimeoutError') {
        return {
          ok: false,
          channel: ch.name,
          chunks: chunks.length,
          delivered,
          failed_at: i + 1,
          error: `chunk ${i + 1} failed: timeout after ${SEND_TIMEOUT_MS} ms`,
        }
      }
      // The client reports connection failures with the target host in the
      // text; strip the server origin and host:port from whatever text survives
      // so no target address ever reaches the reported error (the channel name
      // stands in for the target).
      return {
        ok: false,
        channel: ch.name,
        chunks: chunks.length,
        delivered,
        failed_at: i + 1,
        error: `chunk ${i + 1} failed: network error (${scrubTarget(errMsg(err), ch.server)})`,
      }
    }
    if (!res.ok) {
      let detail = ''
      try {
        const bodyText = await res.text()
        if (bodyText) detail = `: ${bodyText.slice(0, ERROR_TEXT_MAX)}`
      } catch {
        // a response without a readable body: the status line alone is the report
      }
      return {
        ok: false,
        channel: ch.name,
        chunks: chunks.length,
        delivered,
        failed_at: i + 1,
        error: `chunk ${i + 1} failed: HTTP ${res.status}${detail}`,
      }
    }
    delivered += 1
    let id: string | null = null
    try {
      const data = (await res.json()) as { id?: unknown }
      if (typeof data.id === 'string') id = data.id
    } catch {
      id = null // the id is informational; a parse failure does not affect the success decision
    }
    ids.push(id)
  }
  return { ok: true, channel: ch.name, chunks: chunks.length, delivered: ids.length, ids }
}

/**
 * Remove the target server from raw client error text: the origin (with
 * scheme), the host:port pair, and the bare host, longest first, each replaced
 * by a fixed label.
 * @param text the raw client error text.
 * @param server the channel server base URL.
 * @returns the text with every target occurrence replaced.
 */
function scrubTarget(text: string, server: string): string {
  const patterns: string[] = []
  try {
    const u = new URL(server)
    if (u.port !== '') patterns.push(`${u.hostname}:${u.port}`)
    patterns.push(u.hostname)
  } catch {
    // an unparseable server cannot happen (config validation); keep the origin-only strip
  }
  patterns.push(server.replace(/\/+$/, ''))
  for (const p of patterns.sort((a, b) => b.length - a.length)) {
    if (p !== '') text = text.split(p).join('[server]')
  }
  return text
}

/**
 * Prepare a user-provided header value for the wire. Both built-in Node HTTP
 * clients accept only Latin-1 (0x00-0xFF) characters in header values, so a
 * value that fits is sent verbatim; anything else (e.g. non-Latin-1 Unicode
 * text in a title) is wrapped as a single RFC 2047 base64 encoded-word, which
 * the ntfy server decodes back to the original text before use.
 * @param value the raw header value from the send parameters.
 * @returns the value as it goes on the wire.
 */
export function encodeHeaderValue(value: string): string {
  let latin1 = true
  for (const ch of value) {
    if ((ch.codePointAt(0) as number) > 0xff) {
      latin1 = false
      break
    }
  }
  if (latin1) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/**
 * Build the channels verb listing (pure local, zero network; auth shown as a
 * kind marker only, never the auth material).
 * @param cfg the parsed plugin config.
 * @returns the default channel name (only when it names a valid channel) and the channel views.
 */
export function listChannels(cfg: NtfyConfig): ChannelsResult {
  const channels: ChannelView[] = cfg.channels.map((c) => ({
    name: c.name,
    server: c.server,
    topic: c.topic,
    auth: c.auth === null ? 'none' : c.auth.kind,
    isDefault: c.isDefault,
  }))
  let def: string | null = null
  if (cfg.defaultName !== null) {
    const wanted = cfg.defaultName.toLowerCase()
    const hit = cfg.channels.find((c) => c.name === wanted)
    if (hit) def = hit.name
  }
  return { default: def, channels }
}
