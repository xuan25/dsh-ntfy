// dsh-ntfy configuration: the NTFY_* env contract (read once at plugin boot).
// A channel is declared by NTFY_<NAME>_TOPIC; per channel: NTFY_<N>_SERVER
// (default the public ntfy.sh base URL; any self-hosted ntfy server works),
// NTFY_<N>_USER + NTFY_<N>_PASS (Basic auth, must appear as a pair),
// NTFY_<N>_TOKEN (Bearer; never combined with USER/PASS).
// Invalid channels are dropped with a warning (boot never fails); the
// NTFY_DEFAULT_CHANNEL value is stored raw and resolved at call time, so a stale
// default only fails the sends that rely on it.
// An optional config layer (a patch entry targeting this plugin's id, delivered
// by the cordis loader) carries the same fields, camelCase, as explicit values;
// it is folded onto a copy of the env record before parsing: a delivered field
// is an explicit value (it beats the env value, which beats the built-in
// default); fields the layer omits resolve as the env contract. Layer
// composition (which patch layer wins, no deep merge) is cordis semantics: the
// plugin sees only the one object the loader delivers.
import type { ChannelAuth, ChannelConfig, NtfyConfig } from './types.js'

/** Topic charset: 1-64 of -_A-Za-z0-9 (the ntfy server's own topic grammar). */
export const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/

/** Channel name charset: lowercase start, 1-32 chars (same convention as dsh-timer job ids). */
export const CHANNEL_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/

/** Server base URL when NTFY_<N>_SERVER is unset. */
export const DEFAULT_SERVER = 'https://ntfy.sh'

/** Matches NTFY_<NAME>_TOPIC; the capture is the uppercased channel name. */
const TOPIC_VAR_RE = /^NTFY_([A-Z0-9]+)_TOPIC$/

interface RawChannel {
  name: string
  upper: string
  server: string
  topic: string
  user: string | null
  pass: string | null
  token: string | null
}

/**
 * Parse the NTFY_* env contract.
 * @param env env record (process.env at boot, or a test fixture).
 * @param warn channel-drop reporting hook (the plugin init wires it to the logger).
 * @returns the validated channel set (sorted by name) plus the raw default channel name.
 */
export function parseEnv(env: Record<string, string | undefined>, warn: (msg: string) => void): NtfyConfig {
  const raw: RawChannel[] = []
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    const m = TOPIC_VAR_RE.exec(key)
    if (!m) continue
    const upper = m[1]
    raw.push({
      name: upper.toLowerCase(),
      upper,
      server: env[`NTFY_${upper}_SERVER`] ?? DEFAULT_SERVER,
      topic: value,
      user: env[`NTFY_${upper}_USER`] ?? null,
      pass: env[`NTFY_${upper}_PASS`] ?? null,
      token: env[`NTFY_${upper}_TOKEN`] ?? null,
    })
  }
  raw.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const defaultName = typeof env.NTFY_DEFAULT_CHANNEL === 'string' && env.NTFY_DEFAULT_CHANNEL.length > 0
    ? env.NTFY_DEFAULT_CHANNEL
    : null

  // Channel names derive from env var names (case-insensitive), so the default
  // channel reference matches them case-insensitively. Explicit channel names in a
  // send stay exact: the agent reads the canonical lowercase names from the
  // channels verb.
  const defaultLower = defaultName === null ? null : defaultName.toLowerCase()

  const channels: ChannelConfig[] = []
  for (const e of raw) {
    if (!CHANNEL_NAME_RE.test(e.name)) {
      warn(`channel "${e.name}" dropped: name outside the charset [a-z][a-z0-9-]{0,31}`)
      continue
    }
    if (!TOPIC_RE.test(e.topic)) {
      warn(`channel "${e.name}" dropped: topic is empty or outside the charset -_A-Za-z0-9 (length 1-64)`)
      continue
    }
    if (e.token !== null && (e.user !== null || e.pass !== null)) {
      warn(`channel "${e.name}" dropped: auth conflict (TOKEN together with USER/PASS); keep one auth form only`)
      continue
    }
    if ((e.user === null) !== (e.pass === null)) {
      warn(`channel "${e.name}" dropped: half of the Basic auth pair (USER and PASS must appear together)`)
      continue
    }
    let auth: ChannelAuth | null = null
    if (e.token !== null) {
      auth = { kind: 'token', token: e.token }
    } else if (e.user !== null && e.pass !== null) {
      auth = { kind: 'basic', user: e.user, pass: e.pass }
    }
    channels.push({ name: e.name, server: e.server, topic: e.topic, auth, isDefault: defaultLower === e.name })
  }
  return { channels, defaultName }
}

/** A successful channel resolution. */
export interface Resolved {
  channel: ChannelConfig
}

/** A failed channel resolution (the error text names the valid set). */
export interface ResolutionError {
  error: string
}

/**
 * Resolve the send target through the single rule chain (no dual track):
 * an explicit channel name must be in the valid set; otherwise the default
 * channel when it is valid; otherwise the sole channel when exactly one is
 * configured; otherwise the error.
 * @param cfg the parsed config.
 * @param explicit the explicit channel parameter (absent = the rest of the chain).
 * @returns the channel or the error text (never throws).
 */
export function resolveChannel(cfg: NtfyConfig, explicit: string | undefined): Resolved | ResolutionError {
  if (explicit !== undefined) {
    const hit = cfg.channels.find((c) => c.name === explicit)
    if (hit) return { channel: hit }
    const valid = cfg.channels.map((c) => c.name).join(', ')
    return { error: `unknown channel "${explicit}" (valid channels: ${valid || 'none'})` }
  }
  if (cfg.defaultName !== null) {
    const wanted = cfg.defaultName.toLowerCase()
    const hit = cfg.channels.find((c) => c.name === wanted)
    if (hit) return { channel: hit }
  }
  if (cfg.channels.length === 1) return { channel: cfg.channels[0] }
  const valid = cfg.channels.map((c) => c.name).join(', ')
  return {
    error: `no channel specified and no default channel configured (valid channels: ${valid || 'none'}; set NTFY_DEFAULT_CHANNEL or name a channel)`,
  }
}

/**
 * One channel of the delivered config layer (the camelCase mirror of the
 * per-channel env keys; all keys optional - a key absent here resolves as the
 * env contract (see foldConfig)).
 */
export interface DeliveredChannelConfig {
  topic?: string
  server?: string
  user?: string
  pass?: string
  token?: string
}

/**
 * The delivered config layer (validated by the plugin's static Config schema
 * before it reaches the constructor). All keys optional; undefined or {} is
 * exactly the env-only behavior.
 */
export interface DeliveredConfig {
  defaultChannel?: string
  channels?: Record<string, DeliveredChannelConfig>
}

/** Per-channel field set (camelCase config key to env variable suffix). */
const CONFIG_FIELD_TO_ENV: Record<string, string> = {
  topic: 'TOPIC',
  server: 'SERVER',
  user: 'USER',
  pass: 'PASS',
  token: 'TOKEN',
}

/**
 * Fold the delivered config layer onto a copy of the env record and parse the
 * merged record. The parser is the single authority: a delivered field is an
 * explicit value (it beats the env value, which beats the built-in default),
 * fields the layer omits resolve as the env contract. A layer-declared channel
 * that carries no topic in either layer is not a channel; it is reported with a
 * warning (the input env is never mutated).
 * @param env env record (process.env at boot, or a test fixture).
 * @param config the delivered layer (undefined or {} = env-only behavior).
 * @param warn channel-drop / no-topic reporting hook (the plugin init wires it to the logger).
 * @returns the validated channel set (sorted by name) plus the raw default channel name.
 */
export function foldConfig(
  env: Record<string, string | undefined>,
  config: DeliveredConfig | undefined,
  warn: (msg: string) => void,
): NtfyConfig {
  if (!config) return parseEnv(env, warn)
  const merged: Record<string, string | undefined> = { ...env }
  if (config.defaultChannel !== undefined) merged.NTFY_DEFAULT_CHANNEL = config.defaultChannel
  for (const [name, fields] of Object.entries(config.channels ?? {})) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue
      const suffix = CONFIG_FIELD_TO_ENV[key]
      if (suffix === undefined) continue
      merged[`NTFY_${name.toUpperCase()}_${suffix}`] = value
    }
  }
  const cfg = parseEnv(merged, warn)
  const parsed = new Set(cfg.channels.map((c) => c.name))
  for (const [name, fields] of Object.entries(config.channels ?? {})) {
    if (!parsed.has(name) && env[`NTFY_${name.toUpperCase()}_TOPIC`] === undefined && fields.topic === undefined) {
      warn(`channel "${name}" (config layer) has no topic in either layer; it is not a channel (set topic or drop the entry)`)
    }
  }
  return cfg
}
