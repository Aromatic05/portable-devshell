# Transport 通信协议

本文以源码审计基线提交 `2287310a`（beta.1）描述现行实现。Frame v1 仍是底层物理连接协议；应用复用、地址路由和 RPC 位于它之上。本文不是历史多 Service Frame 方案的实现计划。

## 分层与连接拓扑

```text
Provider：local / SSH / container / reverse 的准备与生命周期
    │
Carrier：IPC、SSH byte stream、WebSocket、SSE+POST 等
    │
Channel：有序双向字节，连接关闭即终止
    │
Frame v1：每条连接仅一次 OPEN，Service = envelope，opener streamId = 1
    │
length-delimited Protobuf Envelope：source / dest / packet
    │
Endpoint / Route / Port / Connection：按 host + port 路由
    │
Packet：Rpc / Event / Stream
    │
Control domain、Worker core/tool/artifact/terminal、network/process
```

CLI↔Control 与 Control↔Worker 使用共享 Endpoint、Envelope 和 Packet 基础设施。共享基础设施不合并两端的业务协议、握手或权限。CLI 仍进行 Control `server.hello` 协商；Worker 有自己的握手与工具发现。WebSocket message、IPC read、SSH stdout chunk 和 SSE event 都不是 Envelope 或 Frame 的通用消息边界。

Provider 负责建立访问 Worker 的条件；Carrier 负责承载字节；Channel 不理解 RPC、工具、Artifact 或应用 Stream。Reverse 主动建连的方向也不决定 Frame OPEN 权限：Control 是 opener，Worker 是 acceptor。

## Channel

当前 TypeScript 接口如下（见源码 `packages/shared/src/transport/endpoint/channel/Channel.ts`）：

```ts
interface Channel {
    readonly closed: boolean;
    write(data: Uint8Array): Promise<void>;
    onData(listener: (data: Uint8Array) => void): () => void;
    onClose(listener: (error?: Error) => void): () => void;
    close(error?: Error): void;
}
```

Channel 提供有序字节传递及关闭通知。`write()` 完成表示本地写入边界完成，不证明远端业务执行成功。不能在 Channel 内按工具名、RPC method 或 Artifact 内容选择另一条隐式业务路径。

Worker daemon 同时存在直接 RPC IPC 与 transport IPC：Unix 分别是 `worker.sock` 和 `transport.sock`；Windows 使用两个 Named Pipe，见 [Windows 支持](../operations/windows.md#worker-ipc)。直接 RPC IPC 的长度前缀 JSON 编码不能推广为 transport IPC 的 wire format。

## Frame v1：物理连接层

### 编码与大小

所有多字节整数使用大端。Frame 的外层长度不包含它自身的四字节：

```text
u32 bodyLength
u8  wireVersion = 1
u8  type
u32 streamId
... type payload
```

| 项目 | 当前限制 |
| --- | --- |
| Frame 公共 body header | 6 bytes |
| 最大 Frame body | 65,804 bytes，不含四字节 length |
| DATA payload | 最多 65,536 bytes |
| OPEN service UTF-8 | 1–256 bytes |
| OPEN metadata | 最多 65,536 bytes |
| RESET message UTF-8 | 最多 65,536 bytes |
| 默认 receive window | 262,144 bytes |

最大 body 来自 OPEN：`6 + 6 + 256 + 65536 = 65804`。**16 MiB 是编码后的 Envelope body 上限，不是 Frame 上限。** 一个 Envelope 可以跨多个 DATA Frame；一个 DATA chunk 也可能包含多个 Envelope 或不完整 Envelope。

| type | 值 | payload |
| --- | --- | --- |
| OPEN | `0x01` | `u32 receiveWindow`、`u16 serviceLength`、service UTF-8、剩余 metadata bytes |
| DATA | `0x02` | raw bytes |
| WINDOW | `0x03` | `u32 creditDelta`，必须为正 |
| FIN | `0x04` | 空 |
| RESET | `0x05` | `u16 code`、剩余 UTF-8 message |

wireVersion 字节为 `1`；TS 的 Frame protocol version/range 为 `1.0.0`。Reverse WebSocket subprotocol v2 是 Carrier 版本，不改变这个字节。

### 单一 Service 与状态

当前 FrameProtocol 每条连接只允许一次 Service OPEN；TS opener 固定发出 `streamId = 1`。关闭后不能在同一连接再 OPEN 第二个 Service。Endpoint 只接受 Service `envelope`；network、process、Artifact 不再各开 Frame Service。

```text
opener                              acceptor
OPEN(1, envelope, receiveWindow)  -> 验证 Service
                                 <- WINDOW(initial credit)
DATA / WINDOW                    <-> DATA / WINDOW
FIN（单向结束）                  <-> FIN
RESET 或 Channel close           -> 终止
```

OPEN 中的 receiveWindow 授权对端向 opener 发送 DATA；acceptor 接受时通过 WINDOW 授权反向发送。发送端消耗 DATA 字节 credit，credit 不足时等待；WINDOW 增量恢复 credit，不允许溢出 u32。FIN 仅结束一个发送方向，RESET 终止整个 Frame stream。由于连接只有一个 `envelope` stream，其 FIN/RESET 对 Endpoint 意味着整条 Envelope 链路结束，不是某个应用 Stream 的完成通知。

RESET code：`1 unsupportedService`、`2 serviceRejected`、`3 serviceFailed`、`4 cancelled`、`5 streamProtocolError`。无效长度、版本、type、streamId 或协议状态可终止连接；不能承诺所有应用错误都只影响单个 Packet Stream。

### 流控与调度边界

Frame credit 的消费边界是 Envelope endpoint。Rust 在解码并 dispatch 收到的 Envelopes 后调用 `frame.consume()` 返回 credit；Stream 输入可能只是进入应用写入队列，尚未写入 TCP、进程或文件。TS 的 FrameStreamChannel 也在读取底层字节时推进 Frame 消费。

因此不能把 WINDOW 描述成应用读完后的确认，不能承诺每个 Packet Stream 独立窗口、内存上限或公平调度。所有业务共享同一 Frame stream 的 credit 和连接。

Rust 当前在 endpoint dispatch 中同步调用 `ByteService::open`；TCP 的 DNS/connect 是同步操作。现行实现没有“32 路异步 Service opener”保证。独立且有界的异步打开、公平调度以及按应用消费返回 credit 如作为后续目标，必须明确作为提案，不能作为当前验收已完成项。

## Envelope 与地址路由

Envelope 使用 Protobuf varint 长度前缀；长度不含前缀，编码后的 body 最多 `16 * 1024 * 1024` bytes。它不是四字节大端长度前缀 JSON。当前 schema 对应 `packages/shared/src/transport/envelope/Envelope.proto`：

```proto
syntax = "proto3";
package devshell.transport;
message Address {
  string host = 1;
  string port = 2;
}
message Envelope {
  Address source = 1;
  Address dest = 2;
  Packet packet = 3;
}
message Packet {
  oneof value {
    bytes json = 1;
    StreamData stream_data = 2;
  }
}
message StreamData {
  string id = 1;
  uint64 seq = 2;
  bytes data = 3;
}
```

普通 Rpc/Event/Stream 控制包及 message DATA 编码为 Packet 的 JSON bytes；二进制 Stream DATA 使用专用 `stream_data`，无需 base64，解码后恢复 `protocol: "stream", type: "data"`。DATA 不能同时包含 `bytes` 和 `message`。TS seq 要求非负 safe integer；应用接收时还会检查连续递增。

`host` 与 `port` 均为非空字符串。这里的 port 是逻辑名称，不是 TCP 端口号：

- Endpoint 持有本地主机身份，`bind(port, host?)` 创建本地 Port；
- Route 管理本地投递、peer 链路和 gateway；
- Connection 固定 local/remote 地址，过滤 source/destination；
- Rpc/Event/Stream 绑定 Port 或 Connection，业务按 port 注册 handler。

地址不是认证凭据。Control 的 admission、Worker 连接握手和业务授权仍须独立成立。Endpoint 可以管理多条物理链路，但每条链路各自只有一个 Frame `envelope` stream。

## Packet 协议

下列为解码后的 Packet 形状，Envelope 的 source/dest 不重复写入每个 Packet。

### Rpc

```ts
type RpcPacket =
  | { protocol: "rpc"; type: "request"; id: string; method: string; message?: unknown }
  | { protocol: "rpc"; type: "reply"; id: string; message?: unknown }
  | { protocol: "rpc"; type: "error"; id: string; error: RpcError }
  | { protocol: "rpc"; type: "cancel"; id: string };
interface RpcError {
  message: string;
  code?: string;
  details?: unknown;
  retryable?: boolean;
}
```

request ID 使用安全随机 transport ID；reply/error 按 ID 与 peer 地址匹配。cancel 请求中止远端 handler 的 AbortSignal，不保证撤销已经发生的外部效果。不存在通用跨连接 exactly-once 或 terminal-response cache 保证。

连接在收到 reply 前断开，已发出请求的结果可能已经提交。TS Rpc 将 pending 请求拒绝为 `rpc.resultUncertain`、`retryable: false`。Endpoint 只重试建立 Channel，不重放 RPC 或工具执行。调用者应查询任务、文件或其他业务状态后，再决定是否发起新请求。

### Event

```ts
interface EventPacket {
  protocol: "event";
  name: string;
  message?: unknown;
}
```

Event 没有通用 reply、持久化或 replay。某个业务若支持 cursor/replay/gap，必须由该业务显式提供，不能从 Carrier ACK 或 Frame WINDOW 推导出来。

### Stream

```ts
type StreamPacket =
  | { protocol: "stream"; type: "open"; id: string; name: string; message?: unknown }
  | { protocol: "stream"; type: "data"; id: string; seq: number; bytes?: Uint8Array; message?: unknown }
  | { protocol: "stream"; type: "fin"; id: string }
  | { protocol: "stream"; type: "close"; id: string; message?: unknown }
  | { protocol: "stream"; type: "cancel"; id: string; error?: RpcError };
```

Packet Stream ID 是字符串，区别于 Frame 的整数 streamId。每个方向 DATA seq 从 1 连续递增；不接受 FIN 后的 DATA。TS `MessageStream.write()` 将二进制写入拆成最多 64 KiB 的 Packet chunks；外层 Envelope 增加的开销仍可能使它跨多个 Frame DATA。

```text
open -> data* -> fin（本方向输入结束，仍可接收）
     -> close(message?)（终态，可带完成元数据）
     -> cancel(error?)（异常终态）
```

`Stream.open()` 返回 MessageStream 不等于远端服务已成功打开；失败可以随后以 cancel 到达。`finish()` 是单向 FIN，`close()` 是终态。两者都不是 Frame FIN。断线会使现有 Stream 失败；不续传旧 ID/seq。

## Worker port 与数据面

Worker 控制 RPC 按 method 所属域路由：`artifact.*` 到 `artifact`，`terminal.*` 到 `terminal`，`tools.list` / `tool.*` 到 `tool`，其它 Worker 控制方法到 `core`。实际工具调用也走 `tool` port，消息携带 `{ input, context }`；不能把所有方法发送到一个旧 RPC Service。

| destination port | Stream name | open message | 数据与完成 |
| --- | --- | --- | --- |
| `network` | `tcp` | `{ host, port }` | 双向 TCP bytes；FIN 结束写方向 |
| `process` | `exec` | `{ executable, args?, cwd? }` | 输入为 stdin，输出为 stdout；成功 close 无 metadata，非零退出 cancel |
| `artifact` | `payload.read` | `{ payloadId, offsetBytes, maxBytes }` | 输出 binary DATA，close 返回读取元数据 |
| `artifact` | `receive.write` | `{ receiveId, offsetBytes }` | 输入 binary DATA，FIN 后 close 确认进度 |

process 直接启动 executable，不隐式加入 shell。stderr 被单独收集为最多 8 KiB 的摘要；非零退出通过 Stream cancel 报错并可包含此摘要，成功 close 不返回 exit-code metadata。调用者取消或断线时应按实际进程服务生命周期处理，不能把 Frame RESET 当作持久任务管理 API。

Core 当前高层入口为 `worker.execution.tunnel.connectTcp(input, signal?)` 与 `.execProcess(input, signal?)`，返回 `Promise<MessageStream>`。port/name 是 wire 契约；高层 API 不返回 FrameStream。

### Artifact

生命周期仍用 `artifact` port RPC：`artifact.payload.open/close`、`artifact.receive.begin/finish/abort` 等。bulk bytes 使用上表的 Packet Stream。

下载响应没有八字节 `totalBytes` header。close message 包含 `payloadId`、`offsetBytes`、`returnedBytes`、`totalBytes`、`eof` 及可选 `nextOffsetBytes`。Core 校验累计 DATA 字节数等于 `returnedBytes`；缺少 close metadata 视为失败。

上传者发送 bytes 后调用 Packet Stream `finish()`；close message 返回 `receiveId`、`receivedBytes`、`nextOffsetBytes`。这只确认当前写入进度，最终校验和 commit 仍由 `artifact.receive.finish` RPC 完成。lease 关闭、取消、offset、BLAKE3 与目录验证规则见 [Artifact 分享与传输](../tools/artifacts.md)。

## Reverse、重连与安全切换

Reverse connector 将同一 Frame/Envelope 字节连接桥接到 daemon transport endpoint；RPC 没有特殊旁路。WSS v2 的 DSR2 record、ready/ack 与 SSE sequence 是 Carrier 交付协议，见 [反向 Worker 连接协议](../operations/reverse-connections.md)。

新连接创建新的 Frame/Envelope stream。ReverseBridge 清除旧 pending/inflight Frame，重置 session 与序号，不把旧 DATA 片段送入新连接。Carrier 去重不等于 RPC 语义去重，重连也不恢复应用 Stream。

预期安全契约是：候选链路通过应用握手及 peer promotion 后才替换活动链路；候选失败应保留前驱可用性。**KNOWN 未解决偏差**：当前 ReverseIngress 在候选验证期间更新 descriptor 级 WSS reliable watermark，失败后未恢复。有效的更高 generation 候选发送被接受的 reliable record 后握手失败，旧连接可能仍显示 ready，但下一次回复被判 `Stale reverse generation frame.`，RPC 变成 `rpc.resultUncertain`。这不是期望的切换策略。

仓库内的独立红测为 [ReverseCandidateFailurePoisonsPreviousRound6.test.ts](../../test/known-bugs/ReverseCandidateFailurePoisonsPreviousRound6.test.ts)，使用 `ReverseNetworkRound6Fixture.ts` 构造认证 WSS 候选失败与前代 RPC。未套用 MemorySocketBoundary 时，它以 localhost TCP 执行；在禁止监听的受限 sandbox 中可能遇到 EPERM。本次文档修订仅对照源码，没有重新运行该红测；不能把先前的诊断记录当作本轮网络验收。

## 当前源码定位与验证范围

| 层 | 实现位置（仓库根目录相对路径） |
| --- | --- |
| Channel / Endpoint / Route | `packages/shared/src/transport/endpoint/` |
| Envelope schema / codec | `packages/shared/src/transport/envelope/` |
| Frame codec / state | `packages/shared/src/transport/frame/` |
| Rpc / Event / MessageStream | `packages/shared/src/transport/packet/` |
| CLI clients | `packages/cli/src/transport/Client.ts` |
| Control transport endpoint | `packages/control/src/server/transport/endpoint/Server.ts` |
| Worker runtime capability clients | `packages/core/src/instance/runtime/execution/capability/` |
| Worker link / packet client | `packages/core/src/instance/transport/` |
| Rust endpoint / Frame / Packet / Reverse | `crates/devshell-worker/src/transport/` |

现有针对性测试入口包括 `packages/shared/test/unit/transport/Endpoint.test.ts`（建立连接重试与 RPC uncertain）、`Channel.test.ts`（DSR2 record/ack）、Control 的 `ReverseNetworkRound6.test.ts` 及 Rust transport 单元测试。测试存在不表示全部已通过；运行结果、平台限制与已知 red regression 必须分别报告。协议验收应覆盖拆包/粘包、长度上限、单 OPEN、credit、seq/FIN/close、二进制 Artifact、断线不重放副作用请求和候选失败后前驱实际 RPC 可用性。
