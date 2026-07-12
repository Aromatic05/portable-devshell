# Todo 进度

Todo 用于记录 Agent 当前任务的计划和进度。它由 TypeScript control 管理，不属于 worker，也不会出现在 worker 的 `tools.list` 中。

## MCP 工具

```text
todo_read   access=read
todo_write  access=write
```

工具是否暴露只由 instance 的 `mcp.tools.groups` 中是否包含 `todo` 控制，不要求任何 capability。默认新建 instance 会启用 `todo` group。

`todo_read` 不接受参数，返回当前 active task 的完整列表、revision 和 control 计算的摘要。

`todo_write` 使用完整列表替换当前状态：

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

revision 必须与当前状态一致。冲突返回：

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

- 同一任务最多一个 `in_progress`。
- `blocked` 和 `failed` 必须提供 `detail`。
- `id` 在当前任务内唯一，`content` 不得为空。
- 进度为 `completed / 非 cancelled 项目数`，由 control 计算。
- taskId、revision 和时间字段由 control 生成。

## 持久化和事件

状态保存在：

```text
~/.devshell/<instance>/control-worker/todo.json
```

control 使用临时文件、fsync 和原子 rename 写入。CLI 和 TUI 只能通过 control RPC 读取，不能直接读取该文件。

事件使用现有 instance stream：

```text
todo.created
todo.updated
todo.completed
todo.archived
```

完整状态通过 `instance.todo.get` 获取；`instance.getSnapshot` 只包含 active Todo 摘要。

## CLI

```bash
devshell instance todo <instance>
devshell instance todo <instance> --follow
```

`instance status` 也会显示 Todo 摘要。

## TUI

Todo 是独立的 instance-scoped 一级页面，不放入 Instances box。页面包含任务摘要和每个 Todo item 的只读 box，并通过现有 instance event stream 实时刷新。

## 工具调用关联

当 active Todo 恰好存在一个 `in_progress` 项时，后续 worker tool call 记录会自动带上：

```text
taskId
todoItemId
```

模型不需要给 `bash_run`、`file_edit` 等工具显式传 Todo ID。Audit 页面会显示这两个关联字段，但不会自动修改 Todo 状态。
