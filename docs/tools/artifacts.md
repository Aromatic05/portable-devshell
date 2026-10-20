# Artifact 分享与传输

## MCP 工具面

Artifact 在 MCP 上只保留图片查看 primitive：

```text
artifact_viewImage
```

`artifact_viewImage` 由 control 提供，并合并到实例 MCP endpoint 的固定工具 catalog。分享和跨实例传输属于 Artifact Extension command，不再作为 MCP tool 暴露。`bash_run` 会为超过 recovery 阈值或已经被 Worker 截断的 stdout/stderr 使用内部 ArtifactStore 保留可恢复输出（仍受 Artifact 存储上限约束），并返回 `/.devshell/tool-results/<id>/<stdout|stderr>` 形式的只读路径；模型通过普通 `file_read` 按需读取，不存在独立的 Artifact 文本读取工具。

本地用户通过 `devshell artifact ...` 使用 Artifact native Extension command。模型要调用同一 domain，必须先由当前 instance 的 `[extensions].model` 允许 `artifact`，然后在 `bash_run` / `tmux_run` 中通过 Context-bound `devshell artifact ...` 调用；不存在从 model command 到 builtin CLI 的 fallback。

## 图片查看

`artifact_viewImage` 必须且只能接受 `path` 或 `handle` 之一，来源 instance 默认是当前 MCP endpoint 对应的 instance。它通过 Worker 的 `artifact` port 读取来源：RPC `artifact.payload.open` 建立 payload lease，Stream `payload.read` 传二进制数据及 close metadata，RPC `artifact.payload.close` 释放 lease。本地、SSH、容器和反向连接共用此路径。

支持 PNG、JPEG、GIF 和 WebP；格式依据文件魔数判断，不信任扩展名。SVG、目录、空文件、未知格式以及超过 10 MiB 的图片会被拒绝。成功结果包含原生 MCP `ImageContent` 和不含图片字节的结构化元数据；payload lease 无论成功或失败都必须关闭。

Control 同时把已验证的图片按 BLAKE3 内容寻址保存到 `~/.devshell/control/artifacts/images/<hash-prefix>/<hash>.<ext>`。结构化结果只记录 `imageRef`、`blake3`、大小、媒体类型、名称和原始 source；Audit SQLite 不保存 base64 图片正文。Web/TUI 在查看历史 ToolCall 时通过内部 `@control / artifact / readImage` RPC（消息携带 `imageRef`）按需读取该快照，因此原始文件删除或来源 instance 离线后仍可查看已经审计过的图片。

## 内容、引用与租约

Worker ArtifactStore 按 handle 保存 stdout/stderr 数据与 metadata，payload lease 独立持久化。当前字段如下（不是独立 `contentId`/reference-count 数据库模型）：

```text
ArtifactReference（工具结果中的引用）
  handle
  stream: stdout | stderr
  sourceBytes
  storedBytes
  artifactTruncated
  blake3
  expiresAtMs

ArtifactMetadata（Worker 持久化记录）
  version + ArtifactReference 的字段 + createdAtMs

ArtifactLeaseMetadata（Worker 持久化租约）
  version
  leaseId
  handle
  expiresAtMs
```

`sourceBytes` 与 `storedBytes` 可不同；`artifactTruncated` 表示 Artifact 本身也可能受存储上限截断，不能承诺所有原始输出都完整保留。handle 过期后不能再取得新 lease；已取得的有效 lease 继续保护数据。Worker 从磁盘 lease metadata 重建按 handle 的内存 lease index，清理时同时考虑引用期限和有效 lease。

Control 的 share/transfer 持有 Worker payload lease，path 来源则先稳定成 payload snapshot。分享撤销/过期与 transfer 终态负责释放各自资源；这些业务状态不应写成 Worker ArtifactReference 的 `active | expired | revoked` schema。

## 分享

CLI `devshell artifact share` 必须且只能接受一种来源：

```text
handle
path
```

来源 instance 由 CLI 显式指定。只有 payload 已经稳定后才能创建分享：

- stdout/stderr Artifact：取得内容租约；
- 普通文件：复制并计算哈希，形成稳定快照；
- 目录：生成一个确定性的 `.tar.zst` payload。

分享支持 TTL、显式撤销和可选的成功下载次数上限 `maxDownloads`。成功 GET/Range 下载会增加 `downloadCount`；HEAD、认证失败和无效 Range 不消耗次数。达到上限后 share 进入 `exhausted`，后续下载返回 HTTP 410。

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

`HEAD` 不改变分享状态。撤销通过 control RPC、CLI 或 TUI 完成，不新增分享或传输 MCP 工具。

## 异步传输

`devshell artifact transfer` 是异步命令。启动、查询和取消分别使用：

```text
devshell artifact transfer <source-instance> <artifact:<handle>|path:<path>> <target-instance> <target-path> --target-workspace <absolute-path> ...
devshell artifact transfer status <transferId>
devshell artifact transfer cancel <transferId>
```

启动命令立即返回 `queued` 状态的传输记录。完整状态为：

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

### Worker 之间的 direct fast path

direct transfer 默认关闭。只有在 `~/.devshell/control/config.toml` 显式启用后，来源和目标是不同 Worker 时 Control 才会优先尝试 direct fast path：

```toml
[control]
artifactDirectTransfer = true
```

这个 fast path 使用 Worker 之间的明文 HTTP，只应该在由用户确认可信的 VPC、Tailscale/WireGuard overlay 或等价私网中启用。默认 `false` 时，无论 Worker 是否支持 direct RPC，payload bytes 都继续经 Control relay。

启用后，目标 Worker 为当前 receive 临时打开一个随机 bearer path 的 HTTP receiver，来源 Worker 直接把 raw payload chunk 推到该 receiver；Control 只传递 receiver URL、offset 和 chunk 大小，不再中转 payload 字节（当前 relay 使用二进制 Packet Stream，同样没有 base64 payload）。临时 receiver 最长存活 10 分钟，Control 默认申请 5 分钟，并在 transfer 完成或回退时显式关闭。

direct receiver 只广告 loopback、RFC1918、link-local 和 `100.64.0.0/10` overlay 地址，不广告 hostname 或公网地址。若两个 Worker 不在可直接互通的私网 / overlay、目标 Worker 版本较旧，或任意 direct chunk 失败，Control 会关闭 receiver、abort 当前 receive、重新 begin 一个干净 receive，然后自动回落到原有 Control relay。取消和 Control shutdown 不会被当成网络失败触发回落。

direct 与 relay 共用同一 `ArtifactPayloadStore` snapshot 和 `ArtifactReceiveStore`：raw HTTP chunk 仍执行严格 offset / declared-size 检查并持久化 receive metadata；最终仍由现有 `finish` 校验 payload bytes + BLAKE3，目录还会继续校验 manifest BLAKE3，随后走同一 atomic commit / recovery journal。因此 fast path 只改变 payload bytes 的网络路径，不改变传输状态机、验证规则或 commit 语义。

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

## Worker 数据面

所有 Worker transport 连接都在唯一 Frame `envelope` Service 上承载 Protobuf Envelope；Artifact 使用 `artifact` port，不单独打开 Artifact Frame Service。

| 操作 | 类型与名称 | 完成边界 |
| --- | --- | --- |
| 建立/关闭下载 lease | RPC `artifact.payload.open` / `artifact.payload.close` | RPC reply |
| 下载 chunk | Stream `payload.read`，open message 为 `{ payloadId, offsetBytes, maxBytes }` | binary DATA 后的 close metadata |
| 建立接收 | RPC `artifact.receive.begin` | RPC reply |
| 上传 chunk | Stream `receive.write`，open message 为 `{ receiveId, offsetBytes }` | 发送 binary DATA、Packet Stream FIN，然后等 close metadata |
| 校验并提交/放弃 | RPC `artifact.receive.finish` / `artifact.receive.abort` | RPC reply |

下载 bytes 前没有八字节长度 header。close message 提供 `payloadId`、`offsetBytes`、`returnedBytes`、`totalBytes`、`eof` 和可选 `nextOffsetBytes`；Core 校验 DATA 总字节数等于 `returnedBytes`。上传 close message 提供 `receiveId`、累计 `receivedBytes` 和 `nextOffsetBytes`，不代替最终 `finish` 的校验与 commit。

Packet Stream FIN 与底层 Frame FIN 不同；后者结束整条 Envelope 链路。连接丢失且尚未收到 RPC reply 时，结果可能已经提交，返回 `rpc.resultUncertain`、`retryable: false`，不会跨 generation 自动重放；先查询 transfer/接收状态再决定后续操作。完整协议见 [Transport 通信协议](../development/transport-protocol.md)。

## 内部 host bridge

`host` 是 Artifact 内部解析使用的伪 instance，不是受管 instance，没有 MCP endpoint、发现结果或 daemon 生命周期。**当前不向普通 CLI、模型或 TUI 开放通用 `host` 来源/目标访问。** 提供真实受管 instance 作为 `--authority` 也不能授权这条路径；用户显式请求 Agent 使用 `host` 同样不会绕过此限制。

当前 `ArtifactRuntime.transferHostPath()` 为内部 host-path → Worker 传输临时注册随机 `@host-artifact:…` authority，任务结束后移除。只有此集合中的 authority 才能由 `#resolveEndpoint("host", authority)` 获得内存中的 host store adapter；它不是隐式本地 Rust Worker。内部调用以 local / disabled 模式使用该 adapter，不能推广为依据当前 MCP instance 的 security mode 开放 host 文件系统。

bridge 内仍有 host 接收至 `~/Download`、收窄 basename 及安全 commit 的实现，但普通管理入口不能据此使用 `targetInstance = "host"`。未来若要开放，应单独定义公开授权契约；当前 schema/解析器可识别字符串不等于已经授权。

## Control RPC 接口

CLI 和 TUI 请求 host `@control`、port `artifact` 上的以下 RPC method；这些是地址与操作名，不是 `control.artifact.*` method 字符串：

```text
createShare
revokeShare
startTransfer
getTransfer
cancelTransfer
snapshot
```

`snapshot` 返回分享与传输列表；当前 wire 不提供 `listShares` / `listTransfers` method。实时订阅使用 Stream `subscribe`（消息 `{ fromSeq }`），不是 RPC。图片管理另有 `viewImage` / `readImage` RPC。这些操作不增加新的 MCP 工具名。

## CLI

```text
devshell artifact share <instance> <artifact:<handle>|path:<path>> [--workspace <absolute-path>] [--expires-in <seconds>] [--max-downloads <count>] [--authority <instance>]
devshell artifact shares
devshell artifact revoke <shareId>

devshell artifact transfer <source-instance> <artifact:<handle>|path:<path>> <target-instance> <target-path> --target-workspace <absolute-path> [--source-workspace <absolute-path>] [--overwrite] [--authority <instance>]
devshell artifact transfer status <transferId>
devshell artifact transfer cancel <transferId>
devshell artifact transfers
```

显式的 `artifact:` 和 `path:` 前缀避免普通路径被误判为 Artifact handle。path 来源需要显式绝对 workspace；transfer 的目标也必须提供 `--target-workspace`。启动传输后，CLI 输出排队记录，不等待任务完成。`artifact share` 创建成功时会返回一次可用的 bearer URL；可选 `--max-downloads` 限制成功 GET 的次数，HEAD 与无效 Range 不消耗次数，达到上限后 share 进入 `exhausted` 并返回 HTTP 410。`artifact shares` 会显示 `downloadCount` / `maxDownloads`，同时把 URL 显示为 `[redacted]`，避免管理面批量回显仍有效的 bearer credential。

Control 永远保留 active share 和非终态 transfer；exhausted / expired / revoked share 以及 completed / failed / cancelled / interrupted transfer 的终态历史默认各保留最近 256 条。压缩在运行期间发生，并同步删除对应的持久化元数据文件，因此长期运行不会让 share / transfer record store 无界增长。

## TUI

Artifact 活动显示在 Instances 页对应 instance box 内，不新增顶层页面。折叠状态显示分享和传输数量；展开后显示最近记录，并提供：

```text
撤销分享
取消传输
```

两个操作都使用现有确认对话框，默认焦点位于取消按钮。TUI 启动时从 control 拉取已持久化的分享和传输列表，之后通过 `artifact` port 的 `subscribe` Packet Stream 接收记录更新。
