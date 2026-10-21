# dsh-stream-guard

DeepSeek Harness 的流式请求保护插件。针对连接保活心跳持续到达、实际内容停住，以及单步失败后连续重试数分钟的问题。

插件不调整模型、思考强度、提示词、权限或系统代理，不修改 DSH 安装包。触发保护时返回明确的失败状态，取消对应网络请求，保留 Harness 已记录的尝试；不会把不完整的回答或工具参数当作成功结果执行。

## 默认行为

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `providers` | `deepseek-account`, `deepseek-official` | 只保护这些 provider |
| `stalledMs` | `60000` | 60 秒没有内容输出就停止；SSE 心跳不能刷新此计时 |
| `terminalGraceMs` | `30000` | 所有内容块关闭后，再等结束事件最多 30 秒 |
| `maxCallMs` | `180000` | 一次模型请求最多 3 分钟，即使一直输出也受限 |
| `maxStepMs` | `300000` | 同一步及其重试的请求耗时累计最多 5 分钟 |
| `maxRetries` | `2` | 原生可重试失败最多额外尝试 2 次，即初次请求加 2 次重试 |

时限从模型请求开始计算，首个输出前的等待也受限。工具运行、用户问答和步骤之间的时间不计入请求预算，重试退避不计入累计请求耗时。成功完成一步后，下一步重新计算重试和累计预算。

保护时限触发后停止该步骤，不会自动重试同一个超时。其他原生错误仍交给 DSH 的重试插件处理，直到本插件的次数或累计预算用完；本插件不会增加原有重试次数，也不自行发送重试请求。`maxRetries` 针对带有 `sessionId` 和 `signal` 的标准 Agent 请求；独立 SDK 调用只应用单次请求时限。

所有显式标记 `purpose` 的辅助请求（如会话标题和上下文压缩）跳过保护。默认只支持上表中的 DeepSeek provider，不保证其他第三方适配器的取消行为。

## 安装与停用

需要 DeepSeek Harness **0.2.0-rc.2**；目前验证的接口版本为此版本。Node.js 要求 **22.17+**，本机集成测试使用 Node.js 24.21.0。其他 Harness 版本需重新验证。

1. 下载或克隆本仓库到本地目录。
2. 在 Harness 左侧打开「插件」→「添加插件」。
3. 输入本仓库的**绝对目录路径**，点击安装。
4. 确认「流式请求保护」的启用开关已打开；若界面提示需要重启，按提示重启。

也可以在 Harness 内让 Agent 使用其 `plugin_manager` 工具：`action: install_bundle`，`target` 为本仓库的绝对路径。不要手改 profile 的包清单或锁文件。

在插件页面关闭本插件即可停用；卸载也通过插件管理器进行。停用时取消仍受保护的请求，移除事件监听，并恢复本插件安装前的 fetch 包装。如果其他插件之后又包装了 fetch，本插件只让自身失效，不覆盖对方的包装。

## 调整配置

通过插件设置或当前 profile 的 `cordis.patch.yml` 覆盖同名条目。Loader 会替换整个 `config`，因此下面列出完整配置；省略字段会恢复为本插件默认值。

```yaml
- id: dsh-stream-guard
  config:
    providers: [deepseek-account, deepseek-official]
    stalledMs: 60000
    terminalGraceMs: 30000
    maxCallMs: 180000
    maxStepMs: 300000
    maxRetries: 2
```

所有时限必须是 `1`—`2147483647` 之间的整数毫秒，`maxRetries` 为 `0`—`10` 的整数。配置错误会拒绝加载，不会静默关闭保护。复杂长推理可能合理地超过 3 分钟；此时增大 `maxCallMs` 与 `maxStepMs`，或暂时停用插件。过短的阈值会中断正常生成，可能仍消耗已经生成的 token。

## 实现与边界

- 使用 Cordis 的 `llm/stream` waterfall 包装原来的流，保留路由、冻结的请求配置、内容块、使用量和 replay 数据。
- DSH 0.2.0-rc.2 的请求对象已冻结，waterfall 的 `next()` 不接受替换请求。因此通过 Node.js `AsyncLocalStorage`，在该请求的异步作用域内给全局 fetch 薄包装附加独立取消信号。作用域外的请求直接转发，不读取或记录 URL、请求体、认证头、提示词或输出内容。
- 只在等待上游下一块输出时运行停顿计时；不会对每个 token 建立额外的日志写入。绝对时限用于阻止持续碎片输出把单次请求无限延长。
- 在 `agent/request-error` 的前置监听中，明确终止本插件产生的保护错误，防止 DSH 的 `always` 重试策略再次重放它们。
- 每个标准 Agent 的取消信号与会话 ID 隔离重试状态；不扫描或改写历史会话，不新增 DSH 不认识的 session event 类型。
- 取消已验证能关闭 DSH 自带 DeepSeek Messages 适配器的 HTTP 流。绕过全局 fetch 或完全忽略取消信号的第三方实现只能限制消费端等待，不能保证关闭其底层工作；不在默认支持范围内。
- 这是减少失败等待的保护措施，不能修复 DeepSeek 服务端、网络或代理的连接故障，也不会修正 Harness 现有界面的 token/s 统计公式。

保护错误码包括 `DSH_STREAM_GUARD_STALLED`、`DSH_STREAM_GUARD_TERMINAL_TIMEOUT`、`DSH_STREAM_GUARD_CALL_DEADLINE`、`DSH_STREAM_GUARD_STEP_DEADLINE`、`DSH_STREAM_GUARD_RETRY_LIMIT` 和 `DSH_STREAM_GUARD_INCOMPLETE`。日志仅包含错误码、耗时、尝试次数、provider、model 和 session ID；不额外写日志文件，不上传数据。

## 开发与验证

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
pnpm pack
```

测试包含：配置校验、正常输出透传、无响应、持续输出的绝对时限、结束事件缺失、重试上限、跨重试累计预算、会话隔离、用户取消、卸载清理，以及实际 Cordis / DSH Messages 适配器与本地 HTTP SSE 服务器的集成。集成测试使用虚拟凭据，只访问 `127.0.0.1`，不需要 DeepSeek 账号，不产生模型费用。

GitHub Actions 已提供 Node.js 22 / 24 测试和打包流程；远端 CI 需要上传后才会运行。发布包通过 `files` 白名单只包含插件代码、默认配置、语言元数据、README 和 LICENSE。个人诊断报告、本地会话、凭据和 `node_modules` 不应提交；本工作区已有的诊断报告已被 `.gitignore` 排除。

## 上传 GitHub

项目包含源码、测试、锁文件、CI 和 MIT 许可证，可以直接作为 GitHub 仓库使用。创建仓库后补充 `package.json` 的 `repository`、`homepage` 和 `bugs` 地址即可。当前没有绑定远程仓库，也没有自动提交、推送或发布到 npm。

接口参考：[DSH 源码](https://github.com/deepseek-ai/deepseek-harness)、[官方思考模式说明](https://api-docs.deepseek.com/guides/thinking_mode/)。
