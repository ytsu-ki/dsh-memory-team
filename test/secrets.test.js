import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { SecretScanner } from '../lib/secrets.js'
import { KnowledgeStore, encodeNote } from '../lib/basic-memory.js'
import { MemoryStore } from '../lib/memory.js'

async function fakeScanner(t, mode = 'normal') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-secret-test-'))), command = join(dir, 'scanner.mjs')
  await writeFile(command, `
if (process.argv[2] === 'version') { process.stdout.write('1.9.0\\n'); process.exit(0) }
const args = process.argv.slice(2)
if (!args.includes('--validation=false') || !args.includes('--ignore-gitleaks-allow') || Object.keys(process.env).some(k => /BETTERLEAKS|GITLEAKS|TOKEN|PROXY/.test(k))) process.exit(8)
let input = ''; for await (const chunk of process.stdin) input += chunk
if (${JSON.stringify(mode)} === 'failure') { process.stderr.write(input); process.exit(2) }
if (${JSON.stringify(mode)} === 'hang') { setInterval(() => {}, 1000) }
else process.stdout.write(JSON.stringify(input.includes('SYNTHETIC_CREDENTIAL') ? [{ Secret: 'SYNTHETIC_CREDENTIAL' }] : []))
`, { mode: 0o700 })
  // The fixture runs through Node on every OS; production still executes the native binary without a shell.
  const scanner = new SecretScanner(command, {
    executeFile: (file, args, options) => promisify(execFile)(process.execPath, [file, ...args], options),
    spawnFile: (file, args, options) => spawn(process.execPath, [file, ...args], options),
  })
  const stores = []
  t.after(async () => { for (const store of stores) await store.close(); scanner.close(); await rm(dir, { recursive: true, force: true }) })
  return { dir, scanner, stores }
}

test('scanner strips inherited config/credentials and redacts without corrupting JSON fields', async t => {
  const f = await fakeScanner(t)
  assert.equal(await f.scanner.sanitize('中文 SYNTHETIC_CREDENTIAL 普通话'), '中文 [credential omitted] 普通话')
  assert.deepEqual(await f.scanner.sanitizeObject({ summary: 'password=unreal-value', title: '中文 SYNTHETIC_CREDENTIAL' }),
    { summary: 'password=[credential omitted]', title: '中文 [credential omitted]' })
  const builtin = new SecretScanner()
  assert.deepEqual(await builtin.sanitizeObject({ prompt: 'api_key=private-value', reply: '正常中文。' }),
    { prompt: 'api_key=[credential omitted]', reply: '正常中文。' })
  builtin.close()
})

test('scanner startup diagnostics distinguish missing executables and unsupported versions without exposing paths', async t => {
  for (const [code, executeFile] of [
    ['SCANNER_NOT_FOUND', async () => { throw Object.assign(new Error('private path'), { code: 'ENOENT' }) }],
    ['SCANNER_VERSION_UNSUPPORTED', async () => ({ stdout: '0.0.0' })],
    ['SCANNER_BINARY_UNREADABLE', async () => ({ stdout: '1.9.0' })],
  ]) {
    const scanner = new SecretScanner('nonexistent-private-path', { executeFile })
    t.after(() => scanner.close())
    await assert.rejects(scanner.ready, /memory withheld/)
    assert.equal(scanner.status, 'unavailable'); assert.equal(scanner.error, code)
  }
})

test('scanner failure withholds memory and never copies raw stderr into an error; cancellation kills the child', async t => {
  const failed = await fakeScanner(t, 'failure')
  await assert.rejects(failed.scanner.sanitize('SYNTHETIC_CREDENTIAL'), error => /memory withheld/.test(error.message) && !error.message.includes('SYNTHETIC_CREDENTIAL'))
  const hung = await fakeScanner(t, 'hang'), controller = new AbortController()
  await hung.scanner.ready
  const waiting = hung.scanner.sanitize('SYNTHETIC_CREDENTIAL', controller.signal)
  setTimeout(() => controller.abort(new Error('cancel secret scan')), 50)
  await assert.rejects(waiting, /cancel secret scan/)
  assert.equal(hung.scanner.children.size, 0)
})

test('Markdown saves, external recall and legacy SQLite all screen credentials', async t => {
  const f = await fakeScanner(t), project = join(f.dir, 'project'), config = { ttlDays: 30, basicMemoryConfig: join(f.dir, 'config') }
  await mkdir(project)
  const store = new KnowledgeStore(join(f.dir, 'vault'), config, { close: async () => {}, search: async () => [] }, f.scanner)
  const legacy = new MemoryStore(join(f.dir, 'legacy.sqlite'), { ...config, scanner: f.scanner })
  f.stores.push(store, legacy)
  const input = { key: 'sample', title: '中文验收', kind: 'fact', summary: '凭据 SYNTHETIC_CREDENTIAL，仍保留步骤。', evidence: '本地夹具', files: [] }
  const saved = await store.save(project, input, 'session')
  assert(!(await readFile(saved.path, 'utf8')).includes('SYNTHETIC_CREDENTIAL'))
  await legacy.save(project, input, 'session')
  assert(!JSON.stringify(await legacy.search(project, '验收')).includes('SYNTHETIC_CREDENTIAL'))
  const external = join(store.folder(project), 'facts', 'external.md')
  await writeFile(external, encodeNote({ title: '外部凭据', dsh_key: 'external', dsh_project: project, dsh_status: 'verified',
    dsh_files: [], dsh_updated_at: Date.now() }, 'SYNTHETIC_CREDENTIAL 这部分是外部编辑。'))
  const found = await store.search(project, 'external')
  assert.equal(found.length, 1); assert(!JSON.stringify(found).includes('SYNTHETIC_CREDENTIAL'))
  const index = store.indexFor(project); await index.persist()
  assert(!(await readFile(index.snapshot, 'utf8')).includes('SYNTHETIC_CREDENTIAL'))
})

test('real Betterleaks 1.9.0 detects synthetic AWS credentials and preserves ordinary Chinese evidence', {
  skip: !process.env.BETTERLEAKS_TEST_COMMAND && 'Set BETTERLEAKS_TEST_COMMAND for the real binary',
}, async t => {
  const scanner = new SecretScanner(process.env.BETTERLEAKS_TEST_COMMAND)
  t.after(() => scanner.close())
  // Build offline samples at runtime so publishing fixtures does not expose token-shaped literals.
  const key = 'AKIA' + 'Z7M3Q8N2R9T4W6Y5', sample = `部署记录：AWS access key: ${key}。只用于离线夹具；没有真实账号。`
  const clean = await scanner.sanitize(sample)
  assert(!clean.includes(key)); assert.match(clean, /部署记录/)
  const normal = '中文订单 20261020001234567890；验收 9 项通过；缓存 TTL 3000ms。'
  assert.equal(await scanner.sanitize(normal), normal)
  const slack = ['xoxb', '123456789012', '1234567890123', 'abcdefghijklmnopqrstuvwxyz123456'].join('-')
  assert(!(await scanner.sanitize(`离线格式样例：${slack}`)).includes(slack))

  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-secret-real-'))), project = join(dir, 'project')
  await mkdir(project)
  const store = new KnowledgeStore(join(dir, 'vault'), { ttlDays: 30, basicMemoryConfig: join(dir, 'config') },
    { search: async () => [], close: async () => {} }, scanner)
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }) })
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `离线格式验收 ${key}` }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `仅使用样例 ${slack}。正常中文验收步骤。` }] } } },
  ]
  await store.capture(project, { header: { id: 'real-synthetic' }, eventAt: seq => events[seq] },
    { seq: 3, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
  const found = await store.search(project, '离线格式验收')
  assert.equal(found.length, 1)
  const raw = await readFile(found[0].path, 'utf8')
  assert(!raw.includes(key) && !raw.includes(slack))
  assert(!JSON.stringify(found).includes(key) && !JSON.stringify(found).includes(slack))
  assert.match(raw, /正常中文验收步骤/)
})
