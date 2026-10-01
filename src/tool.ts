// dsh-ntfy ntfy tool: two verbs (send, channels).
// The parameter schema is a strict declaration: the framework validates arguments
// against it before execute and rejects type/enum/required violations with an
// `invalid arguments` error. The priority enum is enforced here because its value
// set is closed and the server's 400 text carries no information; the remaining
// semantic rules (title/tags size budgets, the delay range, the actions format)
// belong to the ntfy server and surface as pass-through 4xx. The canonical output
// is a string (the framework renders it as one text block): the send and channels
// results are serialized JSON documents, and a missing/unknown verb is plain text,
// mirroring the dsh-timer tool's output convention.
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context, NtfyConfig, SendParams } from './types.js'
import { listChannels, send } from './send.js'
import { errMsg } from './util.js'

/** The verb set of the ntfy tool. */
export const VERBS = ['send', 'channels'] as const

/** Priority values accepted by ntfy (the closed set, checked at the tool layer). */
export const PRIORITIES = ['1', '2', '3', '4', '5', 'min', 'low', 'default', 'high', 'max'] as const

/**
 * Register the ntfy tool (two verbs: send publishes to a channel, channels lists
 * the configured channels locally).
 * @param ctx cordis Context (the host must have loaded the dsh-tools service).
 * @param cfg the parsed NTFY_* config captured at boot (env is static per container boot).
 * @returns framework effect disposer (unregisters the tool when the fiber is unloaded).
 */
export function registerTool(ctx: Context, cfg: NtfyConfig): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'ntfy',
      description:
        'Send ntfy notifications to a configured channel (ntfy.sh or a self-hosted ntfy server). ' +
        'send publishes the message body (chunked to 4096-byte pieces) with any of the ntfy publish ' +
        'parameters; the first failed chunk aborts the remaining chunks and the result reports how ' +
        'many were delivered, so the caller re-sends the remainder explicitly. ' +
        'channels lists the configured channels locally (zero network); auth is shown only as a ' +
        'basic/token/none marker. The full parameter set, the NTFY_* env contract, limits, and ' +
        'troubleshooting live in the dsh-ntfy skill.',
      parameters: {
        verb: { type: 'string', required: true, enum: VERBS, description: 'The verb to execute.' },
        body: {
          type: 'string',
          description:
            'Message body for send (required and non-empty for the send verb; ignored by channels). Bodies longer than 4096 UTF-8 bytes are split into sequential chunks (a codepoint is never split; a cut prefers the last newline); all parameters apply to every chunk. When a chunk fails the rest are aborted and the result reports how many were delivered.',
        },
        title: { type: 'string', description: 'Title (X-Title), at most 1 KB; pre-validated, the message is not sent when it exceeds the budget.' },
        priority: { type: 'string', enum: PRIORITIES, description: 'Priority (X-Priority): 1-5, min, low, default, high, or max.' },
        tags: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Tags (X-Tags) as a comma-separated string or an array (joined with commas); at most 512 bytes combined.',
        },
        click: { type: 'string', description: 'Click-through URL (X-Click).' },
        delay: { type: 'string', description: 'Delivery time (X-Delay): an RFC3339 timestamp or a duration such as 2h; the 10s-3day bound is enforced by the server.' },
        actions: { type: 'string', description: 'Action buttons (X-Actions): a JSON array or the short format; pass-through, the server validates.' },
        attach: { type: 'string', description: 'Attachment URL (X-Attach), fetched by the ntfy server (local binary upload is not supported).' },
        markdown: { type: 'boolean', description: 'Render the body as markdown (sends X-Markdown: yes when true; absent/false sends no header).' },
        icon: { type: 'string', description: 'Attachment icon URL (X-Icon).' },
        filename: { type: 'string', description: 'Attachment file name (X-Filename).' },
        email: { type: 'string', description: 'Email the notification to (X-Email): an address or "yes".' },
        call: { type: 'string', description: 'Phone number for a call alert (X-Call).' },
        cache: { type: 'boolean', description: 'Client caching (sends X-Cache: no when false; absent/true keeps caching on).' },
        firebase: { type: 'boolean', description: 'Firebase push (sends X-Firebase: no when false; absent/true keeps it on).' },
        channel: { type: 'string', description: 'Target channel name. Absent: the default channel (NTFY_DEFAULT_CHANNEL), or the sole channel when exactly one is configured.' },
      },
      output: {
        schema: { type: 'string' },
        render: (args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const verb = args?.verb
        if (verb === 'channels') {
          return JSON.stringify(listChannels(cfg))
        }
        if (verb !== 'send') {
          return verb === undefined ? `missing verb (${VERBS.join('/')})` : `unknown verb: ${String(verb)}`
        }
        const params: SendParams = { body: typeof args?.body === 'string' ? args.body : '' }
        if (typeof args?.title === 'string') params.title = args.title
        if (args?.priority !== undefined) params.priority = args.priority
        if (typeof args?.tags === 'string') params.tags = args.tags
        else if (Array.isArray(args?.tags)) params.tags = args.tags
        if (typeof args?.click === 'string') params.click = args.click
        if (typeof args?.delay === 'string') params.delay = args.delay
        if (typeof args?.actions === 'string') params.actions = args.actions
        if (typeof args?.attach === 'string') params.attach = args.attach
        if (args?.markdown === true) params.markdown = true
        if (typeof args?.icon === 'string') params.icon = args.icon
        if (typeof args?.filename === 'string') params.filename = args.filename
        if (typeof args?.email === 'string') params.email = args.email
        if (typeof args?.call === 'string') params.call = args.call
        if (args?.cache === false) params.cache = false
        if (args?.firebase === false) params.firebase = false
        if (typeof args?.channel === 'string') params.channel = args.channel
        try {
          return JSON.stringify(await send(cfg, params))
        } catch (err) {
          return JSON.stringify({ ok: false, error: `unexpected error: ${errMsg(err)}` })
        }
      },
    }),
  )
}
