# dsh-ntfy

ntfy notification publishing plugin for DSH. Sends messages to [ntfy.sh](https://ntfy.sh) or a self-hosted ntfy server over channels declared in environment variables. Pure publisher: no subscribing, no retry, no credentials persisted.

## Installation

dsh-ntfy is an out-of-tree plugin for a dsh profile. Install it with the dsh plugin command:

```sh
dsh plugin --profile <name> add dsh-ntfy
```

Configuration is environment only (below); no files are created.

## Configuration

All configuration is environment; no files are created. One variable declares a channel; the rest are optional:

| Variable | Required | Meaning |
|---|---|---|
| `NTFY_<NAME>_TOPIC` | yes | declares channel `<name>` = the lowercased `<NAME>` (e.g. `NTFY_DASH_TOPIC` declares channel `dash`); the topic is the addressing credential, charset `[-_A-Za-z0-9]{1,64}` |
| `NTFY_<NAME>_SERVER` | no | server base URL (default `https://ntfy.sh`; any self-hosted ntfy works) |
| `NTFY_<NAME>_USER` + `NTFY_<NAME>_PASS` | no (as a pair) | Basic auth |
| `NTFY_<NAME>_TOKEN` | no | Bearer token (never combined with USER/PASS) |
| `NTFY_DEFAULT_CHANNEL` | no | name of the channel used when a send names no channel (matched case-insensitively) |

Example:

```
NTFY_DEFAULT_CHANNEL=dash
NTFY_DASH_TOPIC=dsh-alerts-Kx7pQm
```

The `<NAME>` segment of the variable name is uppercase letters and digits only, and the channel name is its lowercased form; the channel name must match `^[a-z][a-z0-9-]{0,31}$` (unlike the topic charset, it allows no underscore and no leading digit), so e.g. `NTFY_A_B_TOPIC` or `NTFY_1TOPIC` declare no channel, and a lowercase segment such as `NTFY_dash_TOPIC` matches nothing at all. Invalid channels are dropped with a warning (boot is not affected). Env changes take effect on a host restart.

## Usage

The plugin adds the `ntfy` tool (verbs `send` / `channels`) and the `dsh-ntfy` skill, which documents the full parameter set, limits, and troubleshooting. Typical calls:

```
ntfy { verb: "send", body: "deploy finished", title: "CI", priority: "high" }
ntfy { verb: "send", body: "nightly backup done", channel: "backups" }
ntfy { verb: "channels" }
```

A send always targets exactly one channel. Bodies over 4096 UTF-8 bytes are split into sequential chunks; when a chunk fails the rest are aborted and the result reports how many were delivered, so the remainder is resent explicitly.

## Limits

- ntfy.sh allows 250 messages per visitor per day; self-hosted servers set their own limits. The plugin applies no client-side rate limit.
- ntfy message limits: body 4096 bytes (the chunk size), title 1 KB, tags 512 bytes.
- Once sent, a message cannot be withdrawn (there is no update/clear/delete surface).
