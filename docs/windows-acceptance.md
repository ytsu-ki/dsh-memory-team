# Windows 修复候选与验收

本说明对应 `0.5.3-beta.3` 试用版，旧版 v0.5.2 附件保留。beta.1 的 Windows 调查确认了递归子目录监听阻止父目录改名，以及低完整性目录中的 PowerShell 脚本加载失败。beta.2 的 Windows Node 22.17.0 / 24.18.0 自动化各为 76 通过、0 失败、3 跳过，Low 完整性诊断入口及安装包新进程验证通过。本版进一步修复监听登记窗口漏事件和元数据校对绕过稳定检查的问题，自动化结果以 [Actions](https://github.com/ytsu-ki/dsh-memory-team/actions) 中对应提交为准。Windows 桌面冷启动、真实 Basic Memory 和 Betterleaks 仍需分别验收；原始宿主崩溃的首个异常尚未确认。

## 安装前

保留现有主 profile。先按 DSH 支持的方式创建独立测试 profile，备份其配置、会话和记忆；不要删除用户 home 目录的 `.git`，不要自动清理 npm/Git 全局代理。安装失败时先区分网络、代理与插件加载错误。

开发者在源码目录运行 `pnpm install --frozen-lockfile --ignore-scripts`、`pnpm check`、`pnpm test`。Node.js 使用 22.17+ 或 24；CI 已配置 Windows / Ubuntu / macOS 的 Node.js 22 / 24，以及 Windows 精确版本 22.17.0、24.18.0。CI 从源码 ZIP 安装并测试，再从 TGZ 安装并运行独立进程冷启动测试。配置存在不代表已运行通过。Windows ACL 诊断通过 Node 调用系统 Windows PowerShell 的固定只读查询，不修改执行策略或既有文件权限。

下例假定已有名为 `windows-memory-test` 的测试 profile，并已将发布页的安装包复制到该绝对路径：

```powershell
dsh plugin --profile windows-memory-test add 'C:\Downloads\dsh-memory-team-0.5.3-beta.3.tgz'
```

## 修复范围

- 测试先关闭全部存储、SQLite 连接和监听器，再删除临时目录；假扫描器通过 Node 显式执行，不依赖 shebang，不启用 shell。
- 项目根目录默认不使用 home 或磁盘根目录上的 `.git` 合并子目录。新增 `projectRoot` 绝对路径配置，只对其自身及子目录生效；其他目录继续自动识别。`knowledgeProject` 只选择记忆后端，不改项目身份。
- 原 home 桶的旧记录不删除、不自动迁移。确实需要共享 home 项目时，可显式配置它；操作前核对记录归属。没有 Git 的项目若要让多个子目录共享记忆，应设置其明确的 `projectRoot`。
- Windows 不论笔记数量均使用原生递归监听，其他平台保持原来的分支。原生路径先等待写入稳定窗口，并在读取前后校对文件签名；读取中变化的笔记先移出派生索引，再排队重读。检索排序、私密过滤与密钥筛查继续沿用原实现。
- 初次登记或重建监听后排队补扫一次元数据，收录此前扫描到监听登记之间写入而未产生可见事件的文件。元数据校对与监听变动统一经过 100ms 文件稳定检查；插件自身完成保存的即时刷新不增加该等待。不会以固定睡眠或测试脚本手动 reconcile 作为恢复前提。
- Windows 原生监听不报告被监听目录自身的改名，因此增加一个非递归的上一级目录观察；项目目录暂时消失时仍保留它，以便新建同名目录后自行恢复。卸载时关闭两类监听。整个 vault 或其祖先移动仍需单独测试，不能由项目目录通过外推。
- 通知以固定 100ms 窗口合并；待处理路径最多 2048 个，超出后合并为一次元数据校对。持续通知不会无限推迟更新。无文件名或目录级通知触发受节流的目录身份检查；目录消失或被替换时关闭旧句柄，不依赖监听器主动发送 error。
- 监听创建失败、运行错误或目录身份变化后继续每 60 秒元数据核对。同一目录上的失败监听至少间隔 5 秒才可重建；新目录身份可立即重新绑定。`metadata-only` 表示实时监听降级，不保证新外部文件立即可检索；无事件时的恢复可能要等下次核对。
- 状态新增 `plugin_version`、`loaded_at`、`runtime.node/uv/pid`、`index.last_reconciled_at`、监听批次/溢出/创建计数及 `secret_scanner_error`。扫描器自动安装脚本仍不支持 Windows；默认 `builtin-only` 不代表经过真实 Betterleaks 验收。

## 必须完成的实机验收

| 场景 | 验收标准 |
| --- | --- |
| 冷启动 | 退出桌面 App 后重新打开同一测试 profile，核对插件版本、加载时间、宿主 PID、Node/libuv 版本；七个工具存在；再退出、启动一次，已保存记忆仍可检索，无新增启动错误。端口变化不能单独证明 App 已重启 |
| 项目隔离 | home 有 `.git` 时，两个自身无 `.git` 的独立工作目录返回各自作用域；A 保存的唯一标记不在 B 召回；嵌套仓库、worktree、目录 junction 保持正确身份 |
| 显式作用域 | `projectRoot` 下的子目录共享记录；其他目录不被吸入。路径包含中文和空格也正常；配置错误返回可定位的错误，不写入错误的桶 |
| 新会话召回 | 在 A 保存随机标记及证据，然后创建没有原对话历史的新会话，只询问 key；请求和日志中的插件上下文必须包含对应标记。无关问题、B 项目、证据已变化和过期记录分别返回无命中 |
| 监听恢复 | 小库、大库均验证原子保存和分段写入；由另一个进程反复改名/替换带子目录的项目目录，监听存活时不应出现本插件导致的 EPERM。再永久删除并重建目录；核对内容、旧监听关闭及恢复。整库祖先目录的移动须另测，不能从项目目录通过推断 |
| 监听负担 | 连续通知期间仍有批次完成；大量修改后索引与最终文件一致，句柄和队列不持续增长；永久删除/替换目录后 CPU 恢复空闲水平，无持续满核。不把高频正常编辑判为失败 |
| 子 agent | 两个独立任务实际重叠运行，结果回到父会话；重复派发不新增相同任务，权限及取消继续由宿主管理 |
| 长任务 | 重复结果、检查点及 SVG 修改读图提醒仍有次数上限；必要修改能继续，不截断答案、不新增模型时限 |
| 卸载及再安装 | 工具消失，数据库和 Markdown 保留；重新安装后数据可读，后台监听及数据库连接没有残留占用 |

自动化测试包含官方 AgentLoop 配合模拟模型的新会话正反例、原生双子任务生命周期、以及新进程启动后的 SQLite 持久化验证；这些不能替代上表的 Windows 桌面实际运行。

## 只读检查 Windows 权限

先用 `project_memory_status` 确认 `database` 或 `folder`。在 PowerShell 中运行下列脚本，替换为实际路径：

```powershell
node .\scripts\inspect-windows-acl.mjs 'C:\Users\your-name\.dsh\profiles\windows-memory-test\data\dsh-memory-team.sqlite'
```

Node 入口把路径作为环境变量数据传给固定的 .NET `FileInfo` / `DirectoryInfo.GetAccessControl()` 只读查询，不通过 `-File` 加载工作区 `.ps1`。子进程移除继承的 PowerShell 模块路径和分析缓存变量，查询时只使用系统 Windows PowerShell 自带模块，并关闭无需输入的标准输入管道，ACL 读取直接调用系统 .NET，不加载 Get-Item / Get-Acl 模块，JSON 序列化明确指定系统 Utility 模块；所有者和规则身份使用 SID，避免账户名解析；不改变父进程环境或执行策略。该手动诊断的进程上限为 30 秒，包含 Windows PowerShell / .NET 首次启动；超过上限明确失败。这是诊断工具的等待上限，不限制模型思考。CI 阶段探针曾记录启动第一行前超过旧 10 秒上限，以及 Get-Acl 模块阶段超过 30 秒上限；后者已改用 .NET 只读接口，微软也说明首次启动可能执行优化任务（[启动说明](https://learn.microsoft.com/en-us/powershell/scripting/dev-cross-plat/performance/startup-performance)）。旧 `.ps1` 入口保留作手工兼容；在低完整性目录中它仍可能被 PowerShell 5.1 拒绝加载，自动化验收使用 Node 入口。查询不可用会明确失败，不回报“权限正常”。Windows 测试只在专用临时目录设置 Low 标签，结束后删除，不改既有目录标签。

数据库、Markdown、索引快照和 history/trash 都是本地明文。Windows 的 `0600` 数值不能代表 POSIX 的所有者权限；当前实现继承 Windows ACL，不自动修改。诊断只列出所有者、继承状态和访问规则，不计算完整有效权限，也不修改 ACL。检查自定义共享目录时，应特别核对广泛用户组的读取授权；不要仅凭一个 `0o666` 或脚本运行成功判断数据公开或私密。

## 发布包生成

维护者在 Git 工作目录安装依赖后运行 `pnpm release:prepare`。此开发命令需要 Python 3 标准库；插件安装、运行和 Node ACL 诊断不需要 Python。命令生成 TGZ、源码 ZIP、`manifest.json` 和 `SHA256SUMS`，检查必需资源并逐项核对源码与安装包中的运行文件；已存在的版本文件不会覆盖。可用 `--out` 指定新输出目录。

源码 ZIP 的文件列表来自 Git 管理及未忽略的待提交文件。候选发布前必须审查该列表；本地 `.local/`、数据库及依赖目录保持排除。源码 ZIP 解压后可直接运行安装、检查与测试，不需要再手动补 `rules/`。不要把缺文件的包当作通过。

## 记录结果

保留完整 `pnpm test` 输出、DSH/插件版本、Windows 架构、实际安装包 SHA-256、测试 profile 的冷启动结果和监听状态。跳过项必须说明原因，不能计为功能通过。真实 Basic Memory、Betterleaks、桌面操作和模拟测试分别记录。

发生启动崩溃时，保留弹窗 Diagnostic report 中的 `crash-...-host.log`，尤其是 Failed plugins 与第一条异常堆栈。必要时使用 **Disable third-party plugins, back up profile patch, and restart** 尝试恢复；这会影响其他第三方插件。提交日志前遮盖凭据和私人信息，不上传整个知识库或会话。

## beta.2 Windows 报告复核及本候选补测

beta.2 的首版目录压力脚本记录了 60 次内容校验未通过；后版加入等待和显式 reconcile 后完成 20 轮。因未提供两版压力脚本，不能确认所有差异都由测试时序导致。本候选用可复现的回归用例证实并修复了一个监听重建窗口：扫描已结束、监听未登记时写入的笔记可能漏事件。另一个用例验证元数据校对不会绕过写入稳定检查；真实文件系统用例连续 20 轮跨进程替换目录，依靠通知恢复，不调用手动 reconcile，也不固定等待 5.2 秒。

发布验收须重跑上述新增用例。大库、整个 vault 与祖先目录移动，以及删除/替换后持续 CPU 和句柄采样分别记录；普通文件写入停止后的低 CPU 不能替代删除监听压力验证。真实 CLI 的记忆验收目前只覆盖 SQLite 后端，不可据此宣称 Windows Markdown / Basic Memory 完整链路通过。

补测提交夹具源码、结构化工具事件与退出码清单。分享日志前处理 Windows 用户路径、ACL 身份/SID、对话和模型过程文本；原始日志保留在本地，不直接上传为公开附件。
