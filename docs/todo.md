# Todo 进度

Todo 用于记录 Agent 的任务计划、执行进度和面向当前 `ctxId` 的用户评论。状态由 TypeScript control 管理，不属于 worker，也不会出现在 worker 的 `tools.list` 中。

## MCP 工具

```text
todo_read   group=todo  requiredCapabilities=[]
todo_write  group=todo  requiredCapabilities=[]
```

工具是否暴露只由 instance 的 `mcp.tools.groups` 中是否包含 `todo` 控制。两个工具都不要求 capability。默认新建 instance 会启用 `todo` group。

`todo_read` 接受可选的 `title`：

- 不传 `title` 时，列出全部 live task 摘要和 context comments；
- 传入 `title` 时，返回该任务的完整 Todo 列表、revision、taskId 和摘要。

`todo_write` 以 `title` 作为 live task 的稳定命名空间，并使用完整列表替换该任务状态：

```json
{
    "revision": 1,
    "title": "实现 Todo",
    "todos": [
        {
            "id": "inspect",
            "content": "检查现有扩展点",
            "status": "completed"
        },
        {
            "id": "implement",
            "content": "实现 control TodoService",
            "status": "in_progress",
            "detail": "正在接入 MCP 和 RPC"
        }
    ]
}
```

同一 live task 的 revision 必须与当前状态一致。冲突返回：

```text
todo.revisionConflict
```

客户端必须重新调用 `todo_read`，不得静默覆盖。

## 状态约束

```text
pending
in_progress
blocked
completed
failed
cancelled
```

- live task 的 `title` 必须唯一；不同 title 可以并行存在。
- 同一任务最多一个 `in_progress`。
- `blocked` 和 `failed` 必须提供 `detail`。
- `id` 在当前任务内唯一，`content` 不得为空。
- 进度为 `completed / 非 cancelled 项目数`，由 control 计算。
- taskId、revision 和时间字段由 control 生成。

## Context comments

TUI 可以向某个 live task 当前绑定的 `ctxId` 添加评论。评论是持久的 context guidance，不是一次性消息：在用户删除前，该 `ctxId` 的后续工具调用都会收到它。

成功的工具结果保持原有字段层级，并在顶层追加 `comment`：

```json
{
    "exitCode": 0,
    "stdout": "...",
    "stderr": "",
    "durationMs": 12,
    "comment": ["先修复真实链路，再补测试"]
}
```

MCP `tools/list` 中对应的 `outputSchema` 也会保留原字段，并追加必需的 `comment: string[]`。失败结果通过错误数据中的 `comment` 返回评论。

评论按 `ctxId` 隔离。旧 v2 中没有 `ctxId` 的评论只有在能唯一确定 active context 时才会自动绑定；无法唯一确定的旧评论会保留为不可投递的 legacy comment，等待用户检查或删除。

## 权威诊断 hint

`comment: string[]` 是统一的权威指令通道。它同时承载两类内容，并处于同一权威层级：

- 用户通过 Todo/TUI 添加的 context comment；
- 工具调用产生的诊断 hint。

调用方必须遵守 `comment` 中的每一条，不存在“用户 comment 是要求、错误 hint 只是建议”的降级关系。合并规则固定：

- 用户 comment 保持原始顺序并位于最前；
- 本次调用产生的 hint 按确定性顺序追加在后；
- 空字符串被丢弃；
- 仅按精确字符串或稳定 code 去重，不做语义去重；
- clean success 不产生任何系统 hint，`comment` 只含用户 comment（可能为空）。

诊断 hint 使用统一格式，文本为英文：

```text
Error hint [<stable-code>]: <actionable instruction>
Diagnostic hint [<stable-code>]: <authoritative instruction>
```

`Error hint` 对应抛出的错误或返回的语义失败；`Diagnostic hint` 对应非错误但影响结论的部分结果或非终态。稳定 code 用于测试、去重和审计。

hint 不替代原有的 `error.code`、`error.message`、`error.details`、`stdout`、`stderr`、`warnings` 或 `operation.error`，这些字段继续保留。hint 的职责是说明：调用是否真正执行、是否可能已有副作用、输出是否完整、下一步该检查或调用什么、哪些动作被禁止、是否允许重试以及重试前必须改变什么。

hint 不包含敏感数据：完整 command、cwd、绝对路径、stdout/stderr 内容、token、credential 和未经清洗的 provider diagnostic 都不会进入 hint。允许出现的是稳定错误码、exit code、signal、timeout 状态、operation 索引、工具名、provider 类型、instance 名称、缺失行范围、transfer 状态、expected/actual revision 等白名单字段。

正常返回的 JSON 也可能表示失败、部分结果或非终态，调用方必须结合 `comment` 判断：

- `file_edit` 返回 `complete=false` 时表示部分失败：前面的 `applied` operation 已经生效，`failed` operation 未成功，后面的 `notExecuted` 未执行。必须逐项检查状态、重新读取已修改文件、只重建失败和未执行的操作，不得原样重放整个 change set。
- `tmux.blockTimeout` 只表示本次调用等待结束，task 仍在运行，command 没有被终止；应继续 read/inspect/input，不得重启相同 command 或报告失败/完成。
- `artifact_transfer` 返回 `queued` 等非终态只表示 transfer 已接受，不代表文件已送达；必须用同一 `transferId` 继续轮询，不得报告完成或启动重复 transfer。
- 输出截断、分页 `nextCursor`/`nextOffsetBytes`、`lossy` 解码以及 tmux output window 的 skip/drop/resync 都会影响结论完整性；到达 EOF 或遍历完 cursor 之前不得声称已读取完整内容。

未分类错误只会得到保守的保底 hint：

```text
Error hint [error.unknown]: The tool call failed for an unclassified reason. Inspect the original error and current state before taking further action; do not report completion or retry the same operation unchanged.
```

遇到未知错误时禁止报告完成或原样重试。

## 持久化和兼容

状态保存在：

```text
~/.devshell/<instance>/control-worker/todo.json
```

control 使用临时文件、fsync 和原子 rename 写入。CLI 和 TUI 只能通过 control RPC 读取，不能直接读取该文件。

当前内存格式为 version 3。control 可读取 version 1 和 version 2：

- v1 的单个 active task 会转换成数组；缺失 title 时使用 taskId；
- v2 会补齐 comments，并迁移旧的无作用域评论；
- 下一次状态写入时统一保存为 version 3。

事件使用现有 instance stream：

```text
todo.created
todo.updated
todo.completed
todo.archived
```

完整状态通过 `instance.todo.get` 获取。instance snapshot 使用 `activeTodos` 返回所有仍需处理的任务摘要；全部完成、全部取消或空计划不会继续出现在 active 摘要中，`failed` 和 `blocked` 仍保留供诊断和恢复。

## CLI

```bash
devshell instance todo <instance>
devshell instance todo <instance> --follow
```

`instance status` 也会显示 Todo 摘要。

## TUI

Todo 是独立的 instance-scoped 一级页面。页面列出所有 live task、每个 Todo item，以及持久的 Context comment。评论可以从对应任务添加，并由用户显式删除。

## 工具调用关联

control 会检查当前工具调用的 `ctxId` 所拥有的全部 live task。仅当这些任务中恰好存在一个 `in_progress` 项时，worker tool call 记录才会自动带上：

```text
taskId
todoItemId
```

如果没有 `in_progress`，或者同一 `ctxId` 在多个任务中同时存在 `in_progress`，则不建立关联，避免任意误配。Audit 页面显示关联字段，但不会自动修改 Todo 状态。
