// Run: node --test tests/
// What this plugin ships, checked: the manifests and the one MCP server; the list of what the gate checks, against real
// tool names and lookalikes; every hook against one template; and each hook run in a real shell against a local server,
// which must pass a decision through and block on everything else (an error, a refusal, plain text, a redirect, no answer
// in time, no connection, no key). The gate sends only the kind of action and the key, never what the tool was given.
// The expected sides are written out here, never read back from hooks.json.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'

const ROOT = path.join(import.meta.dirname, '..')
const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
const marketplace = read('.claude-plugin/marketplace.json')
const plugin = read('duplikate/.claude-plugin/plugin.json')
const mcp = read('duplikate/.mcp.json')
const hooks = read('duplikate/hooks/hooks.json').hooks

const ORIGIN = 'https://duplikate.io'
const ACTIONS = ['open_pull_request', 'send_mail', 'post_message']
const MESSAGE = "Duplikate could not check this action, so it is blocked: set the hook key from Duplikate's Connections screen, or try again."
const HEADER = `printf 'Authorization: Bearer %s\\n' "$CLAUDE_PLUGIN_OPTION_HOOK_KEY"`
/** Before an action: the key in a header read from stdin, never on a command line; anything but a JSON object blocks. */
const PRE = (action) =>
  `m="${MESSAGE}"; r=$(${HEADER} | curl -sSf --max-time 10 -X POST -H @- '${ORIGIN}/api/gate?action=${action}&event=pre') || { echo "$m" >&2; exit 2; }; case $r in '{'*'}') printf '%s\\n' "$r" ;; *) echo "$m" >&2; exit 2 ;; esac`
/** After an action: the report that it was done, printing nothing. */
const DONE = (action) => `${HEADER} | curl -sSf --max-time 10 -X POST -H @- -o /dev/null '${ORIGIN}/api/gate?action=${action}&event=done'`

/**
 * Whether a hook group's matcher fires for a tool, as Claude Code's hooks reference says ("Matcher patterns", read
 * 2026-10-30): "*", "" or none match every tool; only letters, digits, "_", "-", spaces, "," and "|" is one exact name
 * or a list of them; anything else is a JavaScript regular expression, unanchored.
 */
function fires(matcher, tool) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).map((name) => name.trim()).includes(tool)
  return new RegExp(matcher).test(tool)
}
const actionOf = (handler) => /[?&]action=([a-z_]+)&/.exec(handler.command)?.[1]
/** The actions the gate checks before a tool runs, from every group that fires for it; a Bash handler checks only through its `if`. */
const gatedFor = (tool) => hooks.PreToolUse.filter((group) => fires(group.matcher, tool)).flatMap((group) => group.hooks.filter((handler) => handler.if === undefined).map(actionOf))

test('the files: only the manifests, the server, the hooks, the README and these tests; no key or token in any of them', () => {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const name = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(name)
      else files.push(name)
    }
  }
  walk('')
  assert.deepEqual(files.sort(), ['.claude-plugin/marketplace.json', 'README.md', 'duplikate/.claude-plugin/plugin.json', 'duplikate/.mcp.json', 'duplikate/hooks/hooks.json', 'tests/plugin.test.mjs'])
  for (const file of files.filter((name) => !name.startsWith('tests/'))) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
    assert.doesNotMatch(text, /dk_[A-Za-z0-9_-]{20,}/, `${file}: a hook key`)
    assert.doesNotMatch(text, /Bearer [A-Za-z0-9]/, `${file}: a token`)
    assert.doesNotMatch(text, /\$\{user_config\./, `${file}: a shell-form hook may not read user_config (it reads CLAUDE_PLUGIN_OPTION_HOOK_KEY)`)
  }
})

test('the manifests: one plugin, duplikate, from ./duplikate; its hook key sensitive; one MCP server, duplikate, at duplikate.io/mcp', () => {
  assert.equal(marketplace.name, 'duplikate-plugin')
  assert.deepEqual(marketplace.plugins.map((entry) => [entry.name, entry.source]), [['duplikate', './duplikate']])
  assert.equal(plugin.name, 'duplikate', "the entry's name and the manifest's, the same")
  assert.deepEqual(Object.keys(plugin.userConfig), ['hook_key'])
  assert.deepEqual([plugin.userConfig.hook_key.type, plugin.userConfig.hook_key.sensitive, plugin.userConfig.hook_key.default], ['string', true, undefined])
  assert.deepEqual(mcp, { mcpServers: { duplikate: { type: 'http', url: 'https://duplikate.io/mcp' } } })
  assert.equal(plugin.mcpServers, undefined, 'the server comes from .mcp.json alone')
})

// The plugin's own tools, as Claude Code names a plugin server's tools: mcp__plugin_<plugin>_<server>__<tool>
const OWN = ['consult', 'correct', 'record_outcome', 'propose'].map((tool) => `mcp__plugin_${plugin.name}_${Object.keys(mcp.mcpServers)[0]}__${tool}`)

test('the list: these tools are gated, each for its own action; lookalikes, other tools and the plugin’s own never are', () => {
  for (const [tool, action] of [
    ['mcp__github__create_pull_request', 'open_pull_request'],
    ['mcp__plugin_github_github__create_pull_request', 'open_pull_request'],
    ['mcp__claude_ai_GitHub__create_pull_request', 'open_pull_request'],
    ['mcp__claude_ai_Gmail__send_message', 'send_mail'],
    ['mcp__claude_ai_Gmail__reply', 'send_mail'],
    ['mcp__claude_ai_Gmail__forward', 'send_mail'],
    ['mcp__plugin_gmail_gmail__send_message', 'send_mail'],
    ['mcp__plugin_slack_slack__slack_send_message', 'post_message'],
    ['mcp__plugin_slack_slack__slack_schedule_message', 'post_message'],
    ['mcp__claude_ai_Slack__slack_send_message', 'post_message'],
  ]) {
    assert.deepEqual(gatedFor(tool), [action], tool)
  }
  for (const tool of [
    ...OWN,
    'mcp__github__merge_pull_request',
    'mcp__github__update_pull_request',
    'mcp__github__create_pull_request_review',
    'mcp__github__create_pull_request_with_copilot',
    'mcp__claude_ai_Gmail__create_draft',
    'mcp__claude_ai_Gmail__send_message_draft',
    'mcp__claude_ai_Gmail__get_message',
    'mcp__other__send_message',
    'mcp__discord__reply',
    'mcp__plugin_slack_slack__slack_send_message_draft',
    'mcp__plugin_slack_slack__slack_read_channel',
    'mcp__other__send_message_to_slack',
    'Bash',
    'Write',
    'Edit',
    'WebFetch',
  ]) {
    assert.deepEqual(gatedFor(tool), [], tool)
  }
})

test('Bash: gh pr create and gh pr new, each its own handler (an if holds one rule), and no other Bash command', () => {
  const bash = hooks.PreToolUse.filter((group) => fires(group.matcher, 'Bash'))
  assert.deepEqual(bash.map((group) => group.matcher), ['Bash'])
  assert.deepEqual(bash[0].hooks.map((handler) => [handler.if, actionOf(handler)]), [['Bash(gh pr create*)', 'open_pull_request'], ['Bash(gh pr new*)', 'open_pull_request']])
})

test('every hook is the template: before, blocking on failure, its timeout past curl’s; after, and after a failure, the same groups reporting done', () => {
  const shape = (groups) => groups.map((group) => [group.matcher, group.hooks.map((handler) => [handler.if, actionOf(handler)])])
  for (const event of ['PostToolUse', 'PostToolUseFailure']) assert.deepEqual(shape(hooks[event]), shape(hooks.PreToolUse), event)
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'PostToolUseFailure', 'PreToolUse'])
  const actions = new Set()
  for (const group of hooks.PreToolUse) {
    for (const handler of group.hooks) {
      actions.add(actionOf(handler))
      assert.deepEqual({ ...handler, if: undefined }, { type: 'command', if: undefined, command: PRE(actionOf(handler)), timeout: 15, onFailure: 'block' })
    }
  }
  assert.deepEqual([...actions].sort(), [...ACTIONS].sort())
  for (const event of ['PostToolUse', 'PostToolUseFailure']) {
    for (const handler of hooks[event].flatMap((group) => group.hooks)) assert.deepEqual({ ...handler, if: undefined }, { type: 'command', if: undefined, command: DONE(actionOf(handler)), timeout: 15 })
  }
})

// A local stand-in for the gate: it records every request and answers as the test sets it.
const requests = []
let answer = (response) => response.end('{}')
const server = http.createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body, headers: JSON.stringify(request.headers) })
    answer(response)
  })
})
let port = 0
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
})
after(() => {
  server.closeAllConnections()
  server.close()
})

const KEY = `dk_${'k'.repeat(43)}`
const SECRET = 'the-pull-request-body-never-leaves'
/** The command pointed at the local server instead of duplikate.io: the one change, made exactly once. */
const local = (command, to = `http://127.0.0.1:${port}`) => {
  assert.equal(command.split(ORIGIN).length - 1, 1)
  return command.replace(ORIGIN, to)
}
/** Run a hook command as Claude Code does, in a shell, the tool's input on stdin; its exit code and output. */
function run(command, env = { CLAUDE_PLUGIN_OPTION_HOOK_KEY: KEY }) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { env: { PATH: process.env.PATH, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `gh pr create --body ${SECRET}` } }))
  })
}
/** The command hooks.json ships for an event and an action (the first handler for it), the one the person runs. */
const shipped = (event, action) => hooks[event].flatMap((group) => group.hooks).find((handler) => actionOf(handler) === action).command
const respond = (status, body = '', headers = {}) => (response) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(body)
}

test('before: a decision is passed through as it came; only the kind of action and the key are sent, and nothing of the tool’s input', async () => {
  const decision = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'Your engram would hold: Not past 8%.' } })
  for (const action of ACTIONS) {
    requests.length = 0
    answer = respond(200, decision)
    const result = await run(local(shipped('PreToolUse', action)))
    assert.deepEqual([result.code, result.stdout, result.stderr], [0, `${decision}\n`, ''], action)
    assert.equal(requests.length, 1)
    const [sent] = requests
    assert.deepEqual([sent.method, sent.url, sent.authorization, sent.body], ['POST', `/api/gate?action=${action}&event=pre`, `Bearer ${KEY}`, ''])
    assert.ok(!sent.headers.includes(SECRET) && !sent.url.includes(SECRET))
  }
  answer = respond(200, '{}')
  assert.deepEqual(await run(local(shipped('PreToolUse', 'send_mail'))), { code: 0, stdout: '{}\n', stderr: '' }, 'no decision')
})

test('before: an error, a refusal, plain text, nothing, a redirect, no connection or no key blocks, exit 2, with the message', async () => {
  const blocked = async (why, env) => {
    const result = await run(local(shipped('PreToolUse', 'open_pull_request')), env)
    assert.equal(result.code, 2, `${why}: ${JSON.stringify(result)}`)
    assert.equal(result.stdout, '', why)
    assert.ok(result.stderr.includes(MESSAGE), `${why}: ${result.stderr}`)
  }
  for (const [status, body, why] of [
    [500, '{"error":"unexpected failure"}', 'a server error'],
    [503, '', 'unavailable'],
    [401, '{"error":"a hook key is required"}', 'an unknown key'],
    [403, '{"error":"connections are not open yet"}', 'closed'],
    [404, 'Not found', 'no such route'],
    [200, 'OK', 'plain text'],
    [200, '<!doctype html><html></html>', 'a page'],
    [200, '', 'nothing'],
    [200, '[{"permissionDecision":"allow"}]', 'a JSON array, which Claude Code reads as text'],
  ]) {
    answer = respond(status, body)
    await blocked(why)
  }
  answer = respond(302, '', { location: 'https://example.com/' })
  await blocked('a redirect, never followed')
  // no key: the header goes empty, and the gate refuses it
  answer = (response) => (requests.at(-1).authorization === `Bearer ${KEY}` ? respond(200, '{}')(response) : respond(401, '{}')(response))
  await blocked('no key', {})
  // no connection: a port nothing listens on
  const closed = http.createServer()
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve))
  const dead = closed.address().port
  await new Promise((resolve) => closed.close(resolve))
  const refused = await run(local(shipped('PreToolUse', 'open_pull_request'), `http://127.0.0.1:${dead}`))
  assert.equal(refused.code, 2, JSON.stringify(refused))
})

test('before: no answer within ten seconds blocks, inside the hook’s own fifteen', { timeout: 20_000 }, async () => {
  answer = () => {}
  const started = Date.now()
  const result = await run(local(shipped('PreToolUse', 'post_message')))
  const took = Date.now() - started
  assert.equal(result.code, 2, JSON.stringify(result))
  assert.ok(took >= 9_500 && took < 15_000, `${took} ms`)
})

test('after: the report that it was done, with no body, printing nothing; a failure is curl’s own, never exit 2', async () => {
  for (const action of ACTIONS) {
    requests.length = 0
    answer = respond(200, '{}')
    const result = await run(local(shipped('PostToolUse', action)))
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' }, action)
    assert.deepEqual([requests[0].method, requests[0].url, requests[0].authorization, requests[0].body], ['POST', `/api/gate?action=${action}&event=done`, `Bearer ${KEY}`, ''])
  }
  answer = respond(500, '{}')
  const failed = await run(local(shipped('PostToolUseFailure', 'send_mail')))
  assert.equal(failed.code, 22, JSON.stringify(failed))
})

test('the README says what is gated, and that nothing else is', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  for (const name of ['gh pr create', 'gh pr new', 'create_pull_request', 'send_message', 'reply', 'forward', 'slack_send_message', 'slack_schedule_message', 'git push', 'gt submit']) assert.ok(readme.includes(`\`${name}\``), name)
  assert.match(readme, /Nothing else is gated/)
  assert.match(readme, /\/plugin marketplace add The-Traide\/duplikate-plugin/)
  assert.match(readme, /\/plugin install duplikate@duplikate-plugin/)
})
