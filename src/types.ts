// dsh-ntfy shared types: cross-module contracts for channel configuration,
// send results, and the channels listing view.
// This file imports types only (zero runtime dependencies) and centralizes the
// framework type wiring (the cordis Context re-export).
import type { Context } from '@deepseek-ai/cordis'

export type { Context }

/** Authentication material for one channel (never serialized into output or logs). */
export type ChannelAuth =
  | { kind: 'basic'; user: string; pass: string }
  | { kind: 'token'; token: string }

/** A validated ntfy channel (an ntfy topic endpoint: server + topic + optional auth). */
export interface ChannelConfig {
  /** Channel name (derived from the NTFY_<NAME>_TOPIC env var; lowercase, 1-32 chars). */
  name: string
  /** ntfy server base URL (self-hosted servers supported; default is the public one). */
  server: string
  /** ntfy topic (the addressing credential; charset -_A-Za-z0-9, length 1-64). */
  topic: string
  /** Auth material when configured; null = anonymous endpoint. */
  auth: ChannelAuth | null
  /** True when NTFY_DEFAULT_CHANNEL names this channel. */
  isDefault: boolean
}

/** The plugin's env-derived configuration (read once at boot; container env is static per boot). */
export interface NtfyConfig {
  /** The validated channel set, sorted by name. */
  channels: ChannelConfig[]
  /** Raw NTFY_DEFAULT_CHANNEL value (may name a dropped or unknown channel; resolved at call time). */
  defaultName: string | null
}

/** Send parameters (all optional except body; absent = the corresponding header is not sent). */
export interface SendParams {
  /** Message body (required, non-empty); chunked to 4096-byte UTF-8 pieces before sending. */
  body: string
  /** ntfy title (X-Title); max 1 KB (pre-validated). */
  title?: string
  /** Priority (X-Priority); closed value set, validated at the tool layer. */
  priority?: string
  /** Tags (X-Tags); a comma-separated string or an array joined with commas; max 512 bytes. */
  tags?: string | string[]
  /** Click-through URL (X-Click). */
  click?: string
  /** RFC3339 timestamp or duration such as 2h (X-Delay); the range bound is owned by the server. */
  delay?: string
  /** JSON array or short format (X-Actions); pass-through, the server validates. */
  actions?: string
  /** Attachment URL fetched by the ntfy server (X-Attach); local binary upload is not supported. */
  attach?: string
  /** true sends X-Markdown: yes (false / absent = the header is not sent). */
  markdown?: boolean
  /** Attachment icon URL (X-Icon). */
  icon?: string
  /** Attachment file name (X-Filename). */
  filename?: string
  /** Email address or "yes" (X-Email). */
  email?: string
  /** Phone number for a call alert (X-Call). */
  call?: string
  /** false sends X-Cache: no (true / absent = client caching stays on). */
  cache?: boolean
  /** false sends X-Firebase: no (true / absent = Firebase push stays on). */
  firebase?: boolean
  /** Explicit channel name (target selector, not a header); absent = the resolution chain. */
  channel?: string
}

/** Successful send result (every chunk delivered). */
export interface SendOk {
  ok: true
  /** The channel the send went to. */
  channel: string
  /** Total chunk count the body was split into. */
  chunks: number
  /** Chunks delivered (equals chunks on success). */
  delivered: number
  /** Per-chunk ntfy message id (null when the response id could not be parsed; does not affect ok). */
  ids: (string | null)[]
}

/** Failed send result (the first failed chunk aborts the remaining chunks). */
export interface SendFail {
  ok: false
  /** The channel the send targeted (absent when channel resolution itself failed). */
  channel?: string
  /** Total chunk count (0 when nothing was sent). */
  chunks: number
  /** Chunks delivered before the failure. */
  delivered: number
  /** 1-based index of the first failed chunk (present only when a chunk send failed). */
  failed_at?: number
  /** Error reason (HTTP status plus the server error text, or the network/timeout reason); never contains auth material or the full server+topic URL. */
  error: string
}

export type SendResult = SendOk | SendFail

/** One entry of the channels verb listing (auth shown as a kind marker only). */
export interface ChannelView {
  name: string
  server: string
  topic: string
  /** Auth kind marker: 'basic' | 'token' | 'none' (never the auth material itself). */
  auth: 'basic' | 'token' | 'none'
  isDefault: boolean
}

/** Result of the channels verb (local listing, zero network). */
export interface ChannelsResult {
  /** Name of the default channel (null when unset or naming a dropped / unknown channel). */
  default: string | null
  channels: ChannelView[]
}
