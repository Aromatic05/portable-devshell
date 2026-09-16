# Transport 通信协议设计

> 状态：目标设计，指导 `feat/transport-frame` 后续开发；本文描述尚未完全落地的新 Transport 协议，不代表当前 `0.7.4` wire behavior。
>
> 当前 Reverse Worker 的 WSS / SSE、RPC lane、generation 与 replay 行为仍以 [反向 Worker 连接协议](../operations/reverse-connections.md) 为准。迁移完成后，再更新运行态文档。

本文把决策状态分成三类，避免把已确认架构、本文 v1 开发契约和后续候选项混在一起：

```text
已冻结架构
    Provider -> Channel -> Frame -> Service -> Protocol
    Provider 与 Carrier 不拆分
    Channel 只提供 byte service
    Frame 是 length-prefixed PDU，并承担 multiplex / logical stream flow control
    不建立独立 Framing / Session / Stream 架构层
    新 transport 实现只进入各 package / crate 的 transport domain

本文冻结的 v1 开发契约
    Frame header 与 OPEN / DATA / WINDOW / FIN / RESET
    单侧 OPEN
    per-stream credit / half-close / RESET
    network.tcp / process.exec 两个证明型 Service

后续迁移候选
    worker.rpc
    Control transport
    Artifact bulk traffic
```

## 1. 目标

portable-devshell 需要一套统一而足够小的通信基础设施，使不同 Provider 可以承载相同的上层能力，同时避免 transport 理解具体业务协议。

目标分层固定为：

```text
Provider
   ↓
Channel
   ↓
Frame
   ↓
Service
   ↓
Protocol / Consumer
```

五层分别回答五个问题：

```text
Provider   如何获得到另一端的通信能力
Channel    如何可靠、有序地搬运 bytes
Frame      如何在一条 Channel 上表达多条逻辑流
Service    一条逻辑流应该接到什么能力
Protocol   这些 bytes 在业务上是什么意思
```

本设计的核心不是增加更多抽象，而是恢复严格的依赖方向：**下层只向上层提供服务，下层不得理解上层 PDU 的业务语义。**

## 2. 非目标

第一版明确不实现：

- TCP 风格的重传、RTT 估计、slow start 或 congestion window；
- Frame 层透明断线恢复、stream resume 或 exactly-once；
- 多物理连接 striping / bonding；
- traffic class、strict priority 或复杂 QoS；
- public Extension transport ABI；
- 为未来 Service 预建 `ServiceFactory`、`ServiceProvider`、`ServiceRegistry` 等层级；
- 为解释模型额外建立 `Carrier`、`Framing`、`Session`、`Stream` 架构层。

这些能力只有出现真实需求后才进入设计。

## 3. 分层与依赖规则

### 3.1 Provider

Provider 负责建立、维持和关闭底层通信能力，并向上层提供 `Channel`。

当前或预期的 Provider 包括：

```text
Local
SSH
Docker
Podman
Reverse
```

本设计不再区分 Provider 与 Carrier。Socket、WebSocket、SSE、SSH stdio、container exec 等都是 Provider 实现 Channel 时使用的媒介，不形成新的公共架构层。

Provider 可以负责：

- worker install / start / attach 所需的连接建立；
- socket / stdio / WSS / SSE 等具体 I/O；
- transport heartbeat；
- Provider 自身的认证、重连和连接 generation；
- 把消息型或分片型底层媒介归一成 Channel byte service。

Provider 不得理解：

```text
OPEN
DATA
WINDOW
FIN
RESET
streamId
service name
Worker RPC method
HTTP / TLS / rsync
```

### 3.2 Channel

Channel 是 Provider 向 Frame 提供的服务。

概念接口：

```ts
interface Channel {
    readonly closed: boolean;

    write(data: Uint8Array): Promise<void>;
    onData(listener: (data: Uint8Array) => void): () => void;
    onClose(listener: (error?: Error) => void): () => void;

    close(error?: Error): void;
}
```

Channel 的契约是：

1. 正常连接生命周期内，bytes 可靠且有序；
2. `write()` 的数据顺序必须被保留；
3. `write()` 的 Promise 必须传播底层发送 backpressure 和失败；
4. `onData()` 返回的 chunk **没有任何协议边界含义**；
5. 底层可以任意拆分或合并 chunk；
6. Channel close 是整条连接关闭，不提供逻辑 half-close；
7. Channel 不提供 replay / resume 语义。

例如上层写入两个 Frame：

```text
Frame A = 100 bytes
Frame B = 200 bytes
```

Channel 对端可以合法观察到：

```text
50 + 50 + 120 + 180
```

也可以观察到：

```text
300
```

Frame decoder 必须自行恢复 PDU 边界。

即使 WebSocket 天生提供 message boundary，`WebSocketChannel` 也不得把该边界暴露成 Frame 语义：

```text
WebSocket message ─┐
TCP byte stream ───┼─> Channel bytes
SSH stdio ─────────┤
SSE / POST ────────┘
```

### 3.3 Frame

Frame 是建立在 Channel byte service 之上的 transport PDU。

它负责：

- length-prefix framing；
- logical stream multiplex / demultiplex；
- stream lifecycle；
- per-stream receive credit；
- bounded buffering；
- 基本公平发送。

它不负责：

- 网络可靠性与网络拥塞控制；
- Service metadata 的业务解释；
- DATA payload 的协议解释；
- Provider 重连；
- RPC request replay。

`stream` 不是独立 wire object，也不是新的架构层。

一个 logical stream 只是：

> 具有相同 `streamId` 的一组 Frame 按协议形成的双向逻辑字节流。

### 3.4 Service

Service 决定 logical stream 与目标能力之间的绑定关系。

第一批目标 Service：

```text
network.tcp
process.exec
```

后续迁移候选：

```text
worker.rpc
control.rpc
```

Service 可以解释 `OPEN` metadata，但不得解释 DATA 中承载的上层 Protocol。

例如：

```text
HTTPS
  ↓
network.tcp(host, port)
  ↓
Frame logical stream
```

Transport 不解析 TLS 或 HTTP。

又例如：

```text
rsync
  ↓
process.exec(executable, args, cwd)
  ↓
Frame logical stream
```

Transport 不认识 rsync 协议。

### 3.5 Protocol / Consumer

Protocol 是 transport 之外的消费者。

包括但不限于：

```text
HTTP
TLS
rsync
Worker RPC
Control RPC
database protocols
```

以下名称若进入通用 Frame 实现，说明分层已经泄漏：

```text
artifact.payload.*
artifact.receive.*
tool.call.*
terminal.*
HTTP
rsync
```

## 4. Channel 与 Frame 的依赖方向

当前实现：

```ts
interface Channel {
    send(frame: Frame): Promise<void>;
    onFrame(listener: (frame: Frame) => void): () => void;
}
```

它把 Channel API 绑定到了上层 PDU。

目标实现改为：

```text
Provider
   │ creates
   ▼
Channel
   │ byte service
   ▼
Frame codec + state
```

依赖规则冻结为：

> **Frame 可以依赖 Channel；Channel 不得依赖 Frame protocol semantic。**

因此 Socket / WebSocket / SSE / SSH 等 Channel 实现中禁止出现 `streamId`、Frame type、Service 或 RPC method 判断。

## 5. Frame v1 wire format

### 5.1 基本格式

所有整数采用 big-endian。

每个 Frame 都是一个 length-prefixed byte packet：

```text
0               4       5       6              10
┌───────────────┬───────┬───────┬───────────────┬───────────────┐
│ length: u32   │ ver   │ type  │ streamId: u32 │ payload ...   │
└───────────────┴───────┴───────┴───────────────┴───────────────┘
```

字段含义：

```text
length
    后续 bytes 总数，不包含 length 自身

ver
    Frame protocol version；v1 固定为 1

type
    Frame type

streamId
    logical stream identifier

payload
    由 type 决定结构
```

v1 固定 header 为 6 bytes，不包含外层 4-byte `length`。

`streamId = 0` 保留，不得用于普通 stream。

Frame v1 不增加独立 preface，不依赖底层 message boundary，也不使用 transport-specific magic。

### 5.2 Frame type

v1 只定义：

```text
0x01 OPEN
0x02 DATA
0x03 WINDOW
0x04 FIN
0x05 RESET
```

未知 `type` 在 v1 中是 connection-level protocol error。

第一版不定义：

```text
ACK
PING
PONG
GOAWAY
RESUME
REPLAY
PRIORITY
```

Provider 自己负责 heartbeat；Protocol 自己负责需要的 request retry / replay。

## 6. Stream identifier

Frame v1 采用单侧 OPEN 模型：

```text
opener   可以发送 OPEN
acceptor 不发送 OPEN，只接受或 RESET
```

初始实现中：

```text
Control side = opener
Worker side  = acceptor
```

这与底层物理连接建立方向无关。Reverse Worker 即使由 Worker 主动建立 WSS，也不改变 Frame opener / acceptor 角色。

opener：

- 从 `1` 开始单调分配 `streamId`；
- 同一 Channel 生命周期内不得复用已经使用过的 ID；
- ID 空间耗尽时关闭当前 Channel 并建立新 Channel，不回绕复用。

单侧 OPEN 避免第一版引入 odd/even ID、冲突解决或双向 stream allocation。未来若出现 Worker 主动 open Service 的真实需求，再通过新 protocol version 扩展。

## 7. OPEN

`OPEN` 创建 logical stream 并选择 Service。

payload：

```text
┌────────────────────┬─────────────────────┬──────────────────┬────────────────┐
│ receiveWindow: u32 │ serviceLength: u16  │ service: bytes   │ metadata ...   │
└────────────────────┴─────────────────────┴──────────────────┴────────────────┘
```

语义：

```text
receiveWindow
    opener 授予 acceptor 的初始发送 credit

service
    UTF-8 Service name，例如 "network.tcp"

metadata
    Service-specific opaque bytes；Frame 层不得解析
```

约束：

- `serviceLength > 0`；
- service 必须是合法 UTF-8；
- `receiveWindow > 0`；
- 同一 `streamId` 只能 OPEN 一次；
- Frame 层只解析 service name 和 receiveWindow，metadata 原样交给 Service。

第一批内建 Service 可以各自在 Service 层使用 UTF-8 JSON metadata；这不是 Frame wire contract。

OPEN 后 opener 的发送 credit 初始为 `0`。

acceptor 成功建立 Service 后，通过第一个 `WINDOW` 授予 opener credit：

```text
OPEN -------------------->
     <-------------------- WINDOW +N
DATA -------------------->
```

因此 v1 不需要额外 `OPEN_ACK`。

Service 建立失败时：

```text
OPEN -------------------->
     <-------------------- RESET
```

acceptor 可以在发送第一个 WINDOW 前，使用 OPEN 中获得的 `receiveWindow` 向 opener 发送 Service 输出。

## 8. DATA

DATA payload 全部是上层 Protocol bytes：

```text
┌──────────────────────────────┐
│ protocol bytes ...           │
└──────────────────────────────┘
```

Frame 不增加 offset、sequence 或 checksum。

理由：

- Channel 已保证连接生命周期内可靠、有序；
- Frame 不做重传；
- logical stream byte offset 可以由本地状态直接累计。

每个方向发送 DATA 前必须有足够 `sendCredit`：

```text
payload.length <= sendCredit
```

发送后：

```text
sendCredit -= payload.length
```

若对端发送超过已授予 credit 的 DATA，属于 connection-level protocol violation。

DATA frame 必须设置统一的最大 payload，防止单个 logical stream 长时间占据 Channel。具体 v1 常量在实现时由 TypeScript/Rust 共享测试固定，第一版建议从 `64 KiB` 开始。

整个 Frame 也必须有硬上限。迁移初期沿用现有 `16 MiB` transport frame 上限，避免在重构同时改变资源防护边界；DATA 的更小上限用于 multiplex 公平性，两者职责不同。

## 9. WINDOW

WINDOW 只解决 logical stream consumer backpressure，不实现网络 congestion control。

payload：

```text
┌──────────────────┐
│ creditDelta: u32 │
└──────────────────┘
```

`creditDelta` 必须大于 `0`。

发送 WINDOW 的时机是：

> **上层 Service / Protocol 真正消费 DATA 之后。**

不是 Frame 刚被解析时立即返还 credit。

例如：

```text
sender                         receiver

DATA 64K -------------------->
DATA 64K -------------------->
                               service consumes 128K
          <------------------- WINDOW +128K
DATA 64K -------------------->
DATA 64K -------------------->
```

这保证慢 consumer 只能压住自己的 logical stream，不能通过无限 receiver buffering 消耗整个进程内存。

### 9.1 为什么不能只依赖 TCP backpressure

如果没有 per-stream WINDOW：

```text
stream 1  terminal
stream 2  worker.rpc
stream 3  large transfer
```

当 stream 3 的 consumer 很慢时，只剩两种错误选择：

```text
A. 无限缓存 stream 3 DATA
B. 停止读取整个 Channel
```

选择 B 会同时阻塞 stream 1 和 stream 2。

因此 Frame WINDOW 解决的是：

> multiplex 后不同 logical consumer 之间的 backpressure 隔离。

TCP congestion control 解决的是网络承载能力，两者不是同一个问题。

## 10. FIN

FIN 表示当前发送方向正常结束。

FIN 没有 payload。

它是 half-close，不是整个 logical stream close：

```text
A                           B

DATA --------------------->
FIN ---------------------->

     <--------------------- DATA
     <--------------------- DATA
     <--------------------- FIN
```

发送 FIN 后，本端不得再发送 DATA，但仍然可以接收对端 DATA。

只有两个方向都 FIN 后，logical stream 才正常结束。

half-close 对以下 Service 是必要语义：

- `network.tcp`：映射 socket write-half shutdown；
- `process.exec`：关闭 child stdin 后继续读取 stdout/stderr；
- 依赖 EOF 表达请求结束的上层 Protocol。

FIN 不消耗 stream credit。

## 11. RESET

RESET 表示整个 logical stream 异常终止。

收到 RESET 后必须：

- 丢弃该 stream 未发送 DATA；
- 拒绝该 stream pending read/write；
- 关闭对应 Service resource；
- 删除 stream state；
- 不再接受该 stream 的 DATA / WINDOW / FIN。

RESET 不是 half-close，不区分方向。

v1 RESET payload：

```text
┌───────────┬──────────────────┐
│ code: u16 │ message: UTF-8   │
└───────────┴──────────────────┘
```

`code` 属于 Frame/Service transport failure taxonomy；`message` 仅用于诊断，不作为程序分支依据。

初始 code 至少覆盖：

```text
1 unsupportedService
2 serviceRejected
3 serviceFailed
4 cancelled
5 streamProtocolError
```

具体 Service 的业务错误应由上层 Protocol 表达，不应无限扩展 RESET code。

## 12. Logical stream state

每个 stream 至少维护：

```text
id
service
sendCredit
receiveCredit
localFin
remoteFin
sendQueue
serviceState
```

状态机：

```text
             OPEN
CLOSED ----------------> OPEN

OPEN
  │
  ├─ DATA*
  │
  ├─ local FIN --------> HALF_CLOSED_LOCAL
  │
  ├─ remote FIN -------> HALF_CLOSED_REMOTE
  │
  └─ RESET -----------> CLOSED

HALF_CLOSED_LOCAL
  │
  ├─ receive DATA
  ├─ remote FIN -------> CLOSED
  └─ RESET -----------> CLOSED

HALF_CLOSED_REMOTE
  │
  ├─ send DATA
  ├─ local FIN --------> CLOSED
  └─ RESET -----------> CLOSED
```

Frame 层内部可以有 stream state 实现，但这不形成一个新的 `Stream` 架构层或 public transport taxonomy。

## 13. Buffering 与发送公平性

### 13.1 bounded queue

本地 producer 不得通过一次大 `write()` 把整个 payload 复制进 Frame send queue。

必须形成真实 backpressure：

```text
Protocol producer
      │
      ▼
bounded per-stream queue
      │
      ▼
Frame scheduler
      │
      ▼
Channel.write()
      │
      ▼
Provider / TCP / SSH / WSS
```

当 queue 达到 high-water mark 或 sendCredit 用尽时，上层 write 必须 await。

### 13.2 v1 scheduling

第一版不做 priority class。

DATA 使用简单公平 ready queue：

```text
stream A -> one DATA chunk
stream B -> one DATA chunk
stream C -> one DATA chunk
stream A -> one DATA chunk
...
```

目标不是保证硬实时，而是避免一个 bulk producer 在应用层先把大量 DATA 排进 Channel，造成其他 stream 明显 head-of-line waiting。

控制 Frame 的调度规则：

- OPEN 必须先于同 stream 的其它 Frame；
- DATA 与 FIN 保持同 stream 顺序；
- WINDOW 不受 DATA credit 限制；
- RESET 会取消该 stream 尚未发送的 DATA/FIN，并尽快发送；
- 不同 stream 之间没有业务顺序保证。

只有实际测试证明 terminal / RPC latency 需要更强 QoS 后，才考虑 weighted scheduling。

## 14. Connection failure 与恢复边界

Frame v1 明确规定：

> **Channel lifetime = 当前 Frame logical-stream set 的 lifetime。**

Channel 关闭时：

```text
Channel close
    ↓
all logical streams fail
    ↓
all Service resources close
```

Frame v1 不尝试透明恢复：

```text
stream resume
frame sequence replay
exactly-once
connection migration
```

原因是多数 Service 无法通用恢复：

```text
network.tcp
process.exec
```

其远端资源状态本身就可能已经失效。

需要 request retry / replay 的 Protocol 自己拥有该语义。例如迁移后的 Worker RPC 可以继续在 RPC 层根据 request ID 处理 retry，而不能要求 Frame replay raw DATA。

Reverse Provider 当前 generation / reconnect / completed-result cache 也应逐步收敛到正确层级：Provider 可以恢复 Channel availability，RPC 可以恢复逻辑 request，但 Frame 不承诺跨 Channel 恢复 logical stream。

## 15. Protocol error 边界

### 15.1 connection-level error

以下错误破坏整个 Frame 协议可信度，必须关闭 Channel：

- length 非法或超过实现上限；
- Frame version 不支持；
- 未知 Frame type；
- `streamId = 0` 用于普通 v1 Frame；
- DATA 超过对端授予的 credit；
- WINDOW delta 为 0 或 credit arithmetic overflow；
- duplicate OPEN；
- 对已经进入非法状态的 stream 继续发送无法容忍的 Frame；
- malformed fixed-size payload。

### 15.2 stream-level error

以下错误通常只 RESET 当前 stream：

- Service 不存在；
- Service metadata 非法；
- TCP connect 失败；
- process spawn 失败；
- Service 本地资源异常；
- consumer 主动取消。

原则是：

> 无法继续可信解析整个 Frame connection 才关闭 Channel；单个 Service 的失败不得扩大成整个连接失败。

## 16. Service v1

### 16.1 `network.tcp`

职责：在 Worker 网络命名空间中建立 TCP connection，并把 socket 双向 bytes 与 logical stream 映射。

概念 metadata：

```json
{
    "host": "127.0.0.1",
    "port": 8080
}
```

映射：

```text
Frame DATA -> socket write
socket read -> Frame DATA
remote FIN -> socket write-half shutdown
socket EOF -> local FIN
RESET -> socket close
```

Transport 不解析 TCP 上承载的协议。

该 Service 用于证明：

- HTTP over DevShell；
- HTTPS over DevShell；
- 数据库等任意 TCP protocol；
- Service 与 Protocol 正交。

### 16.2 `process.exec`

职责：在 Worker 上启动指定 executable，并把 process I/O 映射到 logical stream。

概念 metadata：

```json
{
    "executable": "rsync",
    "args": ["--server", "..."],
    "cwd": "/workspace"
}
```

v1 映射固定为：

```text
Frame DATA        -> child stdin
remote FIN        -> close child stdin
child stdout      -> Frame DATA
stdout EOF + exit 0 -> local FIN
spawn failure     -> RESET serviceFailed
non-zero exit     -> RESET serviceFailed
RESET             -> terminate child
```

`stderr` 不进入 DATA，因为它不是上层 byte protocol 的一部分。v1 只允许把有界 stderr 摘要附到诊断 message；程序不得依赖该 message 做协议分支。

该 Service 用于证明 rsync 等“程序自身拥有协议”的场景可以直接复用 Transport，而不需要为 rsync 增加专用 DevShell wire protocol。

### 16.3 `worker.rpc`

`worker.rpc` 是迁移目标，不是第一阶段前置条件。

迁移后：

```text
Worker RPC serializer
        ↓ bytes
worker.rpc Service
        ↓
Frame logical stream
        ↓
Channel
```

Frame 和 Provider 不再检查 RPC method。

因此现有：

```text
artifact.payload.* -> bulk
artifact.receive.* -> bulk
```

这种业务语义下沉到 connection layer 的设计应最终移除。

## 17. Reverse Provider 收敛方向

当前 Reverse 使用：

```text
control lane
bulk lane
```

同时 `WorkerRpcLaneChannel` 解析 RPC method 来选择 lane。

新模型已经由 Frame 提供 logical multiplex，因此长期结构应收敛为：

```text
Reverse Provider
      ↓
one Channel
      ↓
Frame multiplex
```

不能形成：

```text
Frame multiplex
      ↓
RPC control/bulk classification
      ↓
Reverse physical lanes
```

若未来确有多物理连接吞吐需求，应由 Provider 内部实现，不允许 Frame 或 Protocol 依赖具体 lane。

## 18. Security boundary

Transport 统一不等于权限统一。

Service open 必须经过现有 Control / instance / capability authority。不能因为已经获得 Channel，就自动允许任意：

```text
network.tcp
process.exec
future worker services
```

Frame 只负责表达 Service open，不负责决定调用者是否有权限。

Transport implementation 不得把底层 Channel、Frame、window 或 raw socket 直接冻结进 public Extension ABI。Extension 若未来需要通信能力，应暴露 domain-level capability，例如：

```text
open worker service
```

而不是：

```text
get Channel
send Frame
manage window
```

## 19. 目录与分类学约束

本次实现不得为了分层图机械建立五层目录。

现有目录命名已经具有稳定分类学，新通信代码只能落在各 package / crate 的 `transport` domain 中；必要的消费者改动只能是调用 public transport API，不得把新的 transport 实现散落到业务目录。

目标形态：

```text
packages/shared/src/transport/
  protocol/
    Channel.ts
    Codec.ts
    Frame.ts
    PrefixRoute.ts
  socket/
  websocket/

packages/core/src/worker/transport/
  command/
  container/
  process/
  provider/
  Binary.ts
  Factory.ts

crates/devshell-worker/src/transport/
  frame/
    mod.rs
    codec.rs
    stream.rs
  service/
    mod.rs
    exec.rs
    tcp.rs
  reverse/
  socket/
  mod.rs
```

其中：

- `frame/stream.rs` 只是 Frame 协议内部 logical stream state，不代表独立 Stream layer；
- TypeScript shared 当前已有 `transport/protocol/Frame.ts`，优先扩展现有分类，不为了对称性强行搬目录；
- 不新增 `session/`；
- 不新增 `carrier/`；
- 不把 `service/` 提升为 package 顶层 domain；
- 不大规模重排现有 transport 目录。

## 20. 实现顺序

开发按以下顺序推进：

### Phase 1 — Channel boundary

把公共 Channel 语义从：

```text
send(Frame) / onFrame(Frame)
```

修正为：

```text
write(bytes) / onData(bytes)
```

测试必须覆盖 split / coalesce、write serialization、close 与 backpressure。

### Phase 2 — Frame v1

实现：

```text
length-prefix codec
OPEN / DATA / WINDOW / FIN / RESET
logical stream state
per-stream credit
bounded queue
fair DATA scheduling
```

TypeScript 与 Rust 必须使用同一组 wire vectors 做交叉测试。

### Phase 3 — 两个证明型 Service

只实现：

```text
network.tcp
process.exec
```

先证明通用 byte transport 成立，不迁移 Worker RPC。

### Phase 4 — 迁移既有 Protocol

在 Frame/Service 已稳定后，再逐步迁移：

```text
Worker RPC
Control transport
Artifact bulk traffic
```

迁移过程中删除业务语义泄漏，而不是在新 Frame 上保留第二套 lane/mux。

### Phase 5 — 删除旧 transport 特例

当真实验收证明新路径覆盖旧功能后，再删除：

```text
WorkerRpcLaneChannel
RPC method based bulk routing
重复的业务级 stream / flow-control infrastructure
```

## 21. 必须先写的测试

实现前先固定协议测试。

### 21.1 Channel contract

- 任意拆分输入可以恢复完整 byte sequence；
- 任意合并输入不改变 byte sequence；
- concurrent write 不重排 bytes；
- write failure 关闭 Channel 并传播错误；
- WebSocket message boundary 不成为公共语义。

### 21.2 Frame codec

- TypeScript encode -> Rust decode；
- Rust encode -> TypeScript decode；
- partial header；
- partial payload；
- multiple frames in one chunk；
- malformed length；
- unsupported version；
- unknown type；
- frame size limit。

### 21.3 Multiplex

- 多 stream DATA 正确隔离；
- 同 stream byte order 保持；
- 一个 stream credit 耗尽不阻塞其它 stream；
- bounded send queue 会产生 backpressure；
- FIN half-close；
- RESET 只关闭目标 stream；
- Channel close 关闭全部 stream。

### 21.4 Flow control

- DATA 不得超过 sendCredit；
- WINDOW 只在 consumer consumption 后返还；
- WINDOW 不能 overflow；
- slow consumer 不导致 unlimited buffering；
- bulk stream 持续传输时 interactive stream 仍可前进。

### 21.5 Service

`network.tcp`：

- TCP echo；
- HTTP request/response；
- half-close；
- connect failure -> RESET；
- large bidirectional transfer。

`process.exec`：

- stdin/stdout echo；
- stdin FIN 后 stdout 继续读取；
- process spawn failure -> RESET；
- 使用真实 rsync server mode 做 end-to-end smoke。

## 22. 架构验收规则

代码审查时可以直接用以下规则判断设计是否走偏：

1. **Provider 只产生 Channel，不理解 Frame / Service / Protocol。**
2. **Channel 只搬运 bytes，不理解 Frame PDU。**
3. **Frame 只理解 multiplex、logical stream lifecycle 和 credit，不理解 DATA 业务。**
4. **Service 只负责 logical stream 与能力的绑定，不解析其上承载的 Protocol。**
5. **Protocol retry/replay 不得下沉为 Frame raw-byte replay。**
6. **一个 slow logical stream 不得阻塞整个 Channel。**
7. **Channel 断开后 Frame stream 不透明恢复。**
8. **新通信实现只进入 `transport` domain，不为分层图大规模重排现有目录。**

最终目标结构保持简单：

```text
Local / SSH / Docker / Podman / Reverse
                    │
                    ▼
                 Provider
                    │
                    ▼
                  Channel
                    │
                    ▼
       length-prefixed Frame protocol
          │         │         │
       stream 1  stream 2  stream 3
          │         │         │
          ▼         ▼         ▼
      network.tcp process.exec worker.rpc
          │         │         │
          ▼         ▼         ▼
       HTTP/TLS    rsync      RPC
```

网络可靠性归 Provider / Channel；多路逻辑流归 Frame；目标能力归 Service；业务含义归 Protocol。
