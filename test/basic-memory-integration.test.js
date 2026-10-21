import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as plugin from '../lib/memory-team.js'
import { scopeOf, decodeNote, encodeNote } from '../lib/basic-memory.js'

const command = process.env.BASIC_MEMORY_TEST_COMMAND
async function eventually(check, message) {
  const deadline = Date.now() + 30000
  do {
    const value = await check()
    if (value) return value
    await delay(500)
  } while (Date.now() < deadline)
  assert.fail(message)
}

test('real Basic Memory MCP and DSH loop: Chinese recall, automatic journal, external edits, isolation and outage', {
  skip: !command && 'Set BASIC_MEMORY_TEST_COMMAND to the Basic Memory executable', timeout: 120000,
}, async t => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-bm-acceptance-')))
  const project = join(dir, 'project'), root = join(dir, 'vault'), configDir = join(dir, 'config')
  await mkdir(project); await mkdir(join(project, '.git')); await mkdir(root); await mkdir(configDir)
  await writeFile(join(configDir, 'config.json'), JSON.stringify({ default_project: 'dsh-knowledge',
    projects: { 'dsh-knowledge': { path: root, mode: 'local' } }, semantic_search_enabled: false, reranker_enabled: false,
    auto_update: false, disable_permalinks: true, ensure_frontmatter_on_sync: false,
  }))
  const facts = join(root, 'projects', scopeOf(project), 'facts')
  await mkdir(facts, { recursive: true })
  for (let i = 0; i < 106; i++) {
    const target = i === 105, key = `index-${String(i).padStart(3, '0')}`
    const title = target ? 'MVP_COMMON 缓存代次复现' : `MVP_COMMON 旧记录 ${i}`
    await writeFile(join(facts, `${key}.md`), encodeNote({ title, type: 'note', dsh_project: project,
      dsh_key: key, dsh_kind: 'fact', dsh_status: 'verified', dsh_updated_at: Date.now(), dsh_files: [],
    }, `# ${title}\n\n${target ? '用 entry 身份保护在途缓存代次。' : '旧的无关内容。'}\n\n## 检索词\nmvp_common 缓存 代次 复现`))
  }
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  ctx.provide('subagents', { listChildren: async () => [] })
  const harness = await mountAgentLoopTestHarness(ctx), requests = []
  let hold = false, entered
  class Adapter extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      if (hold) {
        entered()
        await delay(60000, undefined, { signal: options.signal })
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '论文导出已核对焦点。验收夹具完成。' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '论文导出已核对焦点。验收夹具完成。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['test'], new Adapter())
  const config = { database: join(dir, 'legacy.sqlite'), knowledgeRoot: root, knowledgeProject: '',
    basicMemoryCommand: command, basicMemoryConfig: configDir, betterleaksCommand: process.env.BETTERLEAKS_TEST_COMMAND ?? '' }
  let fiber = ctx.plugin(plugin, config); await fiber
  const create = label => harness.create(label, { provider: 'test', model: 'test' }, { cwd: project })
  const agent = await create('first')
  const invoke = (name, args, a = agent) => ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent: a, signal: new AbortController().signal })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'MVP_COMMON 缓存代次复现' }] }))
  await agent.whenIdle()
  const firstRecall = requests[0].messages.find(m => m.source?.kind === 'dsh-memory-team')
  assert(firstRecall && JSON.stringify(firstRecall.content).includes('用 entry 身份保护'), 'cold first task must rank the target beyond 100 indexed candidates without prewarming')
  await eventually(async () => (await invoke('project_memory_status', {})).value?.service === 'ready', 'MCP did not become ready')
  const saved = await invoke('project_memory_save', { key: 'export-focus', title: '论文导出验收', kind: 'pitfall',
    summary: '论文导出前确认浏览器焦点。', evidence: '本地验收夹具。', files: [] })
  assert.equal(saved.isError, false, JSON.stringify(saved))
  await eventually(async () => (await invoke('project_memory_search', { query: '论文导出' })).value?.records?.some(r => r.key === 'export-focus'), 'Chinese keywords were not indexed')

  const run = async (a, text) => {
    a.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await a.whenIdle()
  }
  await run(agent, '检查论文导出与浏览器焦点')
  const journalDir = join(root, 'projects', scopeOf(project), 'journal')
  const journals = await eventually(async () => { try { const files = await readdir(journalDir); return files.length && files } catch (e) { if (e.code !== 'ENOENT') throw e } }, 'Task journal was not captured')
  const journal = decodeNote(await readFile(join(journalDir, journals[0]), 'utf8'))
  assert.equal(journal.meta.dsh_status, 'completed')
  assert.match(journal.body, /未经独立验证/)
  assert.match(journal.body, /验收夹具完成/)
  await eventually(async () => (await invoke('project_memory_search', { query: '验收夹具完成' })).value?.records?.some(r => r.kind === 'task-record'), 'Completed journal was not indexed')
  const fresh = await create('fresh')
  await run(fresh, '检查论文导出与浏览器焦点')
  const recalled = requests.at(-1).messages.filter(m => m.source?.kind === 'dsh-memory-team').at(-1)
  assert(recalled, 'Fresh session received no automatic recall')
  assert.match(recalled.content[0].text, /确认浏览器焦点/)
  assert(recalled.content[0].text.length <= 6000)
  assert.equal(requests.length, 3, 'Capture must not make an extra model call')

  hold = true
  const interrupted = await create('interrupted')
  const started = new Promise(resolve => { entered = resolve })
  interrupted.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '中止验收夹具' }] }))
  await started; interrupted.cancel({ kind: 'user' }); await interrupted.whenIdle(); hold = false
  await eventually(async () => {
    const files = await readdir(journalDir)
    for (const file of files) {
      const note = decodeNote(await readFile(join(journalDir, file), 'utf8'))
      if (note.meta.dsh_source_session === interrupted.id) {
        assert.equal(note.meta.dsh_status, 'aborted'); assert.match(note.body, /未经独立验证/)
        return true
      }
    }
  }, 'User-aborted turn was not recorded as aborted')

  const raw = await readFile(saved.value.path, 'utf8')
  await writeFile(saved.value.path, raw.replace('论文导出前确认浏览器焦点。', '论文导出先核对斑马草莓验收 MVP_EDIT_MARKER。'))
  const edited = await eventually(async () => (await invoke('project_memory_search', { query: 'MVP_EDIT_MARKER' })).value?.records?.find(r => r.key === 'export-focus'), 'External Markdown edit was not reindexed')
  assert.match(edited.summary, /斑马草莓/)
  assert.notEqual(edited.revision, saved.value.revision)
  const other = join(dir, 'other'); await mkdir(other); await mkdir(join(other, '.git'))
  const foreign = await harness.create('foreign', { provider: 'test', model: 'test' }, { cwd: other })
  const foreignSaved = await invoke('project_memory_save', { key: 'foreign-export', title: '论文导出 OTHER_PROJECT_ONLY', kind: 'fact',
    summary: '这是其他项目的记录。', evidence: '隔离验收夹具。', files: [] }, foreign)
  assert.equal(foreignSaved.isError, false)
  await eventually(async () => (await invoke('project_memory_search', { query: 'OTHER_PROJECT_ONLY' }, foreign)).value?.records?.length, 'Other project was not indexed')
  const isolated = await invoke('project_memory_search', { query: '论文导出' }, foreign)
  assert.deepEqual(isolated.value.records.map(r => r.key), ['foreign-export'])
  const main = await invoke('project_memory_search', { query: 'OTHER_PROJECT_ONLY' })
  assert.deepEqual(main.value.records, [])

  await fiber.dispose()
  fiber = ctx.plugin(plugin, { ...config, basicMemoryCommand: join(dir, 'missing-basic-memory') }); await fiber
  const offline = await create('offline')
  await run(offline, '后端离线时继续论文导出验收')
  assert.equal(requests.length, 5)
  const last = offline.session.eventAt(offline.session.seq - 1)
  assert.equal(last.type, 'turn/end'); assert.equal(last.data.reason.kind, 'completed')
  assert(requests.at(-1).messages.some(m => m.source?.kind === 'dsh-memory-team' && JSON.stringify(m.content).includes('斑马草莓')),
    'canonical local recall must survive a Basic Memory service outage')

  await fiber.dispose()
  fiber = ctx.plugin(plugin, config); await fiber
  const cold = await create('cold-start-without-prewarm')
  assert.equal((await invoke('project_memory_status', {}, cold)).value.service, 'starting')
  await run(cold, '检查论文导出与浏览器焦点')
  assert.equal(requests.length, 6)
  assert(requests.at(-1).messages.some(m => m.source?.kind === 'dsh-memory-team' && JSON.stringify(m.content).includes('斑马草莓')),
    'first task after startup must recall existing Markdown without a manual warmup')

  await fiber.dispose()
  fiber = ctx.plugin(plugin, { ...config, betterleaksCommand: join(dir, 'missing-secret-scanner') }); await fiber
  const scanFailure = await create('scanner-outage')
  await run(scanFailure, '检查论文导出与浏览器焦点')
  assert.equal(requests.length, 7)
  assert.equal(scanFailure.session.eventAt(scanFailure.session.seq - 1).data.reason.kind, 'completed')
  assert(!requests.at(-1).messages.some(m => m.source?.kind === 'dsh-memory-team'),
    'configured scanner failures must withhold memory while letting the main task complete')
})
