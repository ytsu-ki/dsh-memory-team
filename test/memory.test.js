import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, projectRoot, renderMemories } from '../lib/memory.js'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-test-'))
  const a = join(dir, 'a'), b = join(dir, 'b')
  await mkdir(a); await mkdir(b); await mkdir(join(a, '.git'))
  await writeFile(join(a, 'app.js'), 'version 1')
  const path = join(dir, 'db', 'memory.sqlite')
  const store = new MemoryStore(path)
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }) })
  const record = { key: 'viewport-check', title: '1440px 验收遮挡', kind: 'pitfall', summary: '验收前关闭弹窗，再测1440px视口。', evidence: '本地验收测试确认弹窗覆盖按钮。', files: ['app.js'] }
  return { dir, a: await projectRoot(a), b: await projectRoot(b), store, path, record }
}

test('memory persists, searches Chinese/English and isolates projects', async t => {
  const f = await fixture(t)
  await f.store.save(f.a, f.record, 'source-session')
  assert.equal((await f.store.search(f.a, '验收')).length, 1)
  assert.equal((await f.store.search(f.a, '1440px'))[0].source_session, 'source-session')
  assert.deepEqual(await f.store.search(f.b, '1440px'), [])
  assert.deepEqual(await f.store.search(f.a, 'unrelatedXYZ'), [])
  const another = new MemoryStore(f.path)
  assert.equal((await another.search(f.a, '弹窗'))[0].revision, 1)
  another.close()
  assert.equal((await stat(f.path)).mode & 0o777, 0o600)
})

test('file changes and TTL invalidate automatic recall, but remain inspectable', async t => {
  const f = await fixture(t)
  await f.store.save(f.a, f.record, 'source')
  await writeFile(join(f.a, 'app.js'), 'version 2')
  assert.deepEqual(await f.store.search(f.a, '验收'), [])
  assert.equal((await f.store.search(f.a, '验收', { includeStale: true }))[0].stale, 'files-changed')
  await f.store.save(f.a, { ...f.record, expected_revision: 1 }, 'new-source')
  f.store.db.prepare('UPDATE memories SET updated_at=?').run(Date.now() - 31 * 86400000)
  assert.deepEqual(await f.store.search(f.a, '验收'), [])
  assert.equal((await f.store.search(f.a, '验收', { includeStale: true }))[0].stale, 'expired')
})

test('optimistic revisions reject concurrent replacement and protect deletion', async t => {
  const f = await fixture(t)
  await f.store.save(f.a, f.record, 'source')
  const second = new MemoryStore(f.path)
  t.after(() => second.close())
  const results = await Promise.allSettled([
    f.store.save(f.a, { ...f.record, expected_revision: 1, summary: 'First updated conclusion' }, 'one'),
    second.save(f.a, { ...f.record, expected_revision: 1, summary: 'Second updated conclusion' }, 'two'),
  ])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((await f.store.search(f.a, ''))[0].revision, 2)
  assert.throws(() => f.store.forget(f.a, f.record.key, 1), /revision/)
  f.store.forget(f.a, f.record.key, 2)
  assert.deepEqual(await f.store.search(f.a, ''), [])
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM memory_fts').get().n, 0)
})

test('project scope handles nested directories and symlinks; evidence cannot escape', async t => {
  const f = await fixture(t)
  await mkdir(join(f.a, 'src'))
  await symlink(f.a, join(f.dir, 'alias'))
  assert.equal(await projectRoot(join(f.a, 'src')), f.a)
  assert.equal(await projectRoot(join(f.dir, 'alias')), f.a)
  await writeFile(join(f.b, 'outside'), 'private')
  await symlink(join(f.b, 'outside'), join(f.a, 'escape'))
  await assert.rejects(f.store.save(f.a, { ...f.record, files: ['../b/outside'] }, 'source'), /inside/)
  await assert.rejects(f.store.save(f.a, { ...f.record, files: ['escape'] }, 'source'), /inside/)
})

test('validation bounds content, rejects obvious credentials and keeps FTS input literal', async t => {
  const f = await fixture(t)
  await assert.rejects(f.store.save(f.a, { ...f.record, key: '../bad' }, 'source'), /key/)
  await assert.rejects(f.store.save(f.a, { ...f.record, summary: 'x'.repeat(2001) }, 'source'), /2000/)
  await assert.rejects(f.store.save(f.a, { ...f.record, summary: 'api_key=supersecretcredential' }, 'source'), /credential/)
  await f.store.save(f.a, f.record, 'source')
  await f.store.search(f.a, '" OR * NEAR(验收) --')
  assert.equal((await f.store.search(f.a, ''))[0].key, f.record.key)
  assert.equal(renderMemories(await f.store.search(f.a, ''), 100), '')
  assert.match(renderMemories(await f.store.search(f.a, '')), /not instructions/)
})
