// dsh-ntfy selftest: behavioral assertions against the compiled lib/ output.
// Run: node --test test/ (or node test/selftest.mjs). All green = exit code 0.
// No external network: an in-process HTTP endpoint on 127.0.0.1 stands in for the
// ntfy server, and a scoped fetch stub stands in for the 10s timeout path (a real
// timeout would cost ten seconds of wall time per test run).
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CJK_RE = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
let passed = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) passed++
  else failures.push(`${name}${extra ? ` - ${extra}` : ''}`)
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}
function utf8Bytes(s) {
  let n = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  return n
}

const { DshNtfyPlugin } = await import(path.join(PKG, 'lib', 'index.js'))
const { parseEnv, resolveChannel, foldConfig, TOPIC_RE, CHANNEL_NAME_RE, DEFAULT_SERVER } = await import(path.join(PKG, 'lib', 'config.js'))
const { chunkUtf8 } = await import(path.join(PKG, 'lib', 'chunk.js'))
const { send, listChannels, buildHeaders, SEND_TIMEOUT_MS } = await import(path.join(PKG, 'lib', 'send.js'))
const { registerTool, VERBS, PRIORITIES } = await import(path.join(PKG, 'lib', 'tool.js'))
const { registerSkill } = await import(path.join(PKG, 'lib', 'skill.js'))
const { PLUGIN_NAME } = await import(path.join(PKG, 'lib', 'util.js'))

// in-process ntfy stand-in: records every request (url, method, headers, body)
// and answers through a per-test handler.
const seen = []
// `seen` is pushed before the handler runs, so `seen.length` is the 1-based index
// of the request being answered.
const defaultHandler = (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ id: `id-${seen.length}`, time: 1 }))
}
let handler = defaultHandler
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    seen.push({ url: req.url, method: req.method, headers: req.headers, body })
    handler(req, res)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const LOCAL = `http://127.0.0.1:${PORT}`

function cfgOf(env) {
  const warns = []
  return { cfg: parseEnv(env, (m) => warns.push(m)), warns }
}
const singleLocal = cfgOf({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }).cfg

// ── constants & charset ──────────────────────────────────────────
eq('PLUGIN_NAME', PLUGIN_NAME, 'dsh-ntfy')
eq('VERBS', VERBS, ['send', 'channels'])
eq('PRIORITIES', PRIORITIES, ['1', '2', '3', '4', '5', 'min', 'low', 'default', 'high', 'max'])
eq('DEFAULT_SERVER', DEFAULT_SERVER, 'https://ntfy.sh')
eq('SEND_TIMEOUT_MS', SEND_TIMEOUT_MS, 10_000)
ok('TOPIC_RE valid', TOPIC_RE.test('a') && TOPIC_RE.test('A_b-9') && TOPIC_RE.test('x'.repeat(64)))
ok('TOPIC_RE invalid', !TOPIC_RE.test('') && !TOPIC_RE.test('has space') && !TOPIC_RE.test('dot.') && !TOPIC_RE.test('x'.repeat(65)))
ok('CHANNEL_NAME_RE valid', CHANNEL_NAME_RE.test('a') && CHANNEL_NAME_RE.test('a-b-1') && CHANNEL_NAME_RE.test('a'.repeat(32)))
ok('CHANNEL_NAME_RE invalid', !CHANNEL_NAME_RE.test('') && !CHANNEL_NAME_RE.test('1abc') && !CHANNEL_NAME_RE.test('-abc') && !CHANNEL_NAME_RE.test('a_b') && !CHANNEL_NAME_RE.test('a'.repeat(33)))

// ── config parsing matrix ────────────────────────────────────────
{
  const { cfg, warns } = cfgOf({
    NTFY_OK_TOPIC: 'ok-topic-1',
    NTFY_SPACETOPIC_TOPIC: 'bad topic',
    NTFY_LONGTOPIC_TOPIC: 'x'.repeat(65),
    NTFY_EMPTYTOPIC_TOPIC: '',
    NTFY_HALF_TOPIC: 'half-topic',
    NTFY_HALF_USER: 'only-user',
    NTFY_AMB_TOPIC: 'amb-topic',
    NTFY_AMB_USER: 'u',
    NTFY_AMB_PASS: 'p',
    NTFY_AMB_TOKEN: 'tk_x',
    NTFY_BASIC_TOPIC: 'basic-topic',
    NTFY_BASIC_USER: 'alice',
    NTFY_BASIC_PASS: 'secret-pass',
    NTFY_TOK_TOPIC: 'tok-topic',
    NTFY_TOK_TOKEN: 'tk_token',
    NTFY_CUSTOM_TOPIC: 'custom-topic',
    NTFY_CUSTOM_SERVER: 'https://ntfy.example.com/',
    NTFY_DEFAULT_CHANNEL: 'OK',
  })
  eq('parse: valid channel names sorted', cfg.channels.map((c) => c.name), ['basic', 'custom', 'ok', 'tok'])
  eq('parse: default server applied', cfg.channels.find((c) => c.name === 'ok').server, 'https://ntfy.sh')
  eq('parse: custom server kept verbatim', cfg.channels.find((c) => c.name === 'custom').server, 'https://ntfy.example.com/')
  eq('parse: default name stored raw', cfg.defaultName, 'OK')
  eq('parse: isDefault marks case-insensitive match', cfg.channels.find((c) => c.name === 'ok').isDefault, true)
  const basic = cfg.channels.find((c) => c.name === 'basic')
  eq('parse: basic auth pair', [basic.auth.kind, basic.auth.user, basic.auth.pass], ['basic', 'alice', 'secret-pass'])
  eq('parse: token auth', [cfg.channels.find((c) => c.name === 'tok').auth.kind, cfg.channels.find((c) => c.name === 'tok').auth.token], ['token', 'tk_token'])
  eq('parse: anonymous auth null', cfg.channels.find((c) => c.name === 'ok').auth, null)
  eq('parse: five drops warned', warns.length, 5)
  ok('parse: drop reasons named', warns.some((w) => w.includes('spacetopic')) && warns.some((w) => w.includes('longtopic')) && warns.some((w) => w.includes('emptytopic')) && warns.some((w) => w.includes('half')) && warns.some((w) => w.includes('amb')))
  ok('parse: warnings carry channel name only, no auth material', warns.every((w) => !w.includes('secret-pass') && !w.includes('tk_x') && !w.includes('alice')))
}
{
  const { cfg } = cfgOf({})
  eq('parse: zero channels', cfg.channels.length, 0)
  eq('parse: no default', cfg.defaultName, null)
}
{
  const { cfg } = cfgOf({ NTFY_X_TOPIC: 'x', NTFY_DEFAULT_CHANNEL: 'gone' })
  eq('parse: stale default stored raw', [cfg.defaultName, cfg.channels.map((c) => c.isDefault)], ['gone', [false]])
}
{
  const { cfg, warns } = cfgOf({ NTFY_1DIGIT_TOPIC: 'digit-topic' })
  eq('parse: digit-led name dropped', cfg.channels.length, 0)
  ok('parse: digit-led drop warned', warns.length === 1 && warns[0].includes('1digit'))
}
{
  // The variable-name grammar is uppercase + digits only: a lowercase segment or
  // an underscore segment matches NTFY_<NAME>_TOPIC not at all (no channel, no
  // warning) — distinct from a match that the channel name charset drops.
  const { cfg, warns } = cfgOf({ NTFY_dash_TOPIC: 'topic-a', NTFY_A_B_TOPIC: 'topic-b' })
  eq('parse: lowercase/underscore env segments declare no channel', [cfg.channels.length, warns.length], [0, 0])
}
{
  const { cfg } = cfgOf({ NTFY_A_TOPIC: 'a', NTFY_B_TOPIC: 'b', NTFY_C_TOPIC: 'c' })
  eq('parse: multi-channel sorted', cfg.channels.map((c) => c.name), ['a', 'b', 'c'])
}

// ── channel resolution chain ─────────────────────────────────────
{
  const { cfg } = cfgOf({ NTFY_A_TOPIC: 'a', NTFY_B_TOPIC: 'b', NTFY_DEFAULT_CHANNEL: 'B' })
  eq('resolve: explicit hit', resolveChannel(cfg, 'a').channel.name, 'a')
  eq('resolve: explicit miss error lists valid', resolveChannel(cfg, 'zz').error, 'unknown channel "zz" (valid channels: a, b)')
  eq('resolve: default valid', resolveChannel(cfg).channel.name, 'b')
}
{
  const { cfg } = cfgOf({ NTFY_A_TOPIC: 'a', NTFY_B_TOPIC: 'b' })
  ok('resolve: no default, multiple channels', 'error' in resolveChannel(cfg))
  ok('resolve: error names the valid set', resolveChannel(cfg).error.includes('a, b'))
}
{
  const { cfg } = cfgOf({ NTFY_A_TOPIC: 'a' })
  eq('resolve: sole channel implicit', resolveChannel(cfg).channel.name, 'a')
}
{
  const { cfg } = cfgOf({ NTFY_A_TOPIC: 'a', NTFY_DEFAULT_CHANNEL: 'gone' })
  ok('resolve: stale default + multiple would error; stale + single falls to sole channel', resolveChannel(cfg).channel.name === 'a')
}
{
  const { cfg } = cfgOf({})
  ok('resolve: zero channels errors', 'error' in resolveChannel(cfg))
  ok('resolve: zero-channels error text', resolveChannel(cfg).error.includes('no channel specified and no default channel configured'))
}

// ── chunking ─────────────────────────────────────────────────────
eq('chunk: empty body', chunkUtf8(''), [])
eq('chunk: short single', chunkUtf8('hello'), ['hello'])
eq('chunk: exact budget single', chunkUtf8('a'.repeat(4096)).length, 1)
{
  const c = chunkUtf8('a'.repeat(4097))
  eq('chunk: one over budget splits', c.length, 2)
  eq('chunk: first part at budget', utf8Bytes(c[0]), 4096)
  eq('chunk: parts reconstruct', c.join(''), 'a'.repeat(4097))
}
{
  // 3-byte codepoints (CJK ideographs, written as escapes to keep this file ASCII).
  const c = chunkUtf8('\u4e2d'.repeat(1365) + '\u6587') // 4095 B + 3 B
  eq('chunk: 3-byte codepoint boundary', c.length, 2)
  eq('chunk: 3-byte first part 4095 B', utf8Bytes(c[0]), 4095)
  eq('chunk: 3-byte second part 3 B', utf8Bytes(c[1]), 3)
  eq('chunk: 3-byte reconstruct', c.join(''), '\u4e2d'.repeat(1365) + '\u6587')
}
{
  const c = chunkUtf8('\u{1F600}'.repeat(1024)) // exactly 4096 B
  eq('chunk: 4-byte codepoints exact', c.length, 1)
  const c2 = chunkUtf8('\u{1F600}'.repeat(1025))
  eq('chunk: 4-byte codepoints split', [c2.length, utf8Bytes(c2[0]), utf8Bytes(c2[1])], [2, 4096, 4])
}
eq('chunk: newline preferred inside window', chunkUtf8('aaaa\nbbbb\ncccc', 10), ['aaaa\nbbbb\n', 'cccc'])
eq('chunk: no newline boundary cut', chunkUtf8('abcdef', 4), ['abcd', 'ef'])
eq('chunk: leading newline not used as cut', chunkUtf8('x\nyyyyyyyyy', 5), ['x\n', 'yyyyy', 'yyyy'])
eq('chunk: all newlines', chunkUtf8('\n\n\n'), ['\n\n\n'])
{
  const body = 'ab\ncd\n'.repeat(500) // 2000 B, 1000 codepoints
  const c = chunkUtf8(body)
  ok('chunk: multi-chunk all under budget', c.every((p) => utf8Bytes(p) <= 4096))
  eq('chunk: multi-chunk reconstruct', c.join(''), body)
}

// ── pre-validation ───────────────────────────────────────────────
{
  const r = await send(singleLocal, { body: 'x', title: 't'.repeat(1025) })
  ok('pre: title over 1 KB not sent', r.ok === false && r.error.includes('title exceeds 1 KB') && r.delivered === 0)
  eq('pre: nothing reached the endpoint', seen.length, 0)
}
{
  const r = await send(singleLocal, { body: 'x', title: 't'.repeat(1024) })
  ok('pre: title at 1 KB passes', r.ok === true)
  seen.length = 0
}
{
  const r = await send(singleLocal, { body: 'x', tags: 'a'.repeat(513) })
  ok('pre: tags over 512 B not sent', r.ok === false && r.error.includes('tags exceed 512 bytes'))
}
{
  const r = await send(singleLocal, { body: 'x', tags: Array.from({ length: 257 }, (_, i) => i === 0 ? 'aa' : 'a') }) // 513 chars
  ok('pre: tags array combined measured', r.ok === false && r.error.includes('tags exceed 512 bytes'))
}
{
  const r = await send(singleLocal, { body: 'x', tags: 'a'.repeat(512) })
  ok('pre: tags at 512 B pass', r.ok === true)
  seen.length = 0
}
{
  const r = await send(singleLocal, { body: '   ' })
  ok('pre: whitespace-only body rejected', r.ok === false && r.error.includes('body is required'))
}
{
  const r = await send(singleLocal, { body: '', title: 't' })
  ok('pre: empty body rejected even with title', r.ok === false && r.error.includes('body is required'))
}

// ── request shape & parameter mapping ────────────────────────────
async function hit(env, params) {
  seen.length = 0
  const { cfg } = cfgOf(env)
  const r = await send(cfg, params)
  return { r, req: seen[0] }
}
{
  const { r, req } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { body: 'hello' })
  eq('shape: result ok', [r.ok, r.channel, r.chunks, r.delivered], [true, 'a', 1, 1])
  eq('shape: ids from response json', r.ids, ['id-1'])
  eq('shape: url', [req.url, req.method], ['/topic-a', 'POST'])
  eq('shape: content-type', req.headers['content-type'], 'text/plain; charset=utf-8')
  ok('shape: no optional headers', !('x-title' in req.headers) && !('authorization' in req.headers) && !('x-priority' in req.headers))
  eq('shape: body', req.body, 'hello')
}
{
  const { req } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: `${LOCAL}/` }, { body: 'x' }) // trailing-slash normalization case
  eq('shape: trailing slash normalized', req.url, '/topic-a')
}
{
  const { req } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: `${LOCAL}///` }, { body: 'x' })
  eq('shape: multiple trailing slashes normalized', req.url, '/topic-a')
}
{
  const { req } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL, NTFY_A_USER: 'alice', NTFY_A_PASS: 'päss' }, { body: 'x' })
  eq('shape: basic authorization', req.headers.authorization, `Basic ${Buffer.from('alice:päss', 'utf8').toString('base64')}`)
}
{
  const { req } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL, NTFY_A_TOKEN: 'tk_abc' }, { body: 'x' })
  eq('shape: bearer authorization', req.headers.authorization, 'Bearer tk_abc')
}
{
  const { req } = await hit(
    { NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL },
    {
      body: 'body',
      title: 'Title',
      priority: 'high',
      tags: ['a', 'b', 'c'],
      click: 'https://click.example',
      delay: '2h',
      actions: 'Hi,{{Hi,https://a.example}}',
      attach: 'https://attach.example/f.bin',
      markdown: true,
      icon: 'https://icon.example/i.png',
      filename: 'f.bin',
      email: 'me@example.com',
      call: '+15551234567',
      cache: false,
      firebase: false,
    },
  )
  eq('map: all headers present', [
    req.headers['x-title'], req.headers['x-priority'], req.headers['x-tags'], req.headers['x-click'],
    req.headers['x-delay'], req.headers['x-actions'], req.headers['x-attach'], req.headers['x-markdown'],
    req.headers['x-icon'], req.headers['x-filename'], req.headers['x-email'], req.headers['x-call'],
    req.headers['x-cache'], req.headers['x-firebase'],
  ], [
    'Title', 'high', 'a,b,c', 'https://click.example', '2h', 'Hi,{{Hi,https://a.example}}',
    'https://attach.example/f.bin', 'yes', 'https://icon.example/i.png', 'f.bin', 'me@example.com',
    '+15551234567', 'no', 'no',
  ])
}
{
  const { req } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { body: 'x', markdown: false, cache: true, firebase: true })
  ok('map: booleans false/true send nothing', !('x-markdown' in req.headers) && !('x-cache' in req.headers) && !('x-firebase' in req.headers))
}
{
  const h = buildHeaders({ body: 'x' })
  eq('map: absent params contribute no header', Object.keys(h), ['Content-Type'])
  eq('map: tags string passthrough', buildHeaders({ body: 'x', tags: 'a,b' })['X-Tags'], 'a,b')
}

// ── RFC 2047 header pre-encoding ─────────────────────────────────
// Built-in HTTP clients only accept Latin-1 header value characters; values
// that go beyond are wrapped as a single base64 encoded-word, which the ntfy
// server decodes back to the original text. (Test titles use unicode escapes
// so this file stays pure ASCII.)
{
  const cjk = '\u9a8c\u6536' // a two-character title outside Latin-1
  const word = (v) => `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`
  eq('enc: non-latin1 title wrapped as one base64 encoded-word', buildHeaders({ body: 'x', title: cjk })['X-Title'], word(cjk))
  eq('enc: latin1 title sent verbatim', buildHeaders({ body: 'x', title: 'caf\u00e9' })['X-Title'], 'caf\u00e9')
  eq('enc: mixed value encodes the whole value', buildHeaders({ body: 'x', title: `a ${cjk}` })['X-Title'], word(`a ${cjk}`))
  eq('enc: non-latin1 tags wrapped too', buildHeaders({ body: 'x', tags: cjk })['X-Tags'], word(cjk))
  eq('enc: non-latin1 click wrapped too', buildHeaders({ body: 'x', click: cjk })['X-Click'], word(cjk))
  const { req } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { body: 'x', title: cjk })
  eq('enc: e2e wire header carries the encoded word verbatim', req.headers['x-title'], word(cjk))
}

// ── multi-chunk end to end ───────────────────────────────────────
{
  const body = 'a'.repeat(9000) // 3 chunks: 4096 + 4096 + 808
  seen.length = 0
  const { r, req } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { body, title: 'T', markdown: true })
  eq('e2e: result', [r.ok, r.chunks, r.delivered], [true, 3, 3])
  eq('e2e: three requests', seen.length, 3)
  ok('e2e: every request at budget', seen.every((q) => utf8Bytes(q.body) <= 4096))
  eq('e2e: bodies reconstruct', seen.map((q) => q.body).join(''), body)
  eq('e2e: sizes', seen.map((q) => utf8Bytes(q.body)), [4096, 4096, 808])
  ok('e2e: headers repeat on every chunk', seen.every((q) => q.headers['x-title'] === 'T' && q.headers['x-markdown'] === 'yes' && q.url === '/topic-a'))
  void req
}

// ── response parsing & failure surfaces ──────────────────────────
{
  handler = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 123 })) }
  seen.length = 0
  const { r } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { body: 'x' })
  ok('resp: non-string id demoted to null', r.ok === true && r.ids[0] === null)
  seen.length = 0
}
{
  handler = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not json') }
  seen.length = 0
  const { r } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { body: 'x' })
  ok('resp: unparseable body still success', r.ok === true && r.ids[0] === null)
  seen.length = 0
}
for (const [status, label] of [[400, 'bad delay'], [401, 'auth failed'], [403, 'forbidden'], [404, 'unknown topic'], [429, 'rate limited'], [500, 'boom']]) {
  handler = (req, res) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(label) }
  seen.length = 0
  const { r } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { body: 'x' })
  ok(`resp: HTTP ${status} surfaced with server text`, r.ok === false && r.error.includes(`HTTP ${status}`) && r.error.includes(label) && r.failed_at === 1 && r.delivered === 0)
  seen.length = 0
}
{
  // The client's connection-failure text names the target; a scoped fetch stub
  // supplies that text without any real network. The scrub must replace every
  // occurrence with a label, so no target address reaches the reported error.
  const realFetch = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error(`connect ECONNREFUSED ${LOCAL} (carrier)`))
  const { r } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { body: 'x' })
  globalThis.fetch = realFetch
  ok(
    'resp: network error surfaced with the target stripped to a label',
    r.ok === false &&
      r.error.startsWith('chunk 1 failed: network error') &&
      r.error.includes('[server]') &&
      !r.error.includes('127.0.0.1') &&
      !r.error.includes('topic-a'),
  )
}
{
  // The client reports the total-time budget expiry as an abort/timeout error;
  // exercise the classification without waiting out the real bound.
  const realFetch = globalThis.fetch
  globalThis.fetch = () => {
    const e = new Error('The operation was aborted due to timeout')
    e.name = 'TimeoutError'
    return Promise.reject(e)
  }
  const { r } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { body: 'x' })
  globalThis.fetch = realFetch
  ok(
    'resp: timeout classified from the abort name',
    r.ok === false && r.error.includes(`timeout after ${SEND_TIMEOUT_MS} ms`) && r.failed_at === 1 && r.delivered === 0,
  )
}

// ── abort semantics (first failure stops the rest) ───────────────
{
  handler = (req, res) => {
    if (seen.length === 2) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('boom')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'ok' }))
    }
  }
  seen.length = 0
  const { r } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { body: 'a'.repeat(9000) })
  eq('abort: result', [r.ok, r.chunks, r.delivered, r.failed_at], [false, 3, 1, 2])
  ok('abort: error carries the server text', r.error.includes('HTTP 500') && r.error.includes('boom'))
  eq('abort: third chunk never sent', seen.length, 2)
  seen.length = 0
}
{
  handler = (req, res) => { res.writeHead(429, { 'content-type': 'text/plain' }); res.end('rate limited') }
  seen.length = 0
  const { r } = await hit({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { body: 'a'.repeat(9000) })
  eq('abort: 429 on first chunk', [r.ok, r.delivered, r.failed_at, seen.length], [false, 0, 1, 1])
  seen.length = 0
}

// ── sanitization: auth material and urls never leak ──────────────
{
  handler = (req, res) => { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('auth failed') }
  const { cfg } = cfgOf({
    NTFY_SEC_TOPIC: 'sekrit-topic',
    NTFY_SEC_SERVER: LOCAL,
    NTFY_SEC_USER: 'supersecretuser',
    NTFY_SEC_PASS: 'topsecretpass',
  })
  const { r } = await hit({ NTFY_SEC_TOPIC: 'sekrit-topic', NTFY_SEC_SERVER: LOCAL, NTFY_SEC_USER: 'supersecretuser', NTFY_SEC_PASS: 'topsecretpass' }, { body: 'x' })
  const blob = JSON.stringify(r)
  ok('sanitize: no user in result', !blob.includes('supersecretuser'))
  ok('sanitize: no pass in result', !blob.includes('topsecretpass'))
  ok('sanitize: no topic in result', !blob.includes('sekrit-topic'))
  ok('sanitize: no host in result', !blob.includes(String(PORT)))
  const view = JSON.stringify(listChannels(cfg))
  ok('sanitize: channels view shows marker only', view.includes('"basic"') && !view.includes('supersecretuser') && !view.includes('topsecretpass'))
}
{
  const { cfg, warns } = cfgOf({
    NTFY_SEC_TOPIC: 'sekrit-topic',
    NTFY_SEC_USER: 'u',
    NTFY_SEC_TOKEN: 'tk_topsecret',
  })
  ok('sanitize: drop warning names the channel only', warns.length === 1 && warns[0].includes('sec') && !warns[0].includes('tk_topsecret') && !warns[0].includes('sekrit-topic'))
  eq('sanitize: ambiguous channel absent from listing', listChannels(cfg).channels.length, 0)
}

// ── tool verbs (direct execute calls; the framework relays results) ──
function fakeCtx() {
  const state = { tools: [], providers: [], sections: [], provided: [], warns: [] }
  const ctx = {
    reflect: { provide: (name) => { state.provided.push(name) } },
    logger: () => ({ warn: (m) => state.warns.push(m), error() { }, info() { }, debug() { } }),
    tools: { register: (t) => { state.tools.push(t); return () => { } } },
    skills: { registerProvider: (p) => { state.providers.push(p); return () => { } } },
    systemPrompt: { section: (s) => { state.sections.push(s); return () => { } } },
  }
  return { ctx, state }
}
{
  const { ctx, state } = fakeCtx()
  const tool = registerTool(ctx, cfgOf({ NTFY_A_TOPIC: 'a', NTFY_B_TOPIC: 'b', NTFY_DEFAULT_CHANNEL: 'B', NTFY_A_SERVER: LOCAL, NTFY_B_SERVER: LOCAL }).cfg)
  eq('tool: one registered', state.tools.length, 1)
  const t = state.tools[0]
  eq('tool: name', t.name, 'ntfy')
  eq('tool: schema verb enum', t.parameters.properties?.verb?.enum, ['send', 'channels'])
  eq('tool: schema requires only verb (body is enforced for the send verb at execute time)', t.parameters.required, ['verb'])
  eq('tool: schema priority enum closed', t.parameters.properties?.priority?.enum, PRIORITIES)
  ok('tool: schema tags oneOf string|array', JSON.stringify(t.parameters.properties?.tags).includes('oneOf'))
  ok('tool: output renders a text string', t.output.schema.type === 'string' && typeof t.execute === 'function')
  eq('tool: disposer type', typeof tool, 'function')

  handler = defaultHandler
  seen.length = 0
  const out = JSON.parse(await t.execute({ verb: 'channels' }))
  eq('tool: channels verb', [out.default, out.channels.map((c) => c.name), out.channels.find((c) => c.name === 'b').isDefault, out.channels.find((c) => c.name === 'a').auth], ['b', ['a', 'b'], true, 'none'])

  const e1 = JSON.parse(await t.execute({ verb: 'send', body: 'x', channel: 'zz' }))
  ok('tool: unknown channel error lists valid', e1.ok === false && e1.error.includes('valid channels: a, b') && e1.channel === 'zz')
  let threw2 = null
  try {
    await t.execute({})
  } catch (e) {
    threw2 = e
  }
  ok('tool: framework rejects a missing verb before execute', threw2 !== null && String(threw2.message).includes('verb'))
  let threw3 = null
  try {
    await t.execute({ verb: 'explode' })
  } catch (e) {
    threw3 = e
  }
  ok('tool: framework rejects an unknown verb enum before execute', threw3 !== null && String(threw3.message).includes('verb'))
  const e4 = JSON.parse(await t.execute({ verb: 'send', body: 'x', channel: 'a' }))
  ok('tool: send through the local endpoint', e4.ok === true && e4.delivered === 1)
  seen.length = 0
}
{
  const { ctx, state } = fakeCtx()
  registerTool(ctx, cfgOf({}).cfg)
  const e1 = JSON.parse(await state.tools[0].execute({ verb: 'send', body: 'x' }))
  ok('tool: zero channels errors', e1.ok === false && e1.error.includes('no channel specified and no default channel configured'))
  const e2 = JSON.parse(await state.tools[0].execute({ verb: 'channels' }))
  eq('tool: zero channels listing', [e2.default, e2.channels.length], [null, 0])
}
{
  const { ctx, state } = fakeCtx()
  const { cfg } = cfgOf({
    NTFY_STALE_TOPIC: 'stale-topic',
    NTFY_STALE_SERVER: LOCAL,
    NTFY_EXTRA_TOPIC: 'extra-topic',
    NTFY_EXTRA_SERVER: LOCAL,
    NTFY_DEFAULT_CHANNEL: 'gone',
  })
  registerTool(ctx, cfg)
  const out = JSON.parse(await state.tools[0].execute({ verb: 'channels' }))
  eq('tool: stale default shown as null', out.default, null)
  eq('tool: both channels still listed', out.channels.map((c) => [c.name, c.isDefault]), [['extra', false], ['stale', false]])
  const e = JSON.parse(await state.tools[0].execute({ verb: 'send', body: 'x' }))
  ok('tool: stale default without a sole channel errors', e.ok === false && e.error.includes('no channel specified'))
}

// ── plugin assembly (fake ctx, real registrations) ───────────────
{
  const { ctx, state } = fakeCtx()
  const plugin = new DshNtfyPlugin(ctx, {})
  eq('plugin: service name', plugin.name, 'dsh-ntfy')
  eq('plugin: static name', DshNtfyPlugin.name, 'dsh-ntfy')
  eq('plugin: inject set', DshNtfyPlugin.inject, ['tools', 'skills', 'systemPrompt'])
  eq('plugin: registered on ctx', state.provided, ['dsh-ntfy'])
  eq('plugin: one tool named ntfy', [state.tools.length, state.tools[0].name], [1, 'ntfy'])
  eq('plugin: one prompt section', state.sections.length, 1)
  ok('plugin: prompt section is a single line', state.sections[0].text.length > 0 && !state.sections[0].text.includes('\n'))
  ok('plugin: prompt section names tool and skill', state.sections[0].text.includes('ntfy tool') && state.sections[0].text.includes('dsh-ntfy skill'))
  eq('plugin: one skill provider', state.providers.length, 1)
  const provider = state.providers[0]()
  eq('plugin: provider name', provider.name, 'dsh-ntfy')
  const [cand] = await provider.list()
  ok('plugin: candidate metadata', cand.name === 'dsh-ntfy' && cand.source === 'bundled' && typeof cand.description === 'string' && cand.description.length > 0 && cand.invocation.modelInvocable === true && cand.invocation.userInvocable === true)
  const got = await provider.get(cand)
  ok('plugin: skill body served', typeof got.content === 'string' && got.content.length > 500)
  ok('plugin: frontmatter stripped from body', !got.content.startsWith('---') && !got.content.includes('whenToUse'))
  ok('plugin: body keeps the sections', got.content.includes('Quick reference') && got.content.includes('Parameter set') && got.content.includes('Env contract') && got.content.includes('Troubleshooting'))
}
{
  const { ctx, state } = fakeCtx()
  new DshNtfyPlugin(ctx, {})
  let want = 0
  parseEnv(process.env, () => { want += 1 })
  eq('plugin: boot warnings mirror parseEnv of the real env', state.warns.length, want)
}
{
  // fail-fast on a malformed frontmatter: swap in a broken file, expect the
  // throw, restore the shipped file in all paths.
  const skillPath = path.join(PKG, 'skill', 'dsh-ntfy', 'SKILL.md')
  const original = readFileSync(skillPath, 'utf8')
  const { ctx, state } = fakeCtx()
  try {
    writeFileSync(skillPath, '---\nname: other-skill\ndescription: "x"\n---\nbody\n')
    let threw = null
    try {
      registerSkill(ctx)
    } catch (e) {
      threw = e
    }
    ok('skill: frontmatter name mismatch throws at registration', threw !== null && String(threw.message).includes('other-skill'))
    writeFileSync(skillPath, '---\nname: dsh-ntfy\ndescription: : : broken\n')
    let threw2 = null
    try {
      registerSkill(ctx)
    } catch (e) {
      threw2 = e
    }
    ok('skill: unclosed frontmatter throws at registration', threw2 !== null && String(threw2.message).includes('unclosed'))
    writeFileSync(skillPath, 'no frontmatter here\n')
    let threw3 = null
    try {
      registerSkill(ctx)
    } catch (e) {
      threw3 = e
    }
    ok('skill: missing frontmatter throws at registration', threw3 !== null && String(threw3.message).includes('missing YAML frontmatter'))
    eq('skill: no provider registered on failure', state.providers.length, 0)
  } finally {
    writeFileSync(skillPath, original)
  }
  ok('skill: shipped file restored byte-identical', readFileSync(skillPath, 'utf8') === original)
}

// ── delivered config layer: schema validation + fold semantics ──
{
  // the schema: accept matrix (the layer is a camelCase mirror of the env)
  const validate = (x) => DshNtfyPlugin.Config['~standard'].validate(x)
  const issues = (x) => (validate(x).issues ?? []).map((i) => i.message)
  const noIssues = (x) => validate(x).issues === undefined

  ok('cfgschema: an empty layer passes', noIssues({}))
  ok('cfgschema: absent layers pass (undefined and null, the env-only behavior)', noIssues(undefined) && noIssues(null))
  ok('cfgschema: the full mirror passes', noIssues({
    defaultChannel: 'dash',
    channels: {
      dash: { topic: 'dash-topic', server: 'https://ntfy.example.com', user: 'u', pass: 'p', token: 't' },
      'other-1': { topic: 'x'.repeat(64) },
    },
  }))
  ok('cfgschema: a sparse layer passes (every channel key optional)', noIssues({ channels: { dash: { server: 'https://x' } } }))
  ok('cfgschema: a mixed-case topic in the charset passes (the charset includes upper and lower letters)', noIssues({ channels: { a: { topic: 'Abc_9' } } }))
  const v = validate({ defaultChannel: 'dash', channels: { dash: { server: 'https://x' } } })
  ok('cfgschema: the validated value keeps the carried fields verbatim', v.value.defaultChannel === 'dash' && v.value.channels.dash.server === 'https://x' && Object.keys(v.value.channels).join() === 'dash', v.value)

  // the schema: reject matrix (each violation fails the entry loudly)
  ok('cfgschema: an unknown root key fails (typo guard)', issues({ bogus: 1 }).some((m) => m.includes('unknown key "bogus"') && m.includes('defaultChannel')))
  ok('cfgschema: an unknown channel key fails (typo guard)', issues({ channels: { dash: { serer: 'x' } } }).some((m) => m.includes('unknown key "serer"') && m.includes('topic')))
  ok('cfgschema: a channel name outside the charset fails', issues({ channels: { 'Bad_Name': {} } }).length === 1 && issues({ channels: { '9x': {} } }).length === 1)
  ok('cfgschema: a channel name over 32 characters fails', issues({ channels: { ['a'.repeat(33)]: {} } }).length === 1)
  ok('cfgschema: an empty topic fails', issues({ channels: { a: { topic: '' } } }).length === 1)
  ok('cfgschema: a topic outside the charset fails', issues({ channels: { a: { topic: 'has space' } } }).length === 1 && issues({ channels: { a: { topic: 'dot.' } } }).length === 1)
  ok('cfgschema: a topic over 64 characters fails', issues({ channels: { a: { topic: 'x'.repeat(65) } } }).length === 1)
  ok('cfgschema: a non-string channel field fails', issues({ channels: { a: { server: 1 } } }).length === 1)
  ok('cfgschema: a non-object channel value fails', issues({ channels: { a: 'nope' } }).length === 1)
  ok('cfgschema: a non-object root fails', issues('nope').length === 1)
  ok('cfgschema: a non-object channels value fails', issues({ channels: [1] }).length === 1)

  // fold semantics: one precedence chain (config value, env value, default)
  const envBase = {
    NTFY_DEFAULT_TOPIC: 'env-topic',
    NTFY_DEFAULT_SERVER: LOCAL,
    NTFY_DEFAULT_USER: 'u',
    NTFY_DEFAULT_PASS: 'p',
    NTFY_SIDE_TOPIC: 'side-topic',
    NTFY_DEFAULT_CHANNEL: 'default',
  }
  const byName = (cfg) => Object.fromEntries(cfg.channels.map((c) => [c.name, c]))

  let f = foldConfig(envBase, { channels: { default: { topic: 'layer-topic' } } }, () => {})
  eq('fold: the config value beats the env value for the same field', byName(f).default.topic, 'layer-topic')
  eq('fold: a field the layer omits keeps the env value', byName(f).default.server, LOCAL)
  eq('fold: auth the layer omits keeps the env values', [byName(f).default.auth.kind, byName(f).default.auth.user], ['basic', 'u'])
  eq('fold: the built-in default applies to a field in neither layer', byName(f).side.server, DEFAULT_SERVER)

  f = foldConfig(envBase, { defaultChannel: 'side', channels: { default: { server: 'https://other' } } }, () => {})
  eq('fold: the layer defaultChannel beats the env one (baked into isDefault)', [byName(f).side.isDefault, byName(f).default.isDefault], [true, false])
  eq('fold: a sparse layer changes only the fields it carries', [byName(f).default.server, byName(f).default.topic, byName(f).default.auth.kind], ['https://other', 'env-topic', 'basic'])

  f = foldConfig(envBase, { channels: { extra: { topic: 'extra-topic', server: LOCAL } } }, () => {})
  eq('fold: a config-only channel joins the env channels', f.channels.map((c) => c.name), ['default', 'extra', 'side'])
  eq('fold: the config-only channel resolves its own defaults', [byName(f).extra.topic, byName(f).extra.auth], ['extra-topic', null])

  const dropWarns = []
  f = foldConfig(envBase, { channels: { default: { token: 'tk' } } }, (m) => dropWarns.push(m))
  eq('fold: a layer token together with the env Basic pair drops the channel (the env rule)', f.channels.map((c) => c.name), ['side'])
  ok('fold: the drop reports through the boot warning channel', dropWarns.some((m) => m.includes('default') && m.includes('TOKEN')), dropWarns)

  const halfWarns = []
  f = foldConfig(envBase, { channels: { ghost: { topic: 'ghost-topic', user: 'g' } } }, (m) => halfWarns.push(m))
  ok('fold: a config channel with a half Basic pair is dropped (the env rule)', !f.channels.some((c) => c.name === 'ghost') && halfWarns.some((m) => m.includes('ghost') && m.includes('USER')), halfWarns)

  const noTopicWarns = []
  f = foldConfig(envBase, { channels: { orphan: { server: LOCAL } } }, (m) => noTopicWarns.push(m))
  eq('fold: a layer-declared channel with no topic in either layer is not a channel', f.channels.map((c) => c.name), ['default', 'side'])
  ok('fold: the no-topic report names the channel', noTopicWarns.some((m) => m.includes('orphan') && m.includes('no topic')), noTopicWarns)

  const noWarn = []
  f = foldConfig(envBase, { channels: { default: { server: LOCAL } } }, (m) => noWarn.push(m))
  eq('fold: a layer entry without a topic stays quiet when the env declares the channel', noWarn.length, 0)
  eq('fold: the env topic serves the layer entry', [byName(f).default.topic, byName(f).default.server], ['env-topic', LOCAL])

  const envCopy = { ...envBase }
  eq('fold: a layer of {} is exactly the env-only parse', JSON.stringify(parseEnv(envBase, () => {})), JSON.stringify(foldConfig(envCopy, {}, () => {})))
  ok('fold: the input env record is not mutated', JSON.stringify(envCopy) === JSON.stringify(envBase))

  // wire level: a layer-carried value behaves exactly like its env counterpart
  {
    const layerCfg = foldConfig({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { channels: { a: { topic: 'layer-topic' } } }, () => {})
    seen.length = 0
    const r = await send(layerCfg, { body: 'hello' })
    ok('layer-wire: the layer topic reaches the endpoint', r.ok === true && seen[0].url === '/layer-topic', seen[0]?.url)
    const snap = JSON.stringify(seen[0])
    seen.length = 0
    const envCfg = parseEnv({ NTFY_A_TOPIC: 'layer-topic', NTFY_A_SERVER: LOCAL }, () => {})
    const r2 = await send(envCfg, { body: 'hello' })
    ok('layer-wire: the env twin is byte-identical on the wire', r2.ok === true && JSON.stringify(seen[0]) === snap)
  }
  {
    const layerCfg = foldConfig({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL }, { channels: { a: { token: 'layer-tk' } } }, () => {})
    seen.length = 0
    const r = await send(layerCfg, { body: 'x' })
    ok('layer-wire: a layer token reaches the wire as a Bearer header', r.ok === true && seen[0].headers.authorization === 'Bearer layer-tk', JSON.stringify(seen[0].headers))
    const snap = JSON.stringify(seen[0])
    seen.length = 0
    const envCfg = parseEnv({ NTFY_A_TOPIC: 'topic-a', NTFY_A_SERVER: LOCAL, NTFY_A_TOKEN: 'layer-tk' }, () => {})
    const r2 = await send(envCfg, { body: 'x' })
    ok('layer-wire: the auth env twin is byte-identical on the wire', r2.ok === true && JSON.stringify(seen[0]) === snap)
  }
  {
    const cfg = foldConfig({ NTFY_A_TOPIC: 'a-topic', NTFY_A_SERVER: LOCAL, NTFY_B_TOPIC: 'b-topic', NTFY_B_SERVER: LOCAL }, { defaultChannel: 'b' }, () => {})
    seen.length = 0
    const r = await send(cfg, { body: 'x' })
    ok('layer-wire: the layer defaultChannel routes the default send', r.ok === true && r.channel === 'b' && seen[0].url === '/b-topic', r)
  }

  // assembly: the constructor folds the delivered layer (real env scrubbed)
  {
    const savedEnv = {}
    for (const k of Object.keys(process.env)) if (k.startsWith('NTFY_')) { savedEnv[k] = process.env[k]; delete process.env[k] }
    try {
      // The real deployment declares all-caps NTFY_* variables; the config
      // layer synthesizes the same casing, so the two layers write the very
      // same variables (no case-variant conflict at the parser).
      const upper = {}
      for (const [k, val] of Object.entries({ NTFY_MAIN_TOPIC: 'main-topic', NTFY_MAIN_SERVER: LOCAL, NTFY_MAIN_USER: 'u', NTFY_MAIN_PASS: 'p', NTFY_DEFAULT_CHANNEL: 'main' })) upper[k.toUpperCase()] = val
      Object.assign(process.env, upper)
      const { ctx, state } = fakeCtx()
      new DshNtfyPlugin(ctx, { channels: { main: { server: 'https://patched' } } })
      ok('assembly: a valid layer produces no boot warnings', state.warns.length === 0, state.warns)
      const out = JSON.parse(await state.tools[0].execute({ verb: 'channels' }))
      eq('assembly: the folded layer is visible in the channels verb', [out.default, out.channels[0].name, out.channels[0].server, out.channels[0].topic, out.channels[0].auth], ['main', 'main', 'https://patched', 'main-topic', 'basic'])
      ok('assembly: the channels presentation keeps its shape (no source annotations)', out.channels.every((c) => Object.keys(c).every((k) => ['name', 'server', 'topic', 'auth', 'isDefault'].includes(k))), out.channels)
    } finally {
      for (const k of Object.keys(process.env)) if (k.startsWith('NTFY_')) delete process.env[k]
      Object.assign(process.env, savedEnv)
    }
  }
}

// ── shipped hygiene guards ───────────────────────────────────────
{ // shipped-source hygiene guard: src/ stays self-contained and process-fact-free - a reader
  // needs only the file plus stable external authorities (the ntfy API, the framework API
  // names). No CJK characters, no two-digit project version tags, and no calendar dates in
  // src/. Skill and README carry the same standard.
  for (const f of readdirSync(path.join(PKG, 'src'))) {
    if (!f.endsWith('.ts')) continue
    const src = readFileSync(path.join(PKG, 'src', f), 'utf8')
    ok(`shipped source: src/${f} carries no CJK characters`, !CJK_RE.test(src))
    ok(`shipped source: src/${f} carries no version-round tags`, !/\bv\d{2}\b/.test(src))
    ok(`shipped source: src/${f} carries no calendar dates`, !/20\d{2}-\d{2}-\d{2}/.test(src))
  }
  for (const f of ['README.md', path.join('skill', 'dsh-ntfy', 'SKILL.md'), 'cordis.patch.yml', 'package.json']) {
    const src = readFileSync(path.join(PKG, f), 'utf8')
    ok(`shipped file: ${f} is ASCII-clean`, !CJK_RE.test(src))
  }
}
{ // whole-tree ASCII sweep: every shipped project file (source, tests, skill, docs, config)
  // carries zero CJK; build output and dependency trees are excluded.
  const skip = new Set(['.git', 'lib', 'node_modules'])
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (skip.has(e)) continue
      const p = path.join(dir, e)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else if (st.isFile()) {
        const src = readFileSync(p, 'utf8')
        ok(`ascii sweep: ${path.relative(PKG, p)} carries no CJK`, !CJK_RE.test(src))
      }
    }
  }
  walk(PKG)
}
{ // manifest sanity: the package entry, file list, and peer set match the shipped shape.
  const manifest = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8'))
  eq('manifest: name', manifest.name, 'dsh-ntfy')
  eq('manifest: module type', manifest.type, 'module')
  eq('manifest: entry', manifest.main, './lib/index.js')
  ok('manifest: exports point at entry + types', manifest.exports['.'].default === './lib/index.js' && manifest.exports['.'].types === './lib/index.d.ts')
  ok('manifest: no runtime dependencies', !('dependencies' in manifest))
  ok('manifest: peer set', ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/schemastery', 'yaml'].every((p) => p in manifest.peerDependencies))
  eq('manifest: bundle patch pointer', manifest.dsh.bundle.patch, './cordis.patch.yml')
  ok('manifest: bundle patch file present', existsSync(path.join(PKG, 'cordis.patch.yml')))
  ok('manifest: files entries present', manifest.files.every((f) => existsSync(path.join(PKG, f.replace(/\/$/, '')))))
  const patch = readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8')
  ok('manifest: patch registers the plugin id', patch.includes('id: dsh-ntfy') && patch.includes("name: 'dsh-ntfy'"))
  ok('manifest: compiled entry present', existsSync(path.join(PKG, 'lib', 'index.js')))
}
// selftest hygiene guard
{ // the selftest itself stays self-contained: no dangling pointers to non-shipped material
  // (design-document sections, review findings, version-round labels, machine-specific paths,
  // source line-number pointers, CJK quotes). Test-vector inputs are data, not provenance.
  const raw = readFileSync(path.join(PKG, 'test', 'selftest.mjs'), 'utf8')
  const testSrc = raw.slice(0, raw.indexOf('// selftest hygiene guard'))
  ok('selftest hygiene: no design-doc section pointers', !/design doc|design v\d|spec \u00a7|\u00a7\d/.test(testSrc))
  ok('selftest hygiene: no machine-specific paths', !/\/workspace\//.test(testSrc))
  ok('selftest hygiene: no source line-number pointers', !/L\d+[-\u2013\u2014]L?\d+/.test(testSrc))
  ok('selftest hygiene: no review-round wrappers', !/round-?\d+|review #\d/.test(testSrc))
  ok('selftest hygiene: no project version-round tags', !/\bv\d{2}\b/.test(testSrc))
  ok('selftest hygiene: no CJK characters', !CJK_RE.test(testSrc))
  ok('selftest hygiene: no review finding identifiers', !/R\d{1,2}-[A-Za-z]\w*/.test(testSrc))
  ok('selftest hygiene: no version-round identifiers', !/\bv\d{2}[A-Za-z_]\w*/.test(testSrc))
}

// ── results ──────────────────────────────────────────────────────
// The client keeps its sockets open (keep-alive is the default since Node 19);
// drop them first or server.close() would wait on idle connections forever.
server.closeAllConnections()
await new Promise((r) => server.close(r))
console.log(`selftest: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  FAIL: ${f}`)
process.exit(failures.length > 0 ? 1 : 0)
