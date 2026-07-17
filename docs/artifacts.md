# Artifact 分享与传输契约

版本：1

## MCP 工具面

Artifact 使用四个 MCP 工具名：

```text
artifact_read
artifact_viewImage
artifact_share
artifact_transfer
```

`artifact_read` 是 worker 工具，只读取 `bash_run` 为 stdout 或 stderr 创建的 Artifact。

`artifact_viewImage`、`artifact_share` 和 `artifact_transfer` 由 control 提供，并合并到实例 MCP endpoint 的工具 catalog。普通文件、目录、分享 payload 和传输 payload 不会获得 Artifact handle，也不能通过 `artifact_read` 读取。

## 图片查看

`artifact_viewImage` 必须且只能接受 `path` 或 `handle` 之一，来源 instance 默认是当前 MCP endpoint 对应的 instance。它通过已有 `artifact.payload.open/read/close` 协议读取来源，因此本地、SSH、容器和反向连接实例不需要新增 worker RPC。

支持 PNG、JPEG、GIF 和 WebP；格式依据文件魔数判断，不信任扩展名。SVG、目录、空文件、未知格式以及超过 10 MiB 的图片会被拒绝。成功结果包含原生 MCP `ImageContent` 和不含图片字节的结构化元数据；payload lease 无论成功或失败都必须关闭。

## 内容、引用与租约

Artifact 字节内容与对外暴露的短期 handle 分离保存：

```text
ArtifactContent
  contentId
  bytes
  blake3
  referenceCount 由持久化租约推导

ArtifactReference
  handle
  contentId
  expiresAt
  state: active | expired | revoked

ArtifactLease
  leaseId
  contentId
  ownerType: reference | share | transfer
  ownerId
  expiresAt
```

Artifact 引用过期或被撤销后立即不可访问，即使底层内容尚未删除，`artifact_read` 也必须拒绝读取。只有所有持久化租约都消失后，物理内容才可以删除。分享和传输任务必须先原子取得自己的租约，再返回成功。

control 重启后从持久化租约重建引用计数；单独维护的可变计数器不具有权威性。

## 分享

`artifact_share` 必须且只能接受一种来源：

```text
handle
path
```

来源 instance 默认是当前 MCP endpoint 对应的 instance。只有 payload 已经稳定后才能创建分享：

- stdout/stderr Artifact：取得内容租约；
- 普通文件：优先创建 reflink 快照，不支持时复制；
- 目录：生成一个确定性的 `.tar.zst` payload。

分享支持 TTL 和显式撤销。版本 1 不限制下载次数。

现有 MCP/OAuth HTTP listener 同时提供：

```text
GET  /artifacts/share/<token>
HEAD /artifacts/share/<token>
```

listener 仍只需要监听本地地址，通过与 MCP/OAuth 相同的反向代理或隧道对外暴露。token 是高熵 capability URL，日志不得记录完整 token。响应支持 HTTP Range，并设置：

```text
Cache-Control: private, no-store
Referrer-Policy: no-referrer
```

`HEAD` 不改变分享状态。撤销通过 control RPC、CLI 或 TUI 完成，不新增第四个 MCP 工具。

## 异步传输

`artifact_transfer` 是异步工具，支持三种操作：

```text
start
status
cancel
```

`start` 立即返回 `queued` 状态的传输记录。完整状态为：

```text
queued
preparing
transferring
verifying
committing
completed
failed
cancelling
cancelled
interrupted
```

control 重启后的恢复规则：

- `queued` 任务保持排队状态，可以重新调度；
- 已经开始执行但未结束的任务进入 `interrupted`，并清理临时接收状态；
- 终态记录保持不变；
- 如果 commit 被中断，必须先依据 commit journal 恢复或回滚，再进行清理。

来源租约只在任务进入终态后释放。

## 普通文件传输

普通文件按字节原样传输。用户自己的 `.zip`、`.tar.gz`、`.zst` 等归档仍被视为普通文件，不会自动解包或重新压缩。

接收端在目标父目录中创建临时文件，校验字节数和 BLAKE3，调用 `fsync`，原子 rename 到最终路径，并同步父目录。

## 目录载荷

目录在分享或传输过程中表示为确定性的 `.tar.zst` payload。目录传输完成后还原为目标目录，不会把归档文件留在目标位置。

允许的来源成员：

```text
普通文件
目录
空目录
隐藏文件和隐藏目录
```

拒绝的成员：

```text
符号链接
设备文件
FIFO
Unix socket
非 UTF-8 路径
tar hard-link 条目
绝对路径
空路径组件
. 和 .. 路径组件
```

多个来源路径即使指向同一个 inode，也分别序列化为独立普通文件。

归档条目相对于来源目录，统一使用 `/` 分隔，并按路径字节排序。归档不包含来源目录自身的名称。

保留的元数据：

```text
普通权限位，包括可执行位
精确到秒的修改时间
空目录
```

丢弃的元数据：

```text
uid/gid 与用户组名称
setuid/setgid/sticky 位
ACL
xattr
平台特有扩展元数据
```

版本 1 将稀疏文件作为完整普通文件传输。

目录 payload 有两个独立校验值：

- `payloadBlake3`：精确 `.tar.zst` 字节的校验值；
- `manifestBlake3`：还原条目的规范长度前缀二进制 manifest 校验值。

每个 manifest 条目包含类型、相对路径、mode、大小、修改时间；普通文件还包含自己的 BLAKE3。接收端必须在 commit 前同时验证两个校验值。

## 隐藏的 `host` 伪 instance

只有 Artifact 来源和目标解析认识精确字符串 `host`。它不是合法的受管 instance 名，不出现在实例发现结果中，不写入 MCP schema，也没有 MCP endpoint 或生命周期操作。

用户必须显式要求 Agent 使用 `host`。工具说明不会主动暴露这一能力，但这种知识边界不能替代实际安全校验。

### `host` 作为来源

当 path 来源的 `instance = "host"` 时，路径从运行 control 的机器读取。Artifact handle 不能使用 `host`，因为 handle 属于具体 worker 的 Artifact store。

host 来源访问使用受管 authority instance 的有效 `security.mode`：

- `disabled`：不增加 workspace 边界，但仍拒绝符号链接以及非文件、非目录来源；
- `workspace`：仅当 authority instance 使用 local provider，且请求路径位于该本地 workspace 内时允许。远程或容器 workspace 不能被当作 host 路径。

当前 MCP endpoint 对应的 instance 默认充当 authority instance。CLI/TUI 使用 `host` 时也必须提供或推导出一个真实受管 authority instance。host 访问事件写入该 authority instance；`host` 本身永远不会成为 instance。

### `host` 作为目标

当 `targetInstance = "host"` 时，目标始终重定向到 control 用户的 `~/Download` 目录。

`targetPath` 只用于建议最终 basename，父路径组件会被丢弃，最终对象必须是 `~/Download` 的直接子项。basename 无效时使用来源默认名称。

host 接收端相对于已打开的 Download 根目录写入或解包，拒绝最终符号链接目标，校验内容，并通过根目录内的临时项完成 commit。

## Control RPC 接口

CLI 和 TUI 使用以下生命周期操作：

```text
control.artifact.createShare
control.artifact.listShares
control.artifact.revokeShare
control.artifact.startTransfer
control.artifact.getTransfer
control.artifact.listTransfers
control.artifact.cancelTransfer
```

这些 RPC 不增加新的 MCP 工具名。

## CLI

```text
devshell artifact share <instance> <artifact:<handle>|path:<path>> [--expires-in <seconds>] [--authority <instance>]
devshell artifact shares
devshell artifact revoke <shareId>

devshell artifact transfer <source-instance> <artifact:<handle>|path:<path>> <target-instance> <target-path> [--overwrite] [--authority <instance>]
devshell artifact transfer status <transferId>
devshell artifact transfer cancel <transferId>
devshell artifact transfers
```

显式的 `artifact:` 和 `path:` 前缀避免普通路径被误判为 Artifact handle。启动传输后，CLI 输出排队记录，不等待任务完成。

## TUI

Artifact 活动显示在 Instances 页对应 instance box 内，不新增顶层页面。折叠状态显示分享和传输数量；展开后显示最近记录，并提供：

```text
撤销分享
取消传输
```

两个操作都使用现有确认对话框，默认焦点位于取消按钮。TUI 启动时从 control 拉取已持久化的分享和传输列表，之后通过每实例 `artifact.*` stream event 更新完整记录。
