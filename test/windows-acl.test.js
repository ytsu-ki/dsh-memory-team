import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, copyFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MemoryStore } from '../lib/memory.js'
import { KnowledgeStore } from '../lib/basic-memory.js'
import { inspectWindowsAcl } from '../lib/windows-acl.js'

test('ACL paths are data, including quotes and PowerShell syntax; failures are reported without raw stderr', async () => {
  const path = "C:\\中文 空格\\'quoted\" $();`target.sqlite"
  const result = { path, owner: 'LOCAL\\owner', inheritance_disabled: false, rules: [] }
  const executeFile = async (file, args, options) => {
    assert.equal(file, 'powershell.exe'); assert(args.includes('-Command')); assert(!args.includes('-File'))
    assert(!args.some(arg => arg.includes(path)))
    assert.equal(options.env.DSH_ACL_TARGET, path)
    assert.match(args.at(-1), /Get-Acl -LiteralPath/)
    assert(!/Set-ExecutionPolicy|Bypass|Invoke-Expression/.test(args.join(' ')))
    return { stdout: '\uFEFF' + JSON.stringify(result) }
  }
  assert.deepEqual(await inspectWindowsAcl(path, { executeFile }), result)
  await assert.rejects(inspectWindowsAcl(path, { executeFile: async () => {
    throw Object.assign(new Error('PRIVATE_STDERR'), { code: 1, stderr: 'PRIVATE_STDERR' })
  } }), error => error.code === 'ACL_DIAGNOSTIC_UNAVAILABLE' && !error.message.includes('PRIVATE_STDERR'))
  await assert.rejects(inspectWindowsAcl(path, { executeFile: async () => ({ stdout: '{}' }) }), { code: 'ACL_INVALID_RESPONSE' })
})

test('Windows ACL diagnostics inspect actual SQLite and index files without claiming POSIX permissions', {
  skip: process.platform !== 'win32' && 'Windows ACL inspection requires PowerShell on Windows',
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acl-')), project = join(dir, 'project'), database = join(dir, 'memory.sqlite')
  await mkdir(project)
  const sqlite = new MemoryStore(database)
  const knowledge = new KnowledgeStore(join(dir, 'vault'), { ttlDays: 30, basicMemoryConfig: join(dir, 'config') }, { search: async () => [], close: async () => {} })
  t.after(async () => { await knowledge.close(); sqlite.close(); await rm(dir, { recursive: true, force: true }) })
  await knowledge.save(project, { key: 'acl-probe', title: 'ACL probe', kind: 'fact', summary: 'Synthetic local evidence.', evidence: 'Acceptance fixture.', files: [] }, 'acl-test')
  await knowledge.search(project, 'acl-probe')
  const index = knowledge.indexFor(project); await index.persist()
  const entries = await Promise.all([database, index.snapshot].map(path => inspectWindowsAcl(path)))
  assert.equal(entries.length, 2)
  assert(entries.every(entry => entry.owner && entry.rules.length && typeof entry.inheritance_disabled === 'boolean'))
  t.diagnostic(`Read-only ACL evidence (effective access is not inferred): ${JSON.stringify(entries)}`)
})

test('the Node ACL entry point works from a disposable low-integrity source directory', {
  skip: process.platform !== 'win32' && 'Low-integrity labels require Windows',
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acl-low-')), low = join(dir, "低完整性 ' $dsh"), target = join(low, '普通 数据.txt')
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(join(low, 'lib'), { recursive: true }); await mkdir(join(low, 'scripts'))
  await copyFile(fileURLToPath(new URL('../lib/windows-acl.js', import.meta.url)), join(low, 'lib', 'windows-acl.js'))
  await copyFile(fileURLToPath(new URL('../scripts/inspect-windows-acl.mjs', import.meta.url)), join(low, 'scripts', 'inspect-windows-acl.mjs'))
  await writeFile(join(low, 'package.json'), '{"type":"module"}')
  await writeFile(target, 'Synthetic read-only ACL fixture')
  await promisify(execFile)('icacls.exe', [low, '/setintegritylevel', '(OI)(CI)L', '/T'], { windowsHide: true })
  const { stdout } = await promisify(execFile)(process.execPath, [join(low, 'scripts', 'inspect-windows-acl.mjs'), target], {
    timeout: 15000, windowsHide: true, encoding: 'utf8',
  })
  const acl = JSON.parse(stdout)
  assert.equal(acl.path, target); assert(acl.owner && Array.isArray(acl.rules))
})
