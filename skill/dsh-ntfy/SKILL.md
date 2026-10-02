---
name: dsh-ntfy
description: "Send ntfy notifications (ntfy.sh or a self-hosted ntfy server) with the ntfy tool. Covers the send/channels parameter set, the NTFY_* env contract, limits, and troubleshooting."
whenToUse: "When a task must push a notification to an ntfy topic (alert, status, reminder) or must inspect the configured ntfy channels."
---

# dsh-ntfy

Publish notifications to ntfy (ntfy.sh or a self-hosted ntfy server). A channel is an ntfy topic endpoint (server + topic + optional auth); channels are declared in environment variables (optionally overridden by the config layer below) and read once at boot. The plugin never retries, never fans out, and persists no credentials.

## Quick reference

```
ntfy { verb: "send", body: "deploy finished", title: "CI", priority: "high" }
ntfy { verb: "send", body: "...", channel: "dash", markdown: true, click: "https://example.com" }
ntfy { verb: "channels" }
```

- `send` returns `{ ok, channel, chunks, delivered, ids?, failed_at?, error? }`. When `ok` is false, `delivered` counts the chunks that reached the server; to deliver the rest, call `send` again with the remaining body explicitly.
- `channels` returns the local listing (`default` + `{ name, server, topic, auth, isDefault }[]`); `auth` is only the marker `basic` / `token` / `none`.

## Parameter set (send)

All optional except `body`; absent = the header is not sent. Every parameter applies to every chunk of a split body. Header parameter values carry full UTF-8 (non-ASCII text such as Chinese titles works): values that fit in Latin-1 go on the wire verbatim; anything else is sent as an RFC 2047 base64 encoded-word (`=?UTF-8?B?...?=`) that the ntfy server decodes back to the original text. The body is unrestricted UTF-8.

| Parameter | Header | Notes |
|---|---|---|
| `body` | — (request payload) | Required, non-empty. UTF-8 bodies over 4096 bytes are split into sequential chunks (codepoints never split; a cut prefers the last newline in the window). |
| `title` | `X-Title` | Max 1 KB; pre-validated, oversized titles are not sent. |
| `priority` | `X-Priority` | Closed set: `1`-`5`, `min`, `low`, `default`, `high`, `max`. |
| `tags` | `X-Tags` | Comma-separated string or string array (joined with commas); max 512 bytes combined. |
| `click` | `X-Click` | Click-through URL. |
| `delay` | `X-Delay` | RFC3339 timestamp or duration (`2h`); the 10s-3day bound is enforced by the server. |
| `actions` | `X-Actions` | JSON array or short format; pass-through, the server validates. |
| `attach` | `X-Attach` | Attachment URL, fetched by the ntfy server (local binary upload is not supported). |
| `markdown` | `X-Markdown` | `true` sends `yes`; absent/false sends no header. |
| `icon` | `X-Icon` | Attachment icon URL. |
| `filename` | `X-Filename` | Attachment file name. |
| `email` | `X-Email` | Address or `yes`. |
| `call` | `X-Call` | Phone number for a call alert. |
| `cache` | `X-Cache` | `false` sends `no`; absent/true keeps client caching on. |
| `firebase` | `X-Firebase` | `false` sends `no`; absent/true keeps Firebase push on. |
| `channel` | — (selector, not a header) | Target channel name. Absent: the default channel, or the sole channel when exactly one is configured. |

## Env contract

Read once at plugin boot (container env is static; changes need a host restart).

| Variable | Required | Meaning |
|---|---|---|
| `NTFY_<NAME>_TOPIC` | yes | Declares channel `<name>` = the lowercased `<NAME>` (the `<NAME>` segment is uppercase and digits only, e.g. `NTFY_DASH_TOPIC` declares channel `dash`; a lowercase segment matches nothing); the topic is the addressing credential, charset `[-_A-Za-z0-9]{1,64}`. Channel name: `^[a-z][a-z0-9-]{0,31}$` (no underscore, no leading digit — a `<NAME>` that violates it declares no channel). |
| `NTFY_<NAME>_SERVER` | no | Server base URL; default `https://ntfy.sh`; any self-hosted ntfy server works. |
| `NTFY_<NAME>_USER` + `NTFY_<NAME>_PASS` | no (as a pair) | Basic auth. A half pair (only one of the two) drops the channel. |
| `NTFY_<NAME>_TOKEN` | no | Bearer token. Combining TOKEN with USER/PASS drops the channel (ambiguous). |
| `NTFY_DEFAULT_CHANNEL` | no | Channel name used when a send names no channel (matched case-insensitively). A stale value does not fail boot; only the sends that rely on it fail. |

Channels that fail validation are dropped with a boot warning; the remaining channels are unaffected. There is no fan-out: a send always targets exactly one channel.

## Config layer (profile patch)

An optional config layer sits on top of the env contract: a cordis patch entry targeting the plugin id `dsh-ntfy` (the profile's `cordis.patch.yml`, the user-global `~/.dsh/cordis.patch.yml`, or a `--patch` overlay) carries a `config` object whose keys are camelCase mirrors of the env fields above, every key optional:

- `defaultChannel` - mirror of `NTFY_DEFAULT_CHANNEL`
- `channels` - a map of channel name (same charset as the env channel names) to per-channel keys, camelCase mirrors of the `NTFY_<N>_*` fields: `topic`, `server`, `user`, `pass`, `token`

Example:

```yaml
- id: dsh-ntfy
  config:
    defaultChannel: dash
    channels:
      dash:
        server: https://ntfy.example.com
```

Semantics:

- One precedence chain: delivered value > env value > built-in default. Keys the layer omits resolve as the env contract, so `config: {}` (or no entry) is exactly the env-only behavior. A layer-declared channel with no topic in either layer is not a channel; it is reported with a boot warning, in the spirit of the env drops.
- A patch targets a row by id and replaces its whole config: no deep merge, so a layer that overrides one field restates the fields it keeps. Layer order (later replaces earlier): the plugin's own default entry, the profile patch, the user-global patch, any `--patch` overlay - framework semantics.
- Validation: the layer is validated against a schema before the plugin starts; an unknown key or a topic outside the charset fails the plugin entry at load. Channels the parser drops (half Basic auth pair, token together with Basic auth, an invalid topic) still only warn, as in the env contract.
- Live effect: with the live patch reload, editing the patch file re-runs the plugin's constructor without a restart (the plugin is stateless, the next call uses the new values); otherwise the change applies at the next restart.
- Permissions: the agent edits the patch file directly as a plain file operation, under its own file permissions; the plugin provides no tool for changing its own configuration. When the file is not writable, report that honestly; do not work around it.
- Provenance: the `channels` verb presents values only; a value's source is verified on demand against the patch files and the env contract above.

## Limits

- ntfy.sh public service: 250 messages per visitor per day, 60 concurrent (the visitor bucket is shared per IP, so other traffic on the same egress can consume it). Self-hosted servers set their own limits.
- The plugin applies no client-side rate limit and no retry; a 429 is reported as-is.
- Scheduled delivery exists only as `delay`; once sent, a message cannot be withdrawn (the plugin has no update/clear/delete surface).
- Attachment limits are server-side (ntfy.sh: 2 MB per file / 20 MB per message; self-hosted defaults 15 MB / 100 MB, 3h lifetime).

## Failure semantics

- A failing chunk (4xx / 429 / 5xx / timeout / network error) aborts the remaining chunks. The result carries `delivered` and `failed_at`; to deliver the rest, resend the remaining body explicitly (starting after what `delivered` covered) — do not assume the rest arrived.
- Pre-validation failures (oversized `title` / `tags`, empty `body`, unknown or missing channel) send nothing and are reported in `error`.

## Troubleshooting

| Symptom (in `error`) | Cause | Action |
|---|---|---|
| `HTTP 401` / `HTTP 403` | Auth missing or wrong | Check the channel's `NTFY_<N>_TOKEN` or `USER`/`PASS` pair in the container env; the `channels` verb shows the `auth` marker. |
| `HTTP 429` | Server rate limit | Wait (ntfy.sh refills slowly; the daily quota resets at midnight UTC), then resend explicitly. |
| `HTTP 400` | Parameter semantics | The server's error text is in `error`; cross-check `delay` range, `actions` format, topic charset. |
| `HTTP 404` | Unknown topic or unreachable server path | Check `NTFY_<N>_TOPIC` and the self-hosted `NTFY_<N>_SERVER` base URL against the `channels` output. |
| `timeout after 10000 ms` | No response within 10 s | Check network egress to the server; then resend. |
| `network error (...)` | Connection failed | Check the server URL and egress; then resend. |
| `delivered < chunks` (ok=false) | Partial delivery before an aborted chunk | Resend the remaining part explicitly (the body after what `delivered` chunks covered). |
| `no channel specified ...` / `unknown channel ...` | Channel selection failed | The valid names are in the error; fix `NTFY_DEFAULT_CHANNEL` or pass `channel`. |

Security: auth material lives only in env and is never echoed in tool output, errors, or logs; `topic` is a credential — reference channels by name.
