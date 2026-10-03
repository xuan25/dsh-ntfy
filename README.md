# dsh-ntfy

dsh-ntfy gives a DSH agent a push-notification path: a single tool call publishes a message to an ntfy topic, so job results, alerts, and reports reach the user's device - or any app or feed that subscribes to the topic.

- Works with [ntfy.sh](https://ntfy.sh) or any self-hosted ntfy server
- Multiple topic channels; one send targets exactly one channel
- Zero state, zero files, zero runtime dependencies

## Installation

dsh-ntfy is an out-of-tree plugin for a dsh profile. Install it with the dsh plugin command:

```sh
dsh plugin --profile <name> add dsh-ntfy
```

Configuration is layered: built-in defaults, the `NTFY_*` env block, and a
cordis config layer (see below); the plugin creates no files.

## Configuration

The env block is static per process boot; env changes take effect on a host restart. One variable declares a channel, the rest are optional:

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

The `<NAME>` segment of the variable name is uppercase letters and digits only, and the channel name is its lowercased form; the channel name must match `^[a-z][a-z0-9-]{0,31}$` (unlike the topic charset, it allows no underscore and no leading digit), so e.g. `NTFY_A_B_TOPIC` or `NTFY_1TOPIC` declare no channel, and a lowercase segment such as `NTFY_dash_TOPIC` matches nothing at all. Invalid channels are dropped with a warning (boot is not affected).

### Config layer (cordis patch)

An optional config layer sits on top of the env block: a patch entry targeting the plugin id `dsh-ntfy` (the profile's `cordis.patch.yml`, the user-global `~/.dsh/cordis.patch.yml`, or a `--patch` overlay) carries a `config` object whose keys are camelCase mirrors of the env fields - `defaultChannel` and `channels` (a map of channel name to `topic`, `server`, `user`, `pass`, `token`). Every key is optional.

```yaml
- id: dsh-ntfy
  config:
    defaultChannel: dash
    channels:
      dash:
        server: https://ntfy.example.com
```

- One precedence chain: delivered value > env value > built-in default; keys the layer omits resolve as the env block, so `config: {}` (or no entry) is exactly the env-only behavior.
- A patch targets a row by id and replaces its whole config - no deep merge, so a layer that overrides one field restates the fields it keeps (layer order: the plugin's own default entry, the profile patch, the user-global patch, any `--patch` overlay).
- The layer is validated before the plugin starts: an unknown key or a topic outside the charset fails the plugin entry at load; channels the parser drops (half Basic auth pair, token together with Basic auth, an invalid topic) only warn, as in the env block, and a layer-declared channel with no topic in either layer warns as not a channel.
- With the live patch reload, editing the patch file re-runs the plugin without a restart; otherwise the change applies at the next restart.

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
