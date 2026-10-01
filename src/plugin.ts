// dsh-ntfy — ntfy notification publishing plugin for dsh.
// Publishes messages to ntfy.sh or a self-hosted ntfy server over the NTFY_* env
// contract (channels + optional default channel). Pure publisher: no subscribing,
// no state, no tick — the plugin owns no long-lived effect and registers exactly
// three things in the constructor: the ntfy tool (send / channels verbs), the
// bundled dsh-ntfy skill, and a one-line system-prompt pointer.
import { Service, type Context } from '@deepseek-ai/cordis'
import { PLUGIN_NAME } from './util.js'
import { parseEnv } from './config.js'
import { registerTool } from './tool.js'
import { registerSkill } from './skill.js'

/**
 * dsh-ntfy plugin (class form).
 * The constructor performs synchronous initialization (logger, env parsing with
 * per-channel drop warnings, tool / skill / system-prompt section registration);
 * there is no init lifecycle step because the plugin owns no long-lived effect
 * (the three registrations are framework-tracked effects disposed with the
 * owning fiber).
 * inject = every service the plugin reads: the dsh host services tools / skills /
 * systemPrompt (dsh-tools / dsh-skill / dsh-system-prompt: ctx.tools.register /
 * ctx.skills.registerProvider / ctx.systemPrompt.section). Declaring all three
 * converts a host-missing-the-service failure from a cryptic property error into
 * the clear `cannot get required service "X"`, keeping the declaration consistent
 * with the actual read sites (same convention as dsh-timer). A declared service
 * with no implementation parks the plugin fiber (it never activates, it does not
 * throw).
 * Configuration is env-only (the NTFY_* contract), so the plugin takes no profile
 * config fields and declares no Config schema.
 */
export class DshNtfyPlugin extends Service {
  static name = PLUGIN_NAME
  static readonly inject = ['tools', 'skills', 'systemPrompt']

  constructor(ctx: Context, _config: unknown) {
    super(ctx, PLUGIN_NAME)
    const logger = ctx.logger(PLUGIN_NAME)
    const cfg = parseEnv(process.env, (msg) => logger.warn(msg))
    registerTool(ctx, cfg)
    registerSkill(ctx)
    ctx.systemPrompt.section({
      name: PLUGIN_NAME,
      order: 3000,
      text:
        'Send ntfy notifications (ntfy.sh or a self-hosted ntfy server) with the ntfy tool ' +
        '(send/channels verbs); see the dsh-ntfy skill for the parameter set, the NTFY_* env ' +
        'contract, limits, and troubleshooting.',
    })
  }
}

export default DshNtfyPlugin
