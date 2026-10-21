import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { BasicMemoryClient, KnowledgeStore, decodeNote, redact } from '../lib/basic-memory.js'

async function setup(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-knowledge-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const project = join(dir, 'project'), other = join(dir, 'other'), root = join(dir, 'vault')
  await mkdir(project); await mkdir(other)
  const hits = []
  const store = new KnowledgeStore(root, { ttlDays: 30, basicMemoryConfig: join(dir, 'config') }, { search: async () => hits, close: async () => {} })
  t.after(() => store.close())
  return { dir, project, other, root, hits, store }
}
const fact = { key: 'export', title: '论文导出', kind: 'pitfall', summary: '先确认当前浏览器和页面。', evidence: '验收夹具：确认窗口焦点。', files: [] }

test('Markdown is canonical: human edits invalidate revisions; stale files and project isolation remain enforced', async t => {
  const f = await setup(t)
  await writeFile(join(f.project, 'source.js'), 'one')
  const saved = await f.store.save(f.project, { ...fact, files: ['source.js'] }, 'session-a')
  f.hits.push({ file_path: relative(f.root, saved.path) })
  f.hits.push({ file_path: relative(f.root, saved.path) })
  const found = await f.store.search(f.project, '论文')
  assert.equal(found.length, 1)
  assert.deepEqual(await f.store.search(f.project, 'unrelated_marker'), [])
  assert.equal(found[0].status, 'verified')
  assert.match(found[0].summary, /确认当前浏览器/)
  assert.deepEqual(await f.store.search(f.other, '论文'), [])
  const raw = await readFile(saved.path, 'utf8')
  await writeFile(saved.path, raw.replace('先确认当前浏览器和页面。', '在 Obsidian 中修订了步骤。'))
  assert.match((await f.store.search(f.project, '论文'))[0].summary, /Obsidian/)
  await assert.rejects(f.store.save(f.project, { ...fact, expected_revision: saved.revision }, 'session-a'), /changed/)
  await writeFile(join(f.project, 'source.js'), 'two')
  assert.deepEqual(await f.store.search(f.project, '论文'), [])
  assert.equal((await f.store.search(f.project, '论文', { includeStale: true }))[0].stale, 'files-changed')
})

test('concurrent replacements conflict and deletion keeps a recoverable copy', async t => {
  const f = await setup(t)
  const saved = await f.store.save(f.project, fact, 'session-a')
  const outcomes = await Promise.allSettled(['first', 'second'].map(summary => f.store.save(f.project, { ...fact, summary, expected_revision: saved.revision }, 'session-a')))
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1)
  const latest = outcomes.find(x => x.status === 'fulfilled').value
  const removed = await f.store.forget(f.project, fact.key, latest.revision)
  assert.match(await readFile(removed.recoverable_at, 'utf8'), /first|second/)
  await assert.rejects(readFile(saved.path), { code: 'ENOENT' })
})

test('capture records completed/failed/aborted tasks once, omits reasoning and arguments, and redacts credentials', async t => {
  const f = await setup(t)
  for (const [i, status] of ['completed', 'failed', 'aborted'].entries()) {
    const events = [
      { type: 'turn/start', data: { turn: i + 1 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '检查论文导出 api_key=private-secret-value' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'hidden reasoning' }, { type: 'text', text: '检查页面后给出导出步骤。' }] } } },
      { type: 'tool/call', data: { name: 'read_image', arguments: 'private arguments' } },
    ]
    const session = { header: { id: 'session-a' }, eventAt: seq => events[seq] }
    const end = { seq: 4, time: Date.now(), data: { turn: i + 1, reason: { kind: status } } }
    await f.store.capture(f.project, session, end); await f.store.capture(f.project, session, end)
  }
  const dir = join(f.store.folder(f.project), 'journal'), files = await readdir(dir)
  assert.equal(files.length, 3)
  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8'), parsed = decodeNote(raw)
    assert(['completed', 'failed', 'aborted'].includes(parsed.meta.dsh_status))
    assert.match(raw, /未经独立验证/)
    assert(!raw.includes('private-secret-value') && !raw.includes('hidden reasoning') && !raw.includes('private arguments'))
  }
})

test('vault symlinks cannot redirect captures or facts into another directory', async t => {
  const f = await setup(t)
  await symlink(f.other, join(f.root, 'projects'))
  await assert.rejects(f.store.save(f.project, fact, 'session-a'), /symbolic/)
  assert.deepEqual(await readdir(f.other), [])
  await assert.rejects(f.store.save(f.project, { ...fact, summary: 'password=not-a-real-secret' }, 'session-a'), /credential/)
  await assert.rejects(f.store.save(f.project, { ...fact, summary: 'Authorization: Bearer abc1234567890' }, 'session-a'), /credential/)
  assert.equal(redact('Authorization=abc1234567890'), 'Authorization=[credential omitted]')
  assert.equal(redact('Authorization: Bearer abc1234567890'), 'Authorization=[credential omitted]')
  assert.equal(redact(redact('Authorization: Bearer abc1234567890')), 'Authorization=[credential omitted]')
})

test('zero-score index candidates are ranked before limiting; exact keys and titles beat noisy history', async t => {
  const f = await setup(t)
  for (let i = 0; i < 18; i++) {
    const saved = await f.store.save(f.project, { ...fact, key: `old-${i}`, title: `知识记录 ${i}`, summary: '知识库检查经验。', evidence: '旧记录。' }, 'old')
    f.hits.push({ file_path: relative(f.root, saved.path), score: 0 })
  }
  const target = await f.store.save(f.project, { ...fact, key: 'online-cache-generation-20261020', title: '异步缓存失效与在途代次保护',
    summary: '用在途 entry 身份保护失效代次；成功后开始 TTL。', evidence: 'node --test：9 项通过。' }, 'verified')
  f.hits.push({ file_path: relative(f.root, target.path), score: 0 })
  const boilerplate = await f.store.save(f.project, { ...fact, key: 'generic-recall', title: '自动召回条数',
    summary: '读取已验证经验的修复规则和验收项数，保留本轮的命令及摘要。', evidence: '通用规则，非缓存问题结论。' }, 'old')
  f.hits.push({ file_path: relative(f.root, boilerplate.path), score: 0 })
  const query = '新会话检查知识库：online-cache-generation-20261020 异步缓存失效与在途代次保护。请仅依据本轮自动召回的已验证经验，报告修复规则和验收项数，不要读取文件。'
  const records = await f.store.search(f.project, query)
  assert.equal(records[0].key, 'online-cache-generation-20261020')
  assert.equal(records.length, 1, 'instruction words must not admit unrelated old notes')
  assert.equal((await f.store.search(f.project, '异步缓存失效与在途代次保护'))[0].key, records[0].key)
  f.hits.length = 0
  assert.equal((await f.store.search(f.project, 'online-cache-generation-20261020'))[0].key, records[0].key, 'exact keys work before index refresh')
  assert.deepEqual(await f.store.search(f.other, 'online-cache-generation-20261020'), [])
})

test('stale exact keys are excluded; verified evidence wins a relevance tie and empty queries list newest', async t => {
  const f = await setup(t)
  await writeFile(join(f.project, 'source.js'), 'one')
  const saved = await f.store.save(f.project, { ...fact, files: ['source.js'] }, 'verified')
  const history = join(f.store.folder(f.project), 'journal', 'history.md')
  await mkdir(join(f.store.folder(f.project), 'journal'))
  const raw = await readFile(saved.path, 'utf8')
  await writeFile(history, raw.replace('dsh_key: export', 'dsh_key: journal-export').replace('dsh_status: verified', 'dsh_status: aborted').replace(/dsh_updated_at: \d+/, `dsh_updated_at: ${Date.now() + 1000}`))
  f.hits.push({ file_path: relative(f.root, history) }, { file_path: relative(f.root, saved.path) })
  assert.equal((await f.store.search(f.project, '论文导出'))[0].status, 'verified')
  for (let i = 0; i < 4; i++) {
    const path = join(f.store.folder(f.project), 'journal', `repeated-${i}.md`)
    await writeFile(path, raw.replace('title: 论文导出', 'title: 检查论文导出与浏览器焦点').replace('dsh_key: export', `dsh_key: repeated-${i}`).replace('dsh_status: verified', 'dsh_status: completed'))
    f.hits.push({ file_path: relative(f.root, path) })
  }
  assert.equal((await f.store.search(f.project, '检查论文导出与浏览器焦点'))[0].status, 'verified', 'repeated journals must not crowd verified evidence out of automatic recall')
  assert.equal((await f.store.search(f.project, ''))[0].key, 'journal-export')
  await writeFile(join(f.project, 'source.js'), 'two')
  assert.deepEqual(await f.store.search(f.project, 'export'), [])
  assert.equal((await f.store.search(f.project, 'export', { includeStale: true }))[0].stale, 'files-changed')
})

test('MCP cold start awaits readiness, supports cancellation and pages beyond the first zero-score page', async () => {
  const ready = Promise.withResolvers(), calls = []
  const client = { status: 'starting', ready: ready.promise, client: { async callTool(request) {
    calls.push(request.arguments)
    const page = request.arguments.page
    return { structuredContent: { results: page === 1 ? Array.from({ length: 100 }, (_, i) => ({ file_path: `old-${i}.md`, score: 0 })) : [{ file_path: 'target.md', score: 0 }], has_more: page === 1 } }
  } } }
  const search = BasicMemoryClient.prototype.search.call(client, '/project', '缓存代次', new AbortController().signal)
  await Promise.resolve()
  assert.equal(calls.length, 0)
  client.status = 'ready'; ready.resolve()
  const hits = await search
  assert.equal(hits.length, 101)
  assert.equal(hits.at(-1).file_path, 'target.md')
  assert.deepEqual(calls.map(c => c.page), [1, 2])
  assert(calls.every(c => c.metadata_filters.dsh_project === '/project'))

  const controller = new AbortController()
  const waiting = BasicMemoryClient.prototype.search.call({ ...client, status: 'starting', ready: new Promise(() => {}) }, '/project', '缓存', controller.signal)
  controller.abort(new Error('cancel cold start'))
  await assert.rejects(waiting, /cancel cold start/)
  assert.equal(calls.length, 2)
  const stuck = { ...client, client: { callTool: async () => ({ structuredContent: { results: [{ file_path: 'same.md' }], has_more: true } }) } }
  await assert.rejects(BasicMemoryClient.prototype.search.call(stuck, '/project', '缓存'), /no progress/)
})
