# 反向 Worker 连接协议

实现审计基线提交：`2287310a`（beta.1）。Frame wire v1；Reverse WSS 支持 Carrier v1/v2，当前优先协商 v2。

Reverse 定义的是 Worker 主动连接 Control 的 **Carrier / Channel** 行为。连接建立后，统一使用 [Transport 协议](../development/transport-protocol.md)：Channel → Frame v1 的单一 `envelope` Service → 带 source/destination 地址的 Protobuf Envelope → Rpc/Event/Stream Packet。RPC、Artifact、TCP 和 process 在 port / Packet 层复用，不存在第二套 Reverse RPC wire protocol。

## 拓扑

reverse instance 必须先由 Control 创建。Control 为该 instance 签发短期、单次使用的 device code。目标机器运行 `devshell-worker enroll`，用 device code 换取 instance 专属 device token，将凭据保存到 `~/.devshell/<instance>/`，安装当前 worker，并启动 worker daemon。

worker daemon 在整个生命周期内持有出站连接：

```text
Worker daemon
    │
    ├─ preferred ── WSS ───────────────┐
    │                                  │
    └─ fallback ─── SSE + HTTPS POST ──┤
                                       ▼
                                 Channel bytes
                                       │
                                       ▼
                          Frame v1：一个 envelope stream
                                       │
                                       ▼
                          Envelope → Port → Packet
```

WSS 与 SSE+POST 只是不同 Carrier 实现；向 Frame 层提供相同的可靠、有序 Channel byte service。底层 message / SSE event boundary 不属于 Frame wire contract。

## 身份模型

- 一个 worker daemon 对应一个 instance；
- 一个 reverse instance 对应一份设备凭据，不持久化默认 workspace；
- device code 有较短有效期，只能消费一次；
- device token 是随机 bearer credential，Control 只保存其 SHA-256；
- device token 不接受 URL query string 传递；
- token 可以轮换或撤销；
- Worker 正常重连分配更高 positive generation；凭据替换存在下文所述的 admission 例外。

## 生命周期

reverse instance 是 `selfManaged`。worker 仍通过既有 `start`、`stop`、`status` 管理自己的 daemon 生命周期。注册完成后由目标机器启动 daemon；workspace 由后续请求显式提供。

```text
devshell-worker start --instance <name>
```

Control 不对 `selfManaged` instance 执行 `start` 或 `stop`。需要停机、重启或应用要求 worker rebuild 的配置时，由目标机器管理 worker 生命周期。

永久清理远端本地实例时，由目标机器 owner 依次执行：

```text
devshell-worker stop --instance <name>
devshell-worker retire --instance <name>
```

`retire` 要求 daemon 已停止；它退役 tmux runtime，并删除配置、Artifact 和日志。普通 stop 不等于 retire；删除 Control 上的 Reverse 注册也不会代替这些远端清理步骤。

Reverse 状态与 daemon 状态分开：

```text
enrollment    pending | enrolled | revoked
availability  offline | online
transport     wss | sse
generation    当前活动 Channel 的正整数（普通重连递增）
```

## 注册流程

1. CLI 请求 Control 的 `@control / connection / createCode`，消息为 `{ "instance": "<name>" }`，取得单次 device code；
2. Worker 向 `POST /reverse/v1/enroll` 提交 code 和平台元数据；
3. Control 原子消费 code，返回 instance、controller URL 和新 device token；重复使用、过期或已消费的 code 失败；
4. Worker 先准备当前二进制，安装到 `~/.devshell/workers/<target>/<sha256>/` 并更新 `~/.devshell/bin/devshell-worker`；
5. Worker 停止已有 daemon，退役该 instance 的 tmux runtime，再保留原用户配置并更新 Reverse 凭据，以 `0600` 写入配置，启动 daemon。

**重新注册会终止已有持久 pane/task runtime**，不同于普通 Worker restart 的接续流程。用户配置、日志和 Artifact 按实现保留；本地安装失败会尝试恢复旧配置与先前运行状态，但不能据此承诺已经退役的 pane/task 恢复。

CLI 流程：

```text
devshell instance create
provider: reverse

devshell instance device-code <instance>
devshell instance rotate-token <instance>
devshell instance revoke-token <instance>

devshell-worker enroll --controller <publicBaseUrl> --device-code <code>

optional: 让 enrollment 和后续 Reverse transport 都走显式 proxy
devshell-worker enroll --controller <publicBaseUrl> --device-code <code> \
  --proxy socks5h://127.0.0.1:1080
```

`--proxy` 会持久化为 worker `config.toml` 的 `[reverse].proxyUrl`。注册的最后一步仍调用已有 `start --instance`，由 worker 负责 runtime socket、pid、日志、状态和停止流程。

## Generation

worker 每次建立新的 Reverse Channel 前分配更高 generation。generation 持久化在 instance `state/reverse-generation`，并取 configured value、已持久化 value 与当前时间的单调上界，因此 daemon 重启或时钟回退不会回用旧 generation。

普通候选的 generation 必须高于当前**活动**连接；这不是 Control 持久化的历史最大值。经过认证的 credential replacement 可以绕过此比较。候选通过应用握手及 peer promotion 后才替换活动 Channel，随后关闭旧 Channel。

重新注册签发新 token 时，Control 暂时保留前一个 token，直到替代凭据成功激活才提交切换；不能把 code 消费成功写成旧连接立即失效。显式 token 轮换或撤销则会立即断开旧连接。预期候选失败应保留前驱可用性，当前 WSS watermark 偏差见下文。

generation 只标识物理 Reverse Channel 生命周期，不是 Frame stream sequence，也不提供 logical stream resume。

## WSS 传输

endpoint：

```text
GET /reverse/v1/connect
```

必需 header：

```text
Authorization: Bearer <device token>
X-Devshell-Instance: <instance name>
X-Devshell-Generation: <positive integer>
Sec-WebSocket-Protocol: devshell-worker-transport.v1, devshell-worker-transport.v2
```

没有 `control` / `bulk` lane header，也不按 RPC method 选择物理连接。

Worker 提供两个 subprotocol；Control 优先选择 `devshell-worker-transport.v2`。v2 的 Worker→Control binary record 为：

```text
"DSR2" (4 bytes) | session UUID (16 raw bytes) | seq (u64 big-endian) | Frame bytes
```

Control→Worker binary message 继续携带 Channel bytes，不添加这个 record header。v2 还包含 Control→Worker text 控制消息：

```text
DSR2:ready
DSR2:<session 的 32 位十六进制表示>:<seq 的十进制表示>
```

`ready` 在应用 activation 及凭据提交之后发送；HTTP 101 本身不表示可用。ACK 确认当前 session 已接受的连续 Worker→Control record；相同 session 的旧 seq 只确认、不重复投递，gap 被拒绝，新 session 必须从 1 开始。Worker 保留有界未确认队列，只有有效 ACK 才移除记录；ACK 不是 RPC 完成确认。

协商 v1 时 binary message 直接承载 Channel bytes，text 被拒绝；Worker 收到有效远端 Frame 后才标记 connected。两种 Carrier 模式都使用 Frame v1。Frame decoder 不依赖 WebSocket message boundary。

Frame role 固定为：

```text
Control = opener
Worker  = acceptor
```

这与 WSS 的 TCP/WebSocket 建连方向相反也没有冲突：Provider 建连方向与 Frame OPEN 权限是两件事。

## SSE + POST 回退

连续 WSS 建连失败达到阈值后，worker 使用 SSE 下行 + HTTPS POST 上行提供同一 Channel。

下行 endpoint：

```text
GET /reverse/v1/events
```

使用同样的 Authorization、instance 与 generation header（不发送 WebSocket subprotocol header）。SSE event：

```text
id: <downstream sequence>
event: frame
data: <Channel bytes 的 base64>
```

客户端可发送 `Last-Event-ID` 或 `X-Devshell-Downstream-Ack` 表示已看到的下行 sequence。该 sequence 只用于 SSE carrier delivery，不是 Frame sequence，也不能恢复 logical stream。

上行 endpoint：

```text
POST /reverse/v1/frames
```

请求体：

```json
{
    "generation": 4,
    "frames": [{ "seq": 18, "frame": "<base64 Channel bytes>" }]
}
```

响应返回已经接受的最高连续上行 sequence。重复 sequence 只确认，不重复投递；sequence gap 或非活动 generation 被拒绝。gateway 支持 batch，当前 worker uploader 每次发送一个 Channel chunk。

SSE 响应禁用代理转换/缓冲，并每 15 秒发送 comment heartbeat。worker 的 SSE HTTP client 使用 45 秒 read timeout，因此 heartbeat 同时保持长连接活跃。

同一 generation 只有一个活动 Reverse Channel；worker 不同时保持 WSS 与 SSE 两套逻辑连接。

## Frame、Envelope 与 daemon 桥接

```text
Reverse WSS / SSE+POST Channel
      │
      ▼
Frame：OPEN(envelope) / DATA / WINDOW / FIN / RESET
      │
      ▼
Protobuf Envelope：source(host, port) / dest(host, port) / packet
      │
      ▼
Rpc / Event / Stream
      ├─ core、tool、terminal RPC
      ├─ artifact：payload.read / receive.write Stream
      ├─ network：tcp Stream
      └─ process：exec Stream
```

Reverse connector 将整条字节连接桥接到 daemon transport endpoint，使用与受管 Worker 相同的 Endpoint dispatcher；RPC 没有独立特殊桥接路径，也不另外实现 Artifact/TCP/process。

## 断线、恢复与已知偏差

连接断开后，现有 Packet Stream 失败；Frame 不 replay DATA、不恢复 streamId。下一条连接创建新的 Frame/Envelope stream、WSS session 和序号，ReverseBridge 清理旧 pending/inflight Frame。SSE sequence 或 DSR2 ACK 的去重都不能解释成跨 generation 的业务执行 exactly-once。

未收到回复的 RPC 可能已经执行成功。当前 TS Rpc 返回 `rpc.resultUncertain`，`retryable: false`；未完成请求不会在新 generation 上无条件重放。调用者应先检查任务或业务状态，再决定是否发起新操作。持久 terminal 的业务 replay/cursor 与重连后重新 attach 是独立契约，不代表旧 transport Stream 恢复。

预期安全契约：验证失败或超时的候选应留下仍可工作的前驱，只有成功 promotion 才退休旧链路。

**KNOWN 未解决偏差（beta.1）**：`ReverseIngress.#acceptedWss` 按 descriptor 保存 reliable session/generation watermark，并在候选应用握手完成前更新；候选失败未回滚此 watermark。有效的更高 generation 候选先发送被接受的 reliable record、再拒绝握手时，旧连接可能仍显示 ready，但下一次 RPC reply 会被 `Stale reverse generation frame.` 拒绝，并产生 `rpc.resultUncertain`。不能把“保留前驱对象”描述成已经保证前驱 RPC 可用。

可追踪复现入口为 [ReverseCandidateFailurePoisonsPreviousRound6.test.ts](../../test/known-bugs/ReverseCandidateFailurePoisonsPreviousRound6.test.ts)，配套 `ReverseNetworkRound6Fixture.ts`。无 MemorySocketBoundary 时测试会使用 localhost TCP；受限 sandbox 可能因 EPERM 无法创建监听。本次文档修订只核对源码，未重新运行该红测。此偏差不是目标行为。

## 当前默认参数

```text
device code 有效期                    10 分钟
SSE/POST HTTP connect timeout         15 秒
切换到 SSE 前的连续 WSS 失败阈值       3 次
WSS 重连退避                          1 秒指数增长到 30 秒
SSE fallback retry                    5 秒
SSE read timeout                      45 秒
SSE comment heartbeat                 15 秒
HTTPS POST timeout                    30 秒
注册/上行 JSON body 上限              1 MiB
WSS 未确认出站 Frame 队列上限          64 条
Control 候选 activation timeout        20 秒
```

这些是当前实现默认值，不属于 Frame wire-level 兼容性要求。

## Carrier 路由与 Proxy

Reverse 自己的出站路径属于 Carrier 层，不复用 `network / tcp` Packet Stream。

显式 `proxyUrl` 当前支持匿名：

```text
http://proxy:port
socks5://proxy:port
socks5h://proxy:port
```

不支持：

```text
https:// proxy
proxy URL userinfo / proxy authentication
```

同一个 `proxyUrl` 同时作用于 enrollment、WSS 与 SSE/POST：

```text
enrollment / SSE / HTTPS POST
    reqwest Proxy::all(proxyUrl)

WSS
    proxy TCP connect
      -> HTTP CONNECT 或 SOCKS5 CONNECT
      -> raw tunnel
      -> tungstenite client_tls(original wss URL)
      -> WebSocket / Frame
```

`socks5://` 在 Worker 本地解析目标 DNS，再把 IP 交给 proxy；`socks5h://` 把域名交给 proxy 解析。HTTP proxy 的 WSS 路径使用 CONNECT tunnel，因此原 controller hostname 仍由后续 TLS/WebSocket handshake 使用。

未配置 `proxyUrl` 时：

```text
WSS
    继续直接建立 TCP/TLS/WebSocket

enrollment / SSE / HTTPS POST
    reqwest 默认读取 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY
```

reqwest 已启用 `socks` feature，所以这些环境变量也可以使用 SOCKS URL；但显式 `proxyUrl` 是 Reverse Carrier 自己的稳定配置入口，并会覆盖 reqwest 的 system proxy 自动发现。

其它路由规则保持不变：

- OS routing、Tailscale、WireGuard、透明代理等对两种 carrier 都透明；
- `proxyUrl` 只控制 Reverse Carrier 如何建立 Channel；
- proxy 信息不进入 Frame OPEN，也不进入 `network / tcp` open message；
- 若未来增加 proxy authentication 或 HTTPS proxy，应继续扩展 Reverse Carrier，而不是引入新的 Frame / Packet route 语义。

## 验收要求

以下是验收要求，不表示本次修订已运行或全部通过；尤其候选失败保留前驱的要求目前有上述 KNOWN red regression：

- WSS 鉴权与更高 generation 原子替换；
- real Reverse WebSocket 经显式 HTTP CONNECT `proxyUrl` 建立后继续完成完整 Frame/Envelope/Packet 流程；WSS 使用同一预连接 tunnel + `client_tls()` 路径；
- SSE+POST fallback 和 upstream sequence dedupe；
- real Rust reverse worker tool call；
- Control restart 后新 RPC 可用、旧 RPC uncertain 与 terminal 重新 attach；
- RPC 与多个 Packet Stream 共用一个 Channel；
- `network / tcp` 上真实 HTTP request/response；
- `process / exec` stdin/stdout；
- Artifact raw data plane；
- re-enroll 凭据 promotion、失败保留前驱实际 RPC 可用性及 tmux runtime 退役；
- worker 退出后 instance 回到 offline。

## 错误码

```text
reverse.instanceNotReverse
reverse.deviceCodeExpired
reverse.deviceCodeInvalid
reverse.deviceCodeConsumed
reverse.deviceTokenInvalid
reverse.deviceTokenRevoked
reverse.connectionSuperseded
reverse.generationInvalid
reverse.frameInvalid
reverse.transportUnavailable
reverse.selfManagedLifecycle
reverse.selfManagedOffline
```
