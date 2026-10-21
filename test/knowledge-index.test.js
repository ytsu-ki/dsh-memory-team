import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, readFile, writeFile, rename, unlink, rm, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { KnowledgeStore, encodeNote } from '../lib/basic-memory.js'

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-incremental-'))), project = join(dir, 'project')
  await mkdir(project)
  const config = { ttlDays: 30, basicMemoryConfig: join(dir, 'config') }
  const client = { search: async () => [], close: async () => {} }
  let store = new KnowledgeStore(join(dir, 'vault'), config, client)
  const instances = [store]
  t.after(async () => { for (const store of instances) await store.close(); await rm(dir, { recursive: true, force: true }) })
  const put = async (key, body, meta = {}) => {
    const path = join(store.folder(project), 'facts', `${key}.md`)
    await mkdir(join(store.folder(project), 'facts'), { recursive: true })
    await writeFile(path, encodeNote({ title: key, dsh_key: key, dsh_project: project, dsh_updated_at: Date.now(),
      dsh_status: 'verified', dsh_files: [], ...meta }, body))
    return path
  }
  return { dir, project, put, get store() { return store }, reload: () => {
    store = new KnowledgeStore(join(dir, 'vault'), config, client); instances.push(store); return store
  } }
}

async function eventually(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await delay(30) }
  assert.fail('Watcher did not reconcile the changed note')
}

test('incremental index restores a snapshot, reads only selected notes and recovers a corrupt snapshot', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 110; i++) await f.put(`note-${i}`, `普通记录 ${i}`)
  await f.put('target', '斑马草莓精确证据')
  assert.equal((await f.store.search(f.project, '斑马草莓'))[0].key, 'target')
  const index = f.store.indexFor(f.project)
  assert.equal(index.metrics.note_reads, 111)
  let reads = 0
  const original = f.store.readNotes.bind(f.store)
  f.store.readNotes = (...args) => { reads += args[1].length; return original(...args) }
  for (let i = 0; i < 5; i++) assert.equal((await f.store.search(f.project, 'target'))[0].key, 'target')
  assert.equal(reads, 5, 'warm queries must not re-read all Markdown')
  await f.store.close()
  f.reload()
  assert.equal((await f.store.search(f.project, '斑马草莓'))[0].key, 'target')
  const restored = f.store.indexFor(f.project)
  assert.equal(restored.metrics.snapshot_loaded, true)
  assert.equal(restored.metrics.note_reads, 0)
  assert.equal((await stat(restored.snapshot)).mode & 0o777, 0o600)
  await f.store.close()
  await writeFile(restored.snapshot, '{broken')
  f.reload()
  assert.equal((await f.store.search(f.project, '斑马草莓'))[0].key, 'target')
  assert.equal(f.store.indexFor(f.project).metrics.snapshot_loaded, false)
  assert.equal(f.store.indexFor(f.project).metrics.note_reads, 111)
})

test('Obsidian atomic saves, additions and deletions update the index; missed events reconcile without full body reads', async t => {
  const f = await fixture(t), path = await f.put('editable', '原始斑马')
  await f.store.search(f.project, 'editable')
  const index = f.store.indexFor(f.project)
  await delay(120) // Let the OS watch registration settle before simulating external edits.
  const raw = await readFile(path, 'utf8'), temp = `${path}.tmp`
  await writeFile(temp, raw.replace('原始斑马', '更新草莓')); await rename(temp, path)
  await eventually(async () => (await f.store.search(f.project, '更新草莓')).length === 1)
  await f.put('new-note', '新增小熊猫')
  await eventually(async () => (await f.store.search(f.project, '新增小熊猫')).length === 1)
  await unlink(path)
  assert.deepEqual(await f.store.search(f.project, 'editable'), [], 'deleted cached text must never be recalled')
  await index.watcher.close()
  await f.put('missed-event', '漏事件恢复标记')
  const before = index.metrics.note_reads
  await index.reconcile()
  assert.equal((await f.store.search(f.project, '漏事件恢复标记'))[0].key, 'missed-event')
  assert.equal(index.metrics.note_reads - before, 1)
  await index.reconcile()
  assert.equal(index.metrics.note_reads - before, 1, 'reconciliation stats files without re-reading unchanged bodies')
})

test('private notes never enter recall or snapshots, including when a cached note becomes private', async t => {
  const f = await fixture(t), path = await f.put('public', '公开证据')
  const secret = 'PRIVATE_CHINESE_CONTENT_隐私信息'
  await f.put('private', secret, { dsh_private: true })
  assert.deepEqual(await f.store.search(f.project, secret), [])
  assert.equal((await f.store.search(f.project, 'public'))[0].key, 'public')
  await writeFile(path, (await readFile(path, 'utf8')).replace('dsh_key: public', 'dsh_key: public\ndsh_private: true'))
  assert.deepEqual(await f.store.search(f.project, 'public'), [])
  const index = f.store.indexFor(f.project)
  await index.reconcile(); await index.persist()
  const snapshot = await readFile(index.snapshot, 'utf8')
  assert(!snapshot.includes(secret) && !snapshot.includes('公开证据'))
})

test('index failures fall back to the existing reader; cancellation and vault scope still apply', async t => {
  const f = await fixture(t)
  await f.put('export', 'exporter 中文子串检索')
  assert.equal((await f.store.search(f.project, 'port'))[0].key, 'export', 'English infix compatibility')
  const index = f.store.indexFor(f.project)
  index.error = true
  assert.equal((await f.store.search(f.project, '子串检索'))[0].key, 'export')
  index.error = false
  const controller = new AbortController(); controller.abort(new Error('cancel index read'))
  await assert.rejects(f.store.search(f.project, 'export', { signal: controller.signal }), /cancel index read/)
  const foreign = join(f.dir, 'foreign'); await mkdir(foreign)
  await writeFile(join(foreign, 'stolen.md'), encodeNote({ title: '逃逸', dsh_project: f.project }, 'FOREIGN_DATA'))
  await symlink(foreign, join(f.store.folder(f.project), 'outside'))
  await index.reconcile()
  assert.deepEqual(await f.store.search(f.project, 'FOREIGN_DATA'), [])
})

test('large projects use directory recursion and still observe external edits', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 1001; i++) await f.put(`large-${i}`, '大项目原始内容')
  assert.equal((await f.store.search(f.project, 'large-1000'))[0].key, 'large-1000')
  const index = f.store.indexFor(f.project)
  assert.equal(index.watcherMode, 'native-recursive')
  const path = join(f.store.folder(f.project), 'facts', 'large-1000.md')
  await writeFile(path, (await readFile(path, 'utf8')).replace('大项目原始内容', '大项目更新草莓'))
  await eventually(async () => (await f.store.search(f.project, '大项目更新草莓')).some(r => r.key === 'large-1000'))
  assert.equal(index.metrics.index_errors, 0)
})
