import { parseArgs } from 'node:util'
import { resolve, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { KnowledgeStore } from '../lib/basic-memory.js'

const { values } = parseArgs({ options: {
  vault: { type: 'string' }, project: { type: 'string' }, command: { type: 'string' }, 'config-dir': { type: 'string' },
  'seed-file': { type: 'string' }, 'no-activate': { type: 'boolean', default: false },
} })
for (const key of ['vault', 'project', 'command', 'config-dir']) {
  if (!values[key] || !isAbsolute(values[key])) throw new Error(`--${key} requires an absolute path`)
}
const root = values.vault, project = await realpath(values.project), configDir = values['config-dir']
await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(configDir, { recursive: true, mode: 0o700 })
const file = join(configDir, 'config.json')
let existing = {}
try { existing = JSON.parse(await readFile(file, 'utf8')) } catch (e) { if (e.code !== 'ENOENT') throw e }
if (existing.projects?.['dsh-knowledge']?.path && existing.projects['dsh-knowledge'].path !== root) throw new Error('Existing knowledge project points elsewhere; refusing to replace it')
await writeFile(file, JSON.stringify({ ...existing, default_project: 'dsh-knowledge',
  projects: { ...existing.projects, 'dsh-knowledge': { path: root, mode: 'local' } },
  semantic_search_enabled: false, reranker_enabled: false, auto_update: false,
  disable_permalinks: true, ensure_frontmatter_on_sync: false,
}, null, 2) + '\n', { mode: 0o600 })

const settings = { knowledgeRoot: root, basicMemoryCommand: values.command, basicMemoryConfig: configDir, knowledgeProject: project }
if (!values['no-activate']) {
  const dir = resolve(homedir(), '.local/share/dsh-memory-team')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const settingsFile = join(dir, 'settings.json')
  let previous = {}
  try {
    const old = await readFile(settingsFile, 'utf8')
    previous = JSON.parse(old)
    if (JSON.stringify(previous) !== JSON.stringify({ ...previous, ...settings })) await writeFile(`${settingsFile}.${Date.now()}.backup`, old, { mode: 0o600, flag: 'wx' })
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  await writeFile(settingsFile, JSON.stringify({ ...previous, ...settings }, null, 2) + '\n', { mode: 0o600 })
}

const store = new KnowledgeStore(root, { ttlDays: 30, basicMemoryConfig: configDir }, { close: async () => {} })
const readme = `# DSH 项目知识库\n\n本目录由 Basic Memory 索引，可直接在 Obsidian 中编辑。\n\n当前试点工作目录：${project}\n\n- projects/*/journal：每轮自动生成的任务记录；完成状态不代表结论已验证。\n- projects/*/facts：带证据的已验证经验。\n- 先编辑结论和证据正文，保留 YAML 中 dsh_ 开头的来源与项目字段。\n- 首版使用本地关键词检索，不调用额外总结模型；中文同义表达尚未做语义模型验收。\n- 本地笔记的命中片段会随正常请求发送给当前使用的模型。不要存储密钥或私人聊天全文。\n- 从模型工具删除的经验保存在 ${join(configDir, 'trash')}，更新前副本保存在 history。\n\n卸载 DSH 插件不会删除这些 Markdown 文件。\n`
try { await writeFile(join(root, 'README.md'), readme, { flag: 'wx', mode: 0o600 }) } catch (e) { if (e.code !== 'EEXIST') throw e }

if (values['seed-file']) {
  const rows = JSON.parse(await readFile(values['seed-file'], 'utf8'))
  if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.length !== 5 || row.some(value => typeof value !== 'string'))) throw new Error('Seed file requires rows of [key, title, kind, summary, evidence]')
  let created = 0
  for (const [key, title, kind, summary, evidence] of rows) {
    try { await store.save(project, { key, title, kind, summary, evidence, files: [] }, 'approved-mvp-setup'); created++ }
    catch (e) { if (!/Memory changed/.test(e.message)) throw e }
  }
  console.log(JSON.stringify({ seeded: created }))
}
console.log(JSON.stringify({ ...settings, projectFolder: store.folder(project), activated: !values['no-activate'] }, null, 2))
