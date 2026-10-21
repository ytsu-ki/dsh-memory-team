import { create, insert, remove, search, save, load } from '@orama/orama'
import { watch } from 'chokidar'
import { watch as watchDirectory } from 'node:fs'
import { mkdir, readFile, writeFile, rename, unlink, readdir, lstat, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { resolve, relative, dirname, sep, isAbsolute } from 'node:path'
import { withAbort } from './memory.js'

// Character pairs are a candidate superset for the existing substring matcher,
// including Chinese and English infixes. The existing ranker makes the final decision.
function tokenize(value) {
  const result = new Set()
  for (const word of value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}._-]+/gu) ?? []) {
    const chars = [...word]
    for (const char of chars) if (chars.length === 1 || /\p{Script=Han}/u.test(char)) result.add(char)
    for (let i = 0; i < chars.length - 1; i++) result.add(chars[i] + chars[i + 1])
  }
  return [...result]
}
const database = () => create({ schema: { content: 'string' }, sort: { enabled: false },
  components: { tokenizer: { language: 'dsh-pairs-v1', tokenize } } })
const signature = s => [s.size, s.mtimeNs, s.ctimeNs, s.ino, s.dev].map(String).join(':')
const hash = value => createHash('sha256').update(value).digest('hex')

export class KnowledgeIndex {
  constructor(store, project) {
    this.store = store; this.project = project; this.scope = store.folder(project)
    this.db = database(); this.entries = new Map(); this.signatures = new Map(); this.closed = false
    this.lifetime = new AbortController()
    this.metrics = { note_reads: 0, reconciliations: 0, snapshot_loaded: false, index_errors: 0 }
    this.snapshot = resolve(store.config.basicMemoryConfig, 'recall-index', `${hash(store.root + '\n' + project).slice(0, 32)}.json`)
    this.ready = this.initialize(); this.pending = this.ready
    this.ready.catch(() => { this.error = true; this.metrics.index_errors++ })
  }

  contains(path) {
    const p = relative(this.scope, path)
    return p && p !== '..' && !p.startsWith(`..${sep}`) && !isAbsolute(p) && path.endsWith('.md')
  }

  enqueue(operation) {
    const task = this.pending.catch(() => {}).then(async () => {
      if (this.closed) return
      try { return await operation() }
      catch (e) { this.error = true; this.metrics.index_errors++; throw e }
    })
    this.pending = task; task.catch(() => {})
    return task
  }

  async initialize() {
    this.policy = await withAbort(this.store.scanner.ready, this.lifetime.signal)
    this.lifetime.signal.throwIfAborted()
    try {
      if ((await stat(this.snapshot)).size > 128 * 1024 * 1024) throw new Error('Oversized index snapshot')
      const cached = JSON.parse(await readFile(this.snapshot, 'utf8'))
      if (cached.version !== 1 || cached.root !== this.store.root || cached.project !== this.project || cached.policy !== this.policy) throw new Error('Index identity changed')
      if (!Array.isArray(cached.entries) || !Array.isArray(cached.signatures)) throw new Error('Invalid index snapshot')
      load(this.db, cached.orama)
      this.entries = new Map(cached.entries); this.signatures = new Map(cached.signatures)
      if ([...this.entries.keys(), ...this.signatures.keys()].some(path => !this.contains(path))) throw new Error('Invalid index scope')
      this.metrics.snapshot_loaded = true
    } catch (e) {
      if (e.code !== 'ENOENT') this.metrics.index_errors++
      this.db = database(); this.entries.clear(); this.signatures.clear()
    }
    const paths = await this.list()
    await this.configureWatcher(paths.length)
    await this.reconcileNow(paths)
    this.timer = setInterval(() => this.reconcile().catch(() => {}), 60000); this.timer.unref()
  }

  async configureWatcher(count) {
    const mode = count > 1000 ? 'native-recursive' : 'chokidar'
    if (this.watcherMode === mode || this.closed) return
    const previous = this.watcher
    const changed = path => {
      if (this.closed) return
      if (path && this.contains(resolve(path))) {
        this.changed ??= new Set(); this.changed.add(resolve(path))
      } else this.reconcileNeeded = true
      clearTimeout(this.changeTimer)
      this.changeTimer = setTimeout(() => {
        const paths = [...this.changed ?? []]; this.changed?.clear()
        const reconcile = this.reconcileNeeded; this.reconcileNeeded = false
        this.enqueue(async () => {
          if (reconcile) await this.reconcileNow()
          else { await this.update(paths); this.persistSoon() }
        })
      }, 100)
      this.changeTimer.unref()
    }
    // Chokidar opens individual file handles on macOS; a large vault exhausted
    // the process limit in acceptance. Native recursion watches directories instead.
    if (mode === 'native-recursive') {
      this.watcher = watchDirectory(this.scope, { recursive: true, persistent: false }, (_event, name) => changed(name ? resolve(this.scope, String(name)) : null))
    } else {
      this.watcher = watch(this.scope, { ignoreInitial: true, followSymlinks: false, persistent: false,
        atomic: true, awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
        ignored: (path, info) => Boolean(info?.isFile() && !path.endsWith('.md')) })
      this.watcher.on('all', (_event, path) => changed(path))
    }
    this.watcher.on('error', () => { this.error = true; this.metrics.index_errors++ })
    this.watcherMode = mode
    await previous?.close()
  }

  async list(dir = this.scope, paths = []) {
    try {
      await this.store.directory(dir, false)
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name)
        if (entry.isDirectory()) await this.list(path, paths)
        else if (entry.isFile() && this.contains(path)) paths.push(path)
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e }
    return paths
  }

  async update(paths, force = false) {
    const changed = [], all = [...new Set(paths)].filter(path => this.contains(path)), directories = new Map()
    for (let i = 0; i < all.length; i += 64) {
      const updates = await Promise.all(all.slice(i, i + 64).map(async path => {
        this.lifetime.signal.throwIfAborted()
        let stamp
        try {
          const dir = dirname(path)
          if (!directories.has(dir)) directories.set(dir, this.store.directory(dir, false))
          await directories.get(dir)
          const info = await lstat(path, { bigint: true })
          if (info.isFile() && info.size <= 100000n) stamp = signature(info)
        } catch (e) { if (e.code !== 'ENOENT' && !/symbolic|escaped/.test(e.message)) throw e }
        return { path, stamp }
      }))
      for (const { path, stamp } of updates) {
        if (!stamp) { this.drop(path); this.signatures.delete(path) }
        else if (force || this.signatures.get(path) !== stamp) changed.push({ path, stamp })
      }
    }
    for (let i = 0; i < changed.length; i += 256) {
      const batch = changed.slice(i, i + 256)
      this.metrics.note_reads += batch.length
      const notes = await this.store.readNotes(this.project, batch.map(item => item.path), this.lifetime.signal)
      for (let j = 0; j < batch.length; j++) {
        const { path, stamp } = batch[j], note = notes[j]
        this.drop(path); this.signatures.set(path, stamp)
        if (note) {
          this.entries.set(path, note)
          insert(this.db, { id: path, content: `${note.meta.dsh_key ?? ''}\n${note.meta.title ?? ''}\n${note.body}` })
        }
      }
    }
    if (this.entries.size > 1000) await this.configureWatcher(this.entries.size)
  }

  drop(path) { if (this.entries.has(path)) remove(this.db, path); this.entries.delete(path) }

  async reconcileNow(paths = undefined) {
    paths ??= await this.list()
    const current = new Set(paths)
    for (const path of this.signatures.keys()) if (!current.has(path)) { this.drop(path); this.signatures.delete(path) }
    await this.update(paths)
    this.error = false; this.metrics.reconciliations++; this.persistSoon()
  }
  reconcile() { return this.enqueue(() => this.reconcileNow()) }
  refresh(path) { return this.enqueue(async () => { await this.update([path], true); this.persistSoon() }) }

  async candidates(query, signal, precise = true, keys = []) {
    await withAbort(this.ready, signal); await withAbort(this.pending, signal)
    if (this.error || this.closed) throw new Error('Incremental index unavailable')
    if (precise && query.trim()) {
      const keySet = new Set(keys), normalized = query.normalize('NFKC').toLowerCase()
      const exactKeys = [], exactTitles = []
      for (const [path, note] of this.entries) {
        const title = String(note.meta.title ?? '').normalize('NFKC').toLowerCase()
        if (keySet.has(note.meta.dsh_key)) exactKeys.push({ ...note, path })
        else if (note.meta.dsh_status === 'verified' && title.length >= 4 && normalized.includes(title)) exactTitles.push({ ...note, path })
      }
      const notes = exactKeys.length ? exactKeys : exactTitles
      if (notes.length) return { notes, precise: true }
    }
    const paths = query.trim() ? search(this.db, { term: query, threshold: 1, limit: this.entries.size }).hits.map(hit => hit.id) : [...this.entries.keys()]
    return { notes: paths.map(path => ({ ...this.entries.get(path), path })), precise: false }
  }

  persistSoon() {
    clearTimeout(this.persistTimer)
    if (this.closed) return
    this.persistTimer = setTimeout(() => this.enqueue(() => this.persist()).catch(() => {}), 500); this.persistTimer.unref()
  }
  async persist() {
    await mkdir(dirname(this.snapshot), { recursive: true, mode: 0o700 })
    const temp = `${this.snapshot}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, JSON.stringify({ version: 1, root: this.store.root, project: this.project, policy: this.policy,
        entries: [...this.entries], signatures: [...this.signatures], orama: save(this.db) }), { mode: 0o600, flag: 'wx' })
      await rename(temp, this.snapshot)
    } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e }) }
  }

  async close() {
    if (this.closed) return
    this.closed = true; clearInterval(this.timer); clearTimeout(this.persistTimer); clearTimeout(this.changeTimer)
    this.lifetime.abort(new Error('Knowledge index closed'))
    await this.ready.catch(() => {}); clearInterval(this.timer); clearTimeout(this.persistTimer); clearTimeout(this.changeTimer)
    await this.watcher?.close(); await this.pending.catch(() => {})
    // Only complete, healthy derived data can be used by the next process.
    if (!this.error) await this.persist().catch(() => {})
    this.entries.clear(); this.signatures.clear(); this.db = null
  }
}
