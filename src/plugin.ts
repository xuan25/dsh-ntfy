// dsh-ntfy: ntfy notification publishing plugin for dsh.
// Publishes messages to ntfy.sh or a self-hosted ntfy server over the NTFY_* env
// contract (channels + optional default channel), plus an optional config layer
// delivered by the cordis loader (a patch entry targeting this plugin's id with a
// `config` object): the delivered fields are validated against the static Config
// schema and folded onto the env record before parsing (foldConfig in config.ts).
// Pure publisher: no subscribing, no state, no tick - the plugin owns no
// long-lived effect and registers exactly three things in the constructor: the
// ntfy tool (send / channels verbs), the bundled dsh-ntfy skill, and a one-line
// system-prompt pointer.
import Schema from '@deepseek-ai/schemastery'
import { Service, type Context } from '@deepseek-ai/cordis'
import { PLUGIN_NAME } from './util.js'
import { foldConfig, CHANNEL_NAME_RE, TOPIC_RE, type DeliveredConfig } from './config.js'
import { registerTool } from './tool.js'
import { registerSkill } from './skill.js'

/** The declared per-channel fields (the camelCase mirror of the env fields). */
const CHANNEL_FIELDS = {
  topic: 'the ntfy topic (the addressing credential of the channel)',
  server: 'the server base URL (default https://ntfy.sh)',
  user: 'the Basic auth user name (with pass)',
  pass: 'the Basic auth password (with user)',
  token: 'the Bearer auth token (never combined with user/pass)',
} as const

/** The label of the per-channel schema in validation messages. */
const CHANNEL_CONFIG_LABEL = 'a channel config of dsh-ntfy'

/**
 * Wrap a schema so any object key beyond the declared set is a validation
 * failure: the framework would otherwise merge unknown keys into the
 * validated output, letting a patch-file typo (serer instead of server) pass
 * silently. The loader does not forward options into the transform callback,
 * so the error is raised with an empty option set; the message carries the
 * unknown key and the declared set.
 * @param inner the object schema to guard.
 * @param label the label used in the failure message.
 */
function rejectUnknownKeys(inner: Schema, label: string): Schema {
  const declared = inner.dict ? Object.keys(inner.dict) : []
  const declaredSet = new Set(declared)
  return Schema.transform(inner, (value) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!declaredSet.has(key)) {
          throw new Schema.ValidationError(
            `unknown key "${key}" in ${label} (known keys: ${declared.join(', ')})`,
            {},
          )
        }
      }
    }
    return value
  })
}

/** One channel of the config layer (the camelCase mirror of the env fields). */
const CHANNEL_CONFIG = rejectUnknownKeys(
  Schema.object({
    topic: Schema.string().pattern(TOPIC_RE).description(CHANNEL_FIELDS.topic),
    server: Schema.string().description(CHANNEL_FIELDS.server),
    user: Schema.string().description(CHANNEL_FIELDS.user),
    pass: Schema.string().description(CHANNEL_FIELDS.pass),
    token: Schema.string().description(CHANNEL_FIELDS.token),
  }),
  CHANNEL_CONFIG_LABEL,
)

/**
 * dsh-ntfy plugin (class form).
 * The constructor performs synchronous initialization (logger, resolution of
 * the delivered config layer onto the NTFY_* env contract with per-channel
 * drop warnings, tool / skill / system-prompt section registration); there is
 * no init lifecycle step because the plugin owns no long-lived effect (the
 * three registrations are framework-tracked effects disposed with the owning
 * fiber).
 * inject = every service the plugin reads: the dsh host services tools / skills /
 * systemPrompt (dsh-tools / dsh-skill / dsh-system-prompt: ctx.tools.register /
 * ctx.skills.registerProvider / ctx.systemPrompt.section). Declaring all three
 * converts a host-missing-the-service failure from a cryptic property error into
 * the clear `cannot get required service "X"`, keeping the declaration consistent
 * with the actual read sites (same convention as dsh-timer). A declared service
 * with no implementation parks the plugin fiber (it never activates, it does not
 * throw).
 * The static Config schema validates the delivered config layer before the
 * constructor runs (a violation fails the entry loudly); the constructor folds
 * it onto the env record through the existing parser (foldConfig): a delivered
 * field is an explicit value (config value beats env value beats the built-in
 * default), fields the layer omits resolve as the env contract. Layer
 * composition (which patch layer wins, no deep merge) is cordis semantics; the
 * plugin tracks no provenance.
 */
export class DshNtfyPlugin extends Service {
  static name = PLUGIN_NAME
  static readonly inject = ['tools', 'skills', 'systemPrompt']
  static readonly Config = rejectUnknownKeys(
    Schema.object({
      defaultChannel: Schema.string().description('the channel used when a send names no channel'),
      channels: Schema.dict(CHANNEL_CONFIG, Schema.string().pattern(CHANNEL_NAME_RE).description('the channel name')),
    }),
    'the dsh-ntfy config',
  )

  constructor(ctx: Context, config: DeliveredConfig | undefined) {
    super(ctx, PLUGIN_NAME)
    const logger = ctx.logger(PLUGIN_NAME)
    const cfg = foldConfig(process.env, config, (msg) => logger.warn(msg))
    registerTool(ctx, cfg)
    registerSkill(ctx)
    ctx.systemPrompt.section({
      name: PLUGIN_NAME,
      order: 3000,
      text:
        'Send ntfy notifications (ntfy.sh or a self-hosted ntfy server) with the ntfy tool; ' +
        'see the dsh-ntfy skill for the parameter set, the NTFY_* env contract, limits, and ' +
        'troubleshooting.',
    })
  }
}

export default DshNtfyPlugin
