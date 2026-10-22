# dsh-memory-team [Beta / 实验性阶段]

<img src="./icon.jpg" alt="项目记忆与协作图标" width="160" />

非官方项目，由社区成员独立开发和维护。

## 关于当前版本的说明与致歉

本项目仍处于早期开发与测试阶段，架构、稳定性和兼容性验证尚不完善。出发点是通过本地知识库、子agent协作，解决deepseek模型的长时间思考问题，避免DSH实际使用过程中进入“深度睡眠”，人被硬控1个多小时的情况，致力于优化体验、提供便捷。给遇到问题的用户带来的不便，在此致歉；也感谢大家愿意提供反馈、帮助改进。

目前的实际桌面验收平台是 **macOS arm64**。beta.2 已在 Windows Node 22.17.0 / 24.18.0 完成自动化测试（各 76 通过、0 失败、3 跳过），权限诊断与安装包新进程验证通过。本版新增监听重建后的补扫及元数据校对稳定性修复；对应提交的三平台自动化结果见 [Actions](https://github.com/ytsu-ki/dsh-memory-team/actions)，Windows 桌面端两次完整冷启动尚未完成。当前版本不建议直接启用到承担重要任务的主 profile；需要体验时请先备份配置、会话和知识库，并使用独立测试 profile。

1. **应急恢复**：若出现宿主启动故障弹窗，可点击 **Disable third-party plugins, back up profile patch, and restart**。这个恢复操作会禁用第三方插件、备份 profile patch 并尝试重启宿主，其他第三方插件也会受到影响。若仍无法启动，请保留诊断日志和备份继续排查；不要把删除知识库或会话作为默认恢复步骤。
2. **提交反馈**：请使用 [故障反馈模板](https://github.com/ytsu-ki/dsh-memory-team/issues/new?template=bug_report.yml)，附上弹窗 **Diagnostic report** 指向的 `crash-...-host.log`。日志请尽量保留开头的 **Failed plugins**、第一条异常及完整堆栈，并注明 DSH 版本、系统、安装方式和复现步骤。提交前请遮盖密钥、令牌及其他私人信息。

这份说明用于提示当前风险，**不代表反馈中的启动故障已经修复**；修复与验证结果会在后续版本记录中说明。

DeepSeek Harness 的项目记忆与子 agent 协作插件。目标是减少重复探索、重复验证和串行调查，不给模型请求设置时间上限。

适配并测试 **Harness 0.2.1-rc.2**。当前试用版本 **0.5.3-beta.3**，安装包、源码包及校验值以 [Releases](https://github.com/ytsu-ki/dsh-memory-team/releases) 为准。Windows 修复内容、安装与验收步骤见 [Windows 验收说明](docs/windows-acceptance.md)。旧版流式限时插件的代码留在 `lib/index.js` 和 `docs/legacy-stream-guard.md`，新安装入口不会启用它。

## 记忆库与子 agent 分别解决什么问题

| 能力 | 针对 DSH 实际运行中的问题 | 工作方式与边界 |
| --- | --- | --- |
| 项目记忆库 | 跨会话忘记已经验证的结论、重复读文件、重走失败方案、重复调查同一个项目 | 在当前项目内检索少量相关经验，把结论和证据带入新任务。没有相关记录时返回无命中；过期或关联文件变化的记录停止自动引用。它减少重复探索，不能直接提高模型生成速度，也不应代替当前验证。 |
| 子 agent 协作 | 多个相互独立的调查或审查只能串行处理，主 agent 为此反复切换上下文 | 把有明确范围和验收条件的独立问题交给最多两个原生子 agent，主 agent 继续处理自己的工作，再汇总证据并验收。简单任务和存在先后依赖的任务通常由主 agent 处理；并行可能增加总 token 与请求数量，不保证总耗时下降。 |

两者配合时，先用已有记忆明确哪些结论仍适用，再把剩余独立问题分工，最后由主 agent 验证并保存可复用结论。**Obsidian 只是可选的 Markdown 编辑器**，不安装也可以使用默认 SQLite 记忆与原生协作。

模型服务或代理故障、单次长推理、工具程序本身运行缓慢，仍需分别排查；这两项能力不通过强制结束任务来缩短耗时。

## 工作方式

**项目记忆**：配置知识目录后，Basic Memory 索引 Markdown，Obsidian 直接编辑同一批文件。新用户任务进入模型前，按关键词自动带入最多 3 条、合计最多 6000 字符的记录。关闭语义模型和额外总结模型；使用确定性的本地关键词排序，不保证同义表达召回。记忆以真实项目路径隔离：向上找到最近的 `.git`，没有 Git 时使用当前工作目录；默认不使用 home 或磁盘根目录上的 Git 仓库合并子目录。可配置绝对路径 `projectRoot`，只对该目录及其子目录使用显式作用域，无关目录继续自动识别；有意将 home 作为共享项目时需显式配置。不同 worktree 默认分开保存。旧 home 作用域记录保留，不自动迁移或混入新项目；修改作用域后需先核对记录归属再手动迁移。未配置知识目录的项目继续使用原 SQLite。

**增量检索**：Markdown 仍是原始数据，Orama 3.1.18 保存可重建的本地索引。首次读取项目笔记并建立索引；重启后加载与知识库、项目及扫描规则绑定的快照，核对文件元数据，只重读变化的笔记。常规检索只重新读取排在前面的候选并校验文件指纹，不逐轮读取全部笔记，也不等待 Basic Memory MCP 就绪。Basic Memory 继续运行，供原有索引与编辑工作流使用；增量索引异常时可回退旧 MCP/Markdown 路径。

中文与英文沿用原有的子串匹配和确定性排序：过滤通用指令词，按精确 key、已验证状态、完整标题和词项相关性排序。命中精确 key 或已验证记录的完整标题后，只返回对应条目，不用通用操作说明填满余下位置。Orama 使用适配中文的字符对索引收集候选，不引入 embedding 或总结模型。

Windows 项目统一使用 Node 原生递归监听，避免逐个子目录句柄阻碍父目录改名；其他平台最多 1000 个文件使用 Chokidar 5.0.0，更大的项目使用原生递归监听。事件合并后增量更新；每 60 秒核对文件元数据以修复漏事件，未改变的正文不重读。监听创建失败或发生错误时关闭旧监听器，降级为 `metadata-only`，定期核对继续运行并尝试恢复监听；目录身份变化也会重建监听器。索引可用与监听健康分别报告，成功核对不会掩盖持续的监听错误。降级期间新外部内容可能需等到下一次核对后才能检索。命中的旧内容在返回前会重读，删除或转为私密的记录不能仅凭缓存召回。持续写入期间可能暂时检索失败，任务会带诊断继续。索引有内存、磁盘与首次建立成本，不保证所有项目的首次查询更快。

每条记忆包含稳定 key、结论、类型、证据、来源会话、更新时间、版本号和可选文件指纹。关联文件变化、丢失或记录超过 30 天后，不再自动引用；手动搜索可查看失效记录。Markdown 版本由文件内容计算，手动编辑会使旧版本失效；同一进程的并发替换只允许一个成功。更新前保留 history 副本，工具删除移入 trash。与外部编辑器同时保存仍存在文件系统竞争，应先搜索最新版本再更新。

**自动记录**：试点项目每个父任务轮次结束后，直接复用请求片段、最后文本答复、结束状态、工具名称统计和来源生成 `journal/*.md`。不另发总结请求，不保存内部推理、工具参数或完整工具输出。正常完成、失败、中止分别记录；完成只代表轮次正常结束，记录均标为未经独立验证。重复结束事件不会重复落盘，子 agent 不重复生成记录。最后答复最多 6000 字符、请求最多 1000 字符，常见凭据自动遮盖。

主 agent 仍通过工具把验证后的结论保存到 `facts/*.md`。不自动导入全部历史聊天，首批资料通过明确的种子文件导入。过期只是停止自动引用，不删除文件。正常检索不依赖 MCP 初始化或在线状态。旧路径回退仍沿用原 MCP 服务连接失败期限；等待可取消，不增加模型请求或推理时限。索引与回退均失败时记录无内容诊断并继续主任务。

**协作**：主 agent 用 `team_start` 一次派发最多两个独立调查或审查任务，每个任务带问题、范围和验收标准。它通过原生 `subagent` 工具的完整执行流程启动子任务，因此保留原有权限检查、模型默认值、递归限制、取消和结果回收。标准预设的 `subagent` 使用独立上下文，避免复制整段历史；如果用户改过原生工具配置，则沿用该配置。

主 agent 继续处理关键路径，独占共享文件修改与最终验收；子 agent 负责调查并回传简洁证据。分工是提示词约束，**不另建文件系统只读沙箱**，底层访问权限仍由 Harness 管理。相同父会话下重复调用相同 `plan/key` 返回已有子任务；更改相同 key 的任务内容会报错。插件同时限制两个尚未释放的自有子任务，子 agent 不能再调用 `team_start`。其他原生子任务仍由 Harness 自身管理。

父任务完成独立工作后，可调用一次 `team_wait` 等待原生子任务完成；等待期间不发额外模型请求，无须执行 shell sleep 或轮询。它等待当前父会话的原生后代工作，不改变子任务权限或生命周期；取消只解除本次等待。没有该能力时，结束当前轮次并准确说明待回传状态，由原生完成通知续接任务。分工指引要求子任务满足所分配的验收条件后收敛，父任务避免重复已通过且输入未改变的检查。

**执行检查点**：实际执行中，同一工具参数得到相同可见结果累计 3 次，或完成 20 个工作步骤后，向模型加入简短提醒，要求复用已有证据、检查假设、确认剩余验收条件。重复检测也覆盖 `run_code` 内部的 PTC 工具调用；结果变化后重新计数，已知写入工具成功后清除重复样本。相同结果不代表外部环境一定没变，所以提醒不阻止工具调用。

单步报告输出达到 4000 token 时，结合消息块的字符数量区分推理、可见文字与工具参数。推理字符多于其他两者之和时，要求转向一个具体实现或证据检查；后续再次出现时，最多补发一次针对收敛的提醒。大量文件或工具参数本身不触发“重复打印”提醒。字符数不是分项 token，既不复制内部推理到提醒，也不据此认定必要调查有浪费。只报告 token、没有内容明细的消息沿用保守的通用提示。

明确请求创建 SVG 时，第一轮请求前加入一次可见、可重放的工作流上下文：先交完整首版，再校验 XML 与全图预览；围绕具体失败条件修改，验收通过后交付。用户要求的精修、变体、动画和额外检查继续保留；普通 SVG 格式解释不触发。成功 SVG 写入/编辑后第一次成功读图记一个观察周期；同一文件累计 2 个周期时提醒检查剩余要求，即使文件和图片结果每次都变也能识别。重复局部读图不重复计周期，不同 SVG 分开计，最多跟踪 8 个文件。此关联依赖最近编辑的 SVG，是启发式观察，不能证明读到的图片就是该 SVG，也不自动判定修改多余或强制终止。独立审查只在存在明确验收疑问时建议使用原生子任务，不强制拆分简单工作。

每轮最多 3 条诊断提醒，SVG 起始工作流另限每次新建请求一条；均记入原生会话日志。恢复会话后不会重复发送同一诊断提醒。QQ 守候、提问和后台等待不参加重复检测；只有等待工具的步骤也不推进工作检查点。阈值均为提醒条件，**不截断输出、不终止任务、不限制执行时间**。提醒在已完成步骤后的下一次请求生效，不能缩短正在进行的一次推理。提示词引导长公式和重复代码使用已验证模板或脚本，避免重复打印；用户明确要求完整文本时仍须完整交付。这些指引能否减少步骤与输出，取决于模型执行情况。

**耗时诊断**：`workflow_status` 返回当前或最近一轮的模型阶段、工具窗口、审批、提问、后台和主动守候时间，以及输出量和传输重试次数。另报告推理/可见文字/工具参数的字符数量及匿名 SVG 修改读图周期；它们不包含原文，也不等同分项 token。同类并发区间取并集，不重复累计；不同类别可以重叠，不能相加。模型阶段包括准备、首字和重试等待，**不能据此计算生成速度或 TTFT**。插件不自动改代理、权限、重试设置或主模型档位。

`team_wait` 计入后台等待；可明确识别的纯 shell `sleep 数字`（可附字面量 `echo`）计入主动等待，且不推进工作步骤。包含其他命令、替换或管道的 shell 脚本保留普通工具分类，避免把实际工作误报为等待。

## 安装

此版本为实验性试用版。请先核对 [发布页](https://github.com/ytsu-ki/dsh-memory-team/releases/tag/v0.5.3-beta.3) 的版本和 SHA-256，安装到独立测试 profile。可使用下方 Git 标签或下载的 `.tgz` 绝对路径；参见 [Windows 验收说明](docs/windows-acceptance.md)。

1. 在 Harness 打开「插件」→「添加插件」。
2. 输入 `https://github.com/ytsu-ki/dsh-memory-team.git#v0.5.3-beta.3`，或下载的打包文件绝对路径，点击安装。
3. 启用「项目记忆与协作」，确认组件显示「运行中」。

CLI 用户可运行：

```sh
dsh plugin --profile desktop add 'https://github.com/ytsu-ki/dsh-memory-team.git#v0.5.3-beta.3'
```

将 `desktop` 换成实际使用的 profile。无需安装 Obsidian 即可使用默认的本地 SQLite 记忆与子 agent 协作；Markdown 知识库、Basic Memory 和凭据扫描按下文选配。

已有 `dsh-stream-guard` 用户应先通过插件管理器停用或卸载旧包。旧的 `dsh-stream-guard-0.1.0.tgz` 可用于恢复旧方案。不要手工修改 profile 的包清单和锁文件。目录安装是链接，后续修改仓库会影响安装源；打包安装保存固定版本。更新已安装包后若 Harness 提示需要重启，按提示重启。

### 接入 Basic Memory 与 Obsidian

需要 Python 3.12+，使用独立环境安装官方 Basic Memory，不修改上游代码：

```sh
python3 -m venv ~/.local/share/dsh-memory-team/basic-memory
~/.local/share/dsh-memory-team/basic-memory/bin/python -m pip install 'basic-memory==0.23.2'
node scripts/setup-knowledge.mjs \
  --vault '/absolute/path/to/Obsidian Vault/DSH 知识库' \
  --project '/absolute/path/to/project' \
  --command '/absolute/path/to/basic-memory/bin/basic-memory' \
  --config-dir '/absolute/path/to/basic-memory-config'
```

本仓库提供 `scripts/basic-memory-macos-arm64.txt`，记录已验收的 Python 3.12 / macOS arm64 依赖版本；在该平台可改用 `pip install -r scripts/basic-memory-macos-arm64.txt`，避免后续依赖更新改变环境。其他平台使用上面的基础安装方式后单独验收。

脚本建立专用 Basic Memory 配置与本机 `~/.local/share/dsh-memory-team/settings.json`；重载插件后生效。`--project` 应传入 Git 根目录，无 Git 时传任务工作目录。Obsidian 只需打开包含该文件夹的笔记库，不安装 Obsidian 插件。保留 Markdown 的 YAML 来源与项目字段，直接编辑正文；新增检索词由 Basic Memory 文件监听器建立索引。自动生成的中文分词不会在外部编辑时自动重写，可在“检索词”段补充短词。

可选 `--seed-file /absolute/path/to/notes.json`，格式是 `[ [key, title, kind, summary, evidence], ... ]`；仅导入审定资料，已存在的 key 不覆盖。个人种子文件放在被 Git 忽略的 `.local/`，不会进入发布包。`--no-activate` 可只准备目录与配置。

批量导入初始资料后，在启动 Harness / Basic Memory MCP 前，用官方命令预热完整索引；意外中止首次索引后也可用它修复派生索引，不删除 Markdown：

```sh
BASIC_MEMORY_CONFIG_DIR='/absolute/path/to/basic-memory-config' \
BASIC_MEMORY_FORCE_LOCAL=true \
  '/absolute/path/to/basic-memory/bin/basic-memory' reindex --search --full --project dsh-knowledge
```

上游 [Basic Memory](https://github.com/basicmachines-co/basic-memory) 使用 AGPL-3.0-or-later；本项目 MIT 许可只覆盖本项目代码。Basic Memory 由用户独立安装和运行，不复制进 npm 包；Obsidian 是现成编辑器，并非本项目的开源依赖。

### 配置本地凭据扫描

```sh
node scripts/setup-retrieval.mjs
```

脚本从官方 GitHub release 下载固定的 Betterleaks 1.9.0，核对内置 SHA-256，独立安装到 `~/.local/share/dsh-memory-team/betterleaks/1.9.0/`，备份并合并本机设置。支持 macOS/Linux arm64/x64；本次真实验收平台为 macOS arm64。可用 `--archive /absolute/release.tar.gz` 离线安装同一校验版本；`--no-activate` 仅准备程序。重载插件后生效，不需要改 DSH 账号、模型或代理。

可重建快照保存在 Basic Memory 配置目录的 `recall-index/`，POSIX 权限为 0600，Windows 继承 ACL，不回写原 Markdown；坏快照自动重建。程序和规则的指纹变化会让旧快照失效。Betterleaks 是 MIT，Orama 是 Apache-2.0，Chokidar 是 MIT；Basic Memory 仍由用户独立安装，继续遵守其 AGPL 许可。

## 使用

通常直接给 Harness 任务即可，插件会添加检索和分工指引。模型仍决定是否调用保存或协作工具，简单任务不强制拆分。也可以明确要求：

> 先检索这个项目的记忆；把实现定位和验收方法审查交给两个独立子 agent，你负责修复。验证通过后保存结论和失败经验。

| 工具 | 用途 |
| --- | --- |
| `project_memory_search` | 搜当前项目；空查询列出最近记录；`include_stale: true` 包含失效项 |
| `project_memory_save` | 保存 fact / workflow / pitfall；必须提供 evidence 和 files 数组 |
| `project_memory_forget` | 根据 key 和当前版本删除一条不再需要的记录 |
| `project_memory_status` | 查看实际后端、Markdown 目录和服务就绪状态 |
| `team_start` | 批量启动独立调查任务；使用稳定 plan 和 task key 避免重复派发 |
| `team_wait` | 独立工作结束后等待原生后代完成；无需 sleep 或轮询，可取消 |
| `workflow_status` | 检查当前或最近一轮的步骤、输出、重试与各类等待；仅诊断需要时调用 |

示例记忆参数（示例不是已经验证的项目结论）：

```json
{
  "key": "viewport-acceptance",
  "title": "1440px 验收前置条件",
  "kind": "pitfall",
  "summary": "检查按钮可点击性前关闭覆盖层。仅在界面没有遮挡时使用命中测试判断布局。",
  "evidence": "填写实际观察和测试结果。",
  "files": ["tests/layout.test.js"]
}
```

创建时省略 `expected_revision`；更新前先搜索，再传入返回的当前版本。`files` 最多 6 项，只能指向当前项目内不超过 1 MiB 的普通文件；插件只保存路径与哈希，不复制文件内容。无文件关联的观察可以用 `[]`，由有效期和证据文字限定适用范围。

示例协作参数：

```json
{
  "plan": "viewport-check",
  "tasks": [
    {"key": "layout", "question": "定位 1440px 布局溢出的原因。", "scope": "src/layout，仅读取。", "acceptance": "给出相关行号、原因和最小修复建议。"},
    {"key": "assertions", "question": "审查 1440px 验收脚本是否有误判。", "scope": "tests/layout，仅读取。", "acceptance": "提供证据和一组有区分力的验证步骤。"}
  ]
}
```

完成通知由 Harness 原生机制送回。只剩等待时用 `team_wait`；需要纠正子任务时用现有 `send_message`，需要停止时用 `interrupt_agent`，不重复创建相同任务。部分任务启动失败时，`team_start` 分项返回 started / existing / failed，已启动的工作继续运行。

省略子任务的 `reasoning_effort` 时继承原生设置。插件按当前 agent 实际可见的原生 `subagent` 工具生成参数：只有 Harness 已允许该会话选择子任务模型设置时，才展示可选的 `reasoning_effort: "low"` 或 `"high"`；否则隐藏字段并明确提示继承。原生函数调用和 PTC SDK 使用同一份参数定义，不同会话互不影响；原生能力卸载或限制后会在下次生成参数时更新。旧会话或手工调用若仍传入不允许的字段，执行前继续明确报错，不静默改档位，也不替用户开启权限。`low` 适用于边界明确的定位或机械验证，复杂诊断继续继承原档位。更改已派发任务的档位也属于任务内容变更，不能复用原 `plan/key`。

## 存储与配置

数据库默认放在 `$DSH_PROFILE_DIR/data/dsh-memory-team.sqlite`；没有 profile 时使用 `$DSH_HOME/data/`，再没有则使用 `~/.dsh/data/`。数据库是本地明文文件，POSIX 平台设置为 0600；Windows 的实际访问权限取决于继承的 ACL，不能从 `stat().mode` 判断为“仅当前用户可读”。插件不会自动重写 Windows ACL，状态显示 `windows-acl-inherited-unverified`；可用 `node scripts/inspect-windows-acl.mjs '数据库绝对路径'` 只读查看权限条目，条目输出本身不等同于完整有效权限审计。Markdown、派生快照及 history/trash 同样需要按平台核对权限。卸载插件保留数据库，重新安装可继续使用；卸载会移除工具和提示贡献，停止尚未提交的派发，但不擅自结束已移交给 Harness 的子任务。

`project_memory_status` 返回实际加载的 `plugin_version`、`loaded_at`、`runtime.node/uv/pid`、`database`、`scope.source`（`git` / `cwd` / `explicit`）、作用域警告和权限模型。Markdown 索引额外返回 `index.watcher`、`index.watcher_error`、`index.last_reconciled_at`、监听批次和溢出计数与 `index.degraded`，可区分没有相关记忆、作用域不符及监听降级。`knowledgeProject` 只选择 Markdown 后端，不改变项目根目录；需要限定项目身份时使用 `projectRoot`。

**本地存储不代表内容永不离开本机**：命中的记忆会随正常请求发给当前模型服务。原始 Markdown、history 和 trash 仍为本地明文，不自动改写已有文件。给笔记的 YAML 加上 `dsh_private: true`，可将整条笔记排除在插件召回和派生快照之外；即使 `include_stale: true` 也不返回。这个标记不限制用户直接读文件、Basic Memory 自身的工具或其他插件。

可选的 Betterleaks 1.9.0 本地扫描在保存经验、自动记录及召回前遮盖可识别的凭据，规则与版本固定，不进行联网验证；原有明显凭据的手动保存拒绝规则继续保留。自动记录先筛查再截取文字，避免截断凭据绕过识别。扫描错误不输出原文或扫描报告，暂停相应记忆写入/召回，主任务继续；扫描过程可以取消。单次扫描有 5 秒本地服务保护，版本探测 10 秒，这不限制模型或子任务的推理时间。没有配置扫描程序时沿用旧版内置规则，状态显示 `builtin-only`。

凭据检测存在误报和漏报，不覆盖所有中文个人信息、编码凭据或整个聊天传输。它不会扫描原始模型请求和其他工具的输出，也不清理原有聊天日志。扫描器进程只接收必要环境变量，显式关闭验证并隔离项目扫描配置；不向其传递账号令牌和代理设置。

通过插件配置调整下列字段：

| 配置 | 默认 | 范围 / 含义 |
| --- | --- | --- |
| `database` | 自动选择 | 自定义时必须为绝对路径 |
| `projectRoot` | 自动识别 | 可选绝对路径；只合并其自身及子目录；不自动迁移旧记忆 |
| `knowledgeRoot` | 未配置 | Basic Memory 索引的 Markdown 目录；绝对路径；空字符串可明确停用 |
| `basicMemoryCommand` | basic-memory | 本地可执行程序路径，独立环境建议使用绝对路径 |
| `basicMemoryConfig` | 数据目录/basic-memory | 独立 Basic Memory 配置目录；绝对路径 |
| `knowledgeProject` | 不限制 | 指定试点项目的真实根路径；其他项目保留 SQLite |
| `incrementalIndex` | true | 使用 Orama 增量检索；false 恢复原 MCP/Markdown 路径，原文数据不迁移 |
| `betterleaksCommand` | 未配置 | 固定版 Betterleaks 的绝对路径；配置后失败会阻止该次记忆传递 |
| `ttlDays` | 30 | 1–365 天，超期停止自动引用 |
| `recallLimit` | 3 | 实际最多 3 条；兼容旧配置 4–6，但仍限制为 3 |
| `recallChars` | 6000 | 1000–12000 字符的自动上下文上限 |
| `maxWorkers` | 2 | 1–2 个自有子任务 |
| `repeatThreshold` | 3 | 2–10 次相同请求与可见结果后提醒；SVG 交付复查另在 2 个修改读图周期后触发 |
| `checkpointSteps` | 20 | 每 10–100 个工作步骤提醒；仅等待的步骤不计 |
| `longOutputTokens` | 4000 | 单步已报告输出的分类检查阈值；1000–32000 token；必要工具参数本身不触发 |

每次新用户输入都会写入一份有界的当前检索结果（包括无命中提示），说明它取代早先的检索结果。内容通过 `agent/pre-step` 进入原生 `user/message` 日志，可随会话重放。没有改写冻结的模型请求，也没有自创 session event 类型。检索错误会记一条不含内容的诊断并继续任务；工具读写错误正常返回，避免伪装成功。

## 验证与开发

Windows 在小库和大库均使用原生递归监听，另以一个非递归的上一级目录监听观察项目目录的改名与重建；项目目录暂时消失时仍保留该观察，卸载时一并关闭。通知合并有大小上限，持续通知期间也会推进更新；读取前后校对文件签名，目录删除或替换后关闭旧句柄。每次登记或重建监听后补扫一次元数据，收录登记窗口中的写入；外部变动和元数据校对统一经过 100ms 稳定检查，插件自身完成的保存继续即时刷新。同一目录监听失败后限制重建频率，并保留每 60 秒的元数据核对。`metadata-only` 模式下外部修改可能延后进入索引；详细边界见 Windows 验收说明。

维护者使用 `pnpm release:prepare` 统一生成安装 TGZ 和源码 ZIP，并校验运行资源和文件一致性。此发布命令需要 Python 3 标准库；插件运行不需要新增 Python 依赖。`secret_scanner_error` 区分扫描程序缺失、版本不支持、程序不可读及规则不可用。

Node.js 22.17+，pnpm 11.25.0：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
pnpm pack

# 可选真实服务验收，使用临时目录，不调用付费模型 API
BASIC_MEMORY_TEST_COMMAND='/absolute/path/to/basic-memory' \
BETTERLEAKS_TEST_COMMAND='/absolute/path/to/betterleaks' node --test test/*.test.js
```

测试覆盖 SQLite 持久化、中英文检索、项目隔离、文件失效、并发版本冲突、输入边界、上下文落盘、工具卸载、并发子调用、原生权限拦截、重复派发、等待区间去重、检查点重放及真实子 agent 生命周期。完整协作测试使用官方 Cordis / AgentLoop / Subagent / JSONL 持久化组件和模拟模型，证明两个子任务重叠运行并把结果送回父任务；实际 agent loop 测试证明重复提醒只发送一次且任务继续完成。无付费 API 调用。旧保护模块的回归测试也保留。

macOS 上完整生命周期测试需要能加载 npm 原生扩展的 Node.js；有些应用附带的签名运行时会因 Team ID 不同而拒绝加载测试用扩展。使用正常开发版 Node.js 即可，不需要修改系统安全设置。插件本身只使用 Node 内置 SQLite，不依赖这个测试用原生扩展。

GitHub Actions 已配置 Windows / Ubuntu / macOS 与 Node.js 22 / 24，并覆盖 Windows 的 22.17.0、24.18.0；先统一生成候选包，再解压源码 ZIP 检查和测试，最后安装 TGZ 验证独立进程冷启动。配置存在不代表运行通过。Windows 用例通过 Node 调用固定 PowerShell 查询，读取实际 SQLite 与派生快照的 ACL，并在专用 Low 完整性临时目录复测诊断入口。目录逃逸检查在 Windows 使用 junction；仅无法创建的文件符号链接子用例会明确跳过，父目录穿越和目录链接检查继续运行。真实 Basic Memory / Betterleaks 测试需显式提供对应可执行程序。发布包只含代码、安装与诊断脚本、语言元数据、默认配置、图标、README 和 LICENSE；本地数据库、种子资料、诊断报告与聊天记录已排除。

这版改善任务组织和经验复用，不能消除模型服务或代理造成的传输错误。并行协作可能增加总 token 和并发请求，是否更快需要用相同任务做线上对照，不能从本地模拟测试推断具体提速比例。
