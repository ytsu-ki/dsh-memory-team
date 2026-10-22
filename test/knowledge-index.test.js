import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, readFile, writeFile, appendFile, rename, unlink, rm, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { KnowledgeStore, encodeNote } from '../lib/basic-memory.js'
import { KnowledgeIndex } from '../lib/knowledge-index.js'
import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync } from 'node:fs'

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
  if (process.platform !== 'win32') assert.equal((await stat(restored.snapshot)).mode & 0o777, 0o600)
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
  await symlink(foreign, join(f.store.folder(f.project), 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
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

test('watch creation and runtime errors retain metadata reconciliation and recover without stale/private recall', async t => {
  const f = await fixture(t)
  const path = await f.put('before', '监听失败前的证据')
  const create = KnowledgeIndex.prototype.createWatcher
  const failed = t.mock.method(KnowledgeIndex.prototype, 'createWatcher', () => { throw Object.assign(new Error('private path omitted'), { code: 'EPERM' }) })
  assert.equal((await f.store.search(f.project, 'before'))[0].key, 'before')
  const index = f.store.indexFor(f.project)
  assert(index.timer, 'watch creation failure must not prevent periodic reconciliation')
  assert.equal(index.watcherMode, 'metadata-only'); assert.equal(index.watcherError, 'EPERM')
  assert.equal(Boolean(index.error), false, 'watch failure and index failure have separate health')
  await f.put('during', '监听故障期间新增证据')
  await writeFile(path, (await readFile(path, 'utf8')).replace('dsh_key: before', 'dsh_key: before\ndsh_private: true'))
  await index.reconcile()
  assert.equal(index.watcherError, 'EPERM', 'a successful metadata scan cannot claim the watcher recovered')
  assert.equal((await f.store.search(f.project, 'during'))[0].key, 'during')
  assert.deepEqual(await f.store.search(f.project, 'before'), [])
  failed.mock.restore()
  index.watcherRetryAt = 0
  await index.reconcile()
  assert.equal(index.watcherMode, process.platform === 'win32' ? 'native-recursive' : 'chokidar'); assert.equal(index.watcherError, null)
  await delay(120)
  const old = index.watcher
  old.emit('error', Object.assign(new Error('removed'), { code: 'EPERM' }))
  await index.watcherClosing
  assert.equal(index.watcher, null); assert.equal(index.watcherError, 'EPERM')
  await index.reconcile()
  assert.equal(index.watcher, null, 'reconciliation must not repeatedly rebuild a failed watcher')
  index.watcherRetryAt = 0
  await index.reconcile()
  assert.notEqual(index.watcher, old); assert.equal(index.watcherError, null)
  await delay(120)
  await f.put('after', '监听恢复后新增草莓')
  await eventually(async () => (await f.store.search(f.project, '监听恢复后新增草莓')).length === 1)
  assert.equal(index.createWatcher, create)
})

test('directory replacement or deletion invalidates the watcher and rebuilds from current files', async t => {
  const f = await fixture(t)
  await f.put('removed', '不能召回被移走的内容')
  await f.store.search(f.project, 'removed')
  const index = f.store.indexFor(f.project), previous = index.watcher
  await rename(index.scope, `${index.scope}-old`)
  await index.reconcile()
  assert.equal(index.watcherMode, 'metadata-only')
  assert.equal(index.watcherError, 'ENOENT')
  assert.deepEqual(await f.store.search(f.project, 'removed'), [])
  await f.put('replacement', '重建目录后的新证据')
  await index.reconcile()
  assert.equal(index.watcherError, null); assert.notEqual(index.watcher, previous)
  assert.equal((await f.store.search(f.project, 'replacement'))[0].key, 'replacement')
  assert.deepEqual(await f.store.search(f.project, 'removed'), [])
  const identity = index.watcherIdentity, replacementWatcher = index.watcher
  await rename(index.scope, `${index.scope}-replaced`)
  await f.put('current', '同路径替换后的新内容')
  await index.reconcile()
  assert.notEqual(index.watcherIdentity, identity)
  assert.notEqual(index.watcher, replacementWatcher)
  assert.equal((await f.store.search(f.project, 'current'))[0].key, 'current')
  assert.deepEqual(await f.store.search(f.project, 'replacement'), [])
})

function syntheticWatcher(t) {
  const watchers = []
  t.mock.method(KnowledgeIndex.prototype, 'createWatcher', (_mode, changed) => {
    const watcher = new EventEmitter()
    watcher.changed = changed
    watcher.close = () => { watcher.closed = true }
    watchers.push(watcher)
    return watcher
  })
  return watchers
}

test('watcher registration catches files written after the preceding scan, including after root replacement', async t => {
  const f = await fixture(t)
  await f.put('seed', '旧目录中的证据')
  let generation = 0
  t.mock.method(KnowledgeIndex.prototype, 'createWatcher', function () {
    const key = `late-${++generation}`
    writeFileSync(join(this.scope, 'facts', 'late.md'), encodeNote({ title: key, dsh_key: key,
      dsh_project: f.project, dsh_updated_at: Date.now(), dsh_status: 'verified', dsh_files: [],
    }, `监听建立前写入的第 ${generation} 代证据`))
    // No event is delivered for a write completed before registration.
    const watcher = new EventEmitter()
    watcher.close = () => {}
    return watcher
  })
  await f.store.search(f.project, 'seed')
  const index = f.store.indexFor(f.project)
  await eventually(() => [...index.entries.values()].some(note => note.meta.dsh_key === 'late-1'))
  await rename(index.scope, `${index.scope}-old`)
  await mkdir(join(index.scope, 'facts'), { recursive: true })
  await index.reconcile()
  await eventually(() => [...index.entries.values()].some(note => note.meta.dsh_key === 'late-2'))
  assert.equal((await f.store.search(f.project, 'late-2'))[0].key, 'late-2')
  assert(!(await f.store.search(f.project, 'late-1')).some(record => record.key === 'late-1'))
})

test('twenty directory replacements recover through notifications without manual reconciliation or fixed sleeps', async t => {
  const f = await fixture(t)
  await f.put('initial', '初始证据')
  await f.store.search(f.project, 'initial')
  const index = f.store.indexFor(f.project)
  for (let i = 0; i < 20; i++) {
    await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
      "import { rename } from 'node:fs/promises'; await rename(process.argv[1], process.argv[2])",
      index.scope, `${index.scope}-old-${i}`], { timeout: 10000 })
    await f.put(`passive-${i}`, `第 ${i} 次被动恢复的证据`)
    await eventually(async () => (await f.store.search(f.project, `passive-${i}`)).some(record => record.key === `passive-${i}`))
    const previous = i ? `passive-${i - 1}` : 'initial'
    assert(!(await f.store.search(f.project, previous)).some(record => record.key === previous))
  }
  assert.equal(Boolean(index.error), false)
  assert.equal(index.watcherError, null)
})

test('continuous notifications flush while edits continue and event bursts keep a bounded queue', async t => {
  const watchers = syntheticWatcher(t), f = await fixture(t)
  const path = await f.put('stream', '原始内容')
  await f.store.search(f.project, 'stream')
  const index = f.store.indexFor(f.project), watcher = watchers.at(-1)
  await writeFile(path, (await readFile(path, 'utf8')).replace('原始内容', '持续通知中的最终证据'))
  const timer = setInterval(() => watcher.changed(path), 20)
  t.after(() => clearInterval(timer))
  watcher.changed(path)
  await eventually(() => index.entries.get(path)?.body.includes('持续通知中的最终证据'))
  clearInterval(timer)
  for (let i = 0; i < 10000; i++) watcher.changed(join(index.scope, 'facts', `burst-${i}.md`))
  assert(index.changed.size <= 2048, 'burst paths must not grow without a bound')
  await eventually(() => index.metrics.watcher_overflows > 0 && !index.watchFlushPending && !index.changeTimer)
  assert.equal(watcher.closed, undefined, 'ordinary batch edits must not disable the watcher')
  assert((await f.store.search(f.project, '持续通知中的最终证据')).length === 1)
})

test('directory deletion without a watcher error closes the obsolete handle and recovers a new directory', async t => {
  const watchers = syntheticWatcher(t), f = await fixture(t)
  await f.put('old', '旧目录证据')
  await f.store.search(f.project, 'old')
  const index = f.store.indexFor(f.project), old = watchers.at(-1)
  await rename(index.scope, `${index.scope}-old`)
  const timer = setInterval(() => old.changed(index.scope), 5)
  t.after(() => clearInterval(timer))
  old.changed(index.scope)
  await eventually(() => old.closed)
  clearInterval(timer)
  await index.reconcile()
  assert.equal(index.watcherMode, 'metadata-only')
  assert.deepEqual(await f.store.search(f.project, 'old'), [])
  await f.put('new', '新目录证据')
  await index.reconcile()
  assert.notEqual(index.watcher, old)
  old.changed(join(index.scope, 'facts', 'old.md'))
  assert.equal((await f.store.search(f.project, 'new'))[0].key, 'new')
  assert.deepEqual(await f.store.search(f.project, 'old'), [])
})

test('a file changed during reading is deferred instead of persisting an inconsistent note', async t => {
  const f = await fixture(t), path = await f.put('racing', '原始内容')
  await f.store.search(f.project, 'racing')
  const index = f.store.indexFor(f.project), read = f.store.readNotes.bind(f.store)
  await writeFile(path, (await readFile(path, 'utf8')).replace('原始内容', '读取过程中的中间内容'))
  let mutate = true
  f.store.readNotes = async (...args) => {
    const notes = await read(...args)
    if (mutate) {
      mutate = false
      await writeFile(path, (await readFile(path, 'utf8')).replace('读取过程中的中间内容', '写入完成后的最终内容'))
    }
    return notes
  }
  await index.refresh(path)
  assert(!index.entries.get(path)?.body.includes('读取过程中的中间内容'))
  await eventually(() => index.entries.get(path)?.body.includes('写入完成后的最终内容'))
  await index.persist()
  assert(!(await readFile(index.snapshot, 'utf8')).includes('读取过程中的中间内容'))
})

test('native recursion allows cross-process directory replacement and closes obsolete handles', async t => {
  const f = await fixture(t)
  await f.put('initial', '初始证据')
  await f.store.search(f.project, 'initial')
  const index = f.store.indexFor(f.project), obsolete = []
  let closed = 0
  for (let i = 0; i < 10; i++) {
    await index.configureWatcher(1001)
    assert.equal(index.watcherMode, 'native-recursive')
    const watcher = index.watcher
    watcher.once('close', () => closed++)
    obsolete.push(watcher)
    await promisify(execFile)(process.execPath, ['--input-type=module', '--eval',
      "import { rename } from 'node:fs/promises'; await rename(process.argv[1], process.argv[2])",
      index.scope, `${index.scope}-old-${i}`], { timeout: 10000 })
    await f.put(`current-${i}`, `第 ${i} 轮替换后的证据`)
    await index.reconcile()
    assert.equal((await f.store.search(f.project, `current-${i}`))[0].key, `current-${i}`)
    const previousKey = i ? `current-${i - 1}` : 'initial'
    assert(!(await f.store.search(f.project, previousKey)).some(record => record.key === previousKey), 'old keys must disappear even when fuzzy search matches a new title')
  }
  await eventually(() => closed === obsolete.length)
  assert.equal(Boolean(index.error), false)
  assert.equal(index.watcherError, null, 'expected directory replacement must recover a healthy watcher')
})

test('native notifications wait for chunked Markdown writes before updating derived state', async t => {
  const f = await fixture(t), path = await f.put('chunks', '原始稳定内容')
  await f.store.search(f.project, 'chunks')
  const index = f.store.indexFor(f.project)
  await index.configureWatcher(1001)
  await delay(120)
  let partial = false
  const timer = setInterval(() => {
    const body = index.entries.get(path)?.body ?? ''
    if (body.includes('WRITE_BEGIN') && !body.includes('WRITE_END')) partial = true
  }, 10)
  t.after(() => clearInterval(timer))
  await writeFile(path, (await readFile(path, 'utf8')).replace('原始稳定内容', 'WRITE_BEGIN'))
  for (let i = 0; i < 4; i++) { await delay(40); await appendFile(path, ` 第${i}段`) }
  await appendFile(path, ' WRITE_END')
  await eventually(() => index.entries.get(path)?.body.includes('WRITE_END'))
  clearInterval(timer)
  assert.equal(partial, false, 'derived state must not publish a partially written note')
})

test('metadata reconciliation also waits for stable content with a non-native watcher', async t => {
  syntheticWatcher(t)
  const f = await fixture(t), path = await f.put('metadata-chunks', '原始稳定内容')
  await f.store.search(f.project, 'metadata-chunks')
  const index = f.store.indexFor(f.project)
  await delay(150)
  let partial = false
  const timer = setInterval(() => {
    const body = index.entries.get(path)?.body ?? ''
    if (body.includes('WRITE_BEGIN') && !body.includes('WRITE_END')) partial = true
  }, 10)
  t.after(() => clearInterval(timer))
  await writeFile(path, (await readFile(path, 'utf8')).replace('原始稳定内容', 'WRITE_BEGIN'))
  const writing = (async () => {
    for (let i = 0; i < 4; i++) { await delay(40); await appendFile(path, ` 第${i}段`) }
    await appendFile(path, ' WRITE_END')
  })()
  await index.reconcile()
  await writing
  await index.reconcile()
  assert.equal(partial, false, 'a metadata scan cannot bypass the write stability check')
  assert(index.entries.get(path)?.body.includes('WRITE_END'))
})
