# 运行时 Debug Patch

`devshell debug` 用于给当前 Control 进程中的已注册对象临时安装可回滚的调试逻辑。Patch 只存在于内存中，不写入配置，也不会跨 Control 重启保留。

## 访问边界

Debug Patch 只接受本机 owner 的 CLI Control socket 请求：

```text
devshell debug targets
devshell debug list
devshell debug load <target> <file> --ctx <ctxId> [--tool <toolName>]
devshell debug release <patchId>
devshell debug unload <patchId>
```

即使远程 WebSocket 连接以 CLI 身份接入，也不能调用 `debug.*`。当前默认 target 为每个 live worker：

```text
worker:<instance>
```

当前暴露的方法为 `callTool`。

## Patch 程序

当前 `worker:*` target 强制要求 `--ctx <ctxId>`，并可用 `--tool <toolName>` 把 scope 进一步限定到一个工具。Scope 在 Control 主线程的 wrapper 中、创建 invocation 之前匹配；Context 或 toolName 不匹配的调用直接执行原方法，不做参数投影、不进入 Debug Worker、不增加 `invocationCount`，也不会覆盖 `lastInvocation`。

文件内容必须是一个 JavaScript 函数表达式。函数只会收到已经通过 scope 的调用的只读 JSON 投影，不接收 Control 或 Worker 的真实对象：

```js
(event) => {
    if (
        event.method === "callTool" &&
        event.args.toolName === "file_read"
    ) {
        return { action: "hold", label: "host-timeout-probe" };
    }
    return { action: "continue" };
}
```

`worker:<instance>.callTool` 的 `event.args` 为：

```text
{
  toolName,
  input,
  signalAborted,
  context: {
    ctxId?,
    requestId?,
    source?,
    workspace?
  }
}
```

程序必须返回以下指令之一：

```text
{ action: "continue" }
{ action: "hold", label?: string }
{ action: "return", value: <JSON> }
{ action: "error", message: string }
```

`continue` 调用原方法。`hold` 只挂起当前匹配的调用，直到 Host abort、`debug release` 或 `debug unload`。`return` 直接返回 JSON 值。`error` 是显式调试行为，会让当前调用抛错，但不会卸载 Patch。

一个 target 同时只允许一个 active Patch。Patch source 最大 64 KiB。

## 保护模式

Control 进程不直接执行 Patch JS。每个 Patch 在独立 Worker Thread 中运行，并在该线程内使用 `vm` context；Control 只在已注册对象上安装一个可恢复的 method wrapper。

以下情况会被视为 Patch fault：

- 初始化或语法错误；
- 调用时脚本抛出异常；
- 同步死循环或执行超时；
- async 调用超过执行预算；
- Debug Worker 异常退出或崩溃。

发生 fault 时，Control 会立即撤销 wrapper、恢复安装前的 property descriptor、释放该 Patch 的 hold，并把 Patch 记录为 `faulted`。触发 fault 的普通方法调用会继续执行原实现，而不是把调试故障扩散到业务路径。

这套机制用于可信的本地开发调试，不把 Node `vm` 宣称为恶意代码安全边界。隔离目标是让开发脚本的常见错误、异常、死循环和 Worker 失败不能卡死 Control event loop，并且始终有确定的回滚路径。

## 查看状态

`devshell debug list` 返回 active 与最近 terminal Patch。每条记录包括 `loadedAt`、`unloadedAt`、`fault`、调用次数，以及最近一次 invocation 的开始/结束时间和 outcome。

对于 Host timeout 实验，先通过已有 audit/context metadata 确认目标 internal `ctxId`，再用 `--ctx <ctxId> --tool <toolName>` 加载 Patch。其他 Context，以及同一 Context 的其他工具，都会在 Manager scope gate 处直接绕过 Patch，连 invocation 统计和参数 projection 都不会发生。
