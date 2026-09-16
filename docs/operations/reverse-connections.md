# 反向 Worker 连接协议

版本：1

Reverse 定义的是 Worker 主动连接 Control 的 **Provider / Channel** 行为。连接建立后，应用层统一使用 [Transport Frame v1](../development/transport-protocol.md)：一条 Reverse Channel 上 multiplex `worker.rpc`、Artifact、TCP、process 等 Service，不存在第二套 Reverse RPC wire protocol。

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
                                   Frame v1
```

WSS 与 SSE+POST 只是不同 Carrier 实现；向 Frame 层提供相同的可靠、有序 Channel byte service。底层 message / SSE event boundary 不属于 Frame wire contract。

## 身份模型

- 一个 worker daemon 对应一个 instance；
- 一个 reverse instance 对应一份设备凭据，不持久化默认 workspace；
- device code 有较短有效期，只能消费一次；
- device token 是随机 bearer credential，Control 只保存其 SHA-256；
- device token 不接受 URL query string 传递；
- token 可以轮换或撤销；
- 每次活动 Reverse Channel 使用单调递增的 positive generation。

## 生命周期

reverse instance 是 `selfManaged`。worker 仍通过既有 `start`、`stop`、`status` 管理自己的 daemon 生命周期。注册完成后由目标机器启动 daemon；workspace 由后续请求显式提供。

```text
devshell-worker start --instance <name>
```

Control 不对 `selfManaged` instance 执行 `start` 或 `stop`。需要停机、重启或应用要求 worker rebuild 的配置时，由目标机器管理 worker 生命周期。

Reverse 状态与 daemon 状态分开：

```text
enrollment    pending | enrolled | revoked
availability  offline | online
transport     wss | sse
generation    当前活动 Channel 的单调递增正整数
```

## 注册流程

1. `control.createReverseDeviceCode(instance)` 创建单次 device code；
2. worker 向 `POST /reverse/v1/enroll` 提交 code 和平台元数据；
3. Control 原子消费 code，返回 instance、controller URL 和新 device token；
4. worker 以 `0600` 权限把实例配置和凭据写入 `~/.devshell/<instance>/`；
5. worker 把当前二进制安装到 `~/.devshell/workers/<target>/<sha256>/`，更新 `~/.devshell/bin/devshell-worker`，再启动 daemon；
6. 重复使用、过期或已消费的 code 必须失败。

CLI 流程：

```text
devshell instance create
provider: reverse

devshell instance device-code <instance>
devshell instance rotate-token <instance>
devshell instance revoke-token <instance>

devshell-worker enroll --controller <publicBaseUrl> --device-code <code>
```

注册的最后一步仍调用已有 `start --instance`，由 worker 负责 runtime socket、pid、日志、状态和停止流程。

## Generation

worker 每次建立新的 Reverse Channel 前分配更高 generation。generation 持久化在 instance `state/reverse-generation`，并取 configured value、已持久化 value 与当前时间的单调上界，因此 daemon 重启或时钟回退不会回用旧 generation。

Control 只接受高于当前已知 generation 的连接。新的 generation 成功激活后原子替换旧 Channel；旧 Channel 被关闭。token 轮换、撤销或重新注册成功后，旧活动 Channel 也立即失效。

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
Sec-WebSocket-Protocol: devshell-worker-transport.v1
```

没有 `control` / `bulk` lane header，也不按 RPC method 选择物理连接。

WebSocket binary message 承载 Channel bytes；text message 被拒绝。当前 writer 通常一次 `Channel.write()` 产生一个 binary message，但 Frame decoder 不依赖 WebSocket message boundary。

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

使用同样的 Authorization、instance 与 generation header。SSE event：

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

## Frame 与 Service

Reverse Channel 建立后直接承载 Frame v1：

```text
Reverse Channel
      │
      ▼
Frame OPEN / DATA / WINDOW / FIN / RESET
      │
      ├─ worker.rpc
      ├─ network.tcp
      ├─ process.exec
      ├─ artifact.payload
      └─ artifact.receive
```

Worker Reverse connector 在 Service 边界只保留一个特殊路径：`worker.rpc` 接入 `ReverseRpcPayload`，因为 RPC 自己拥有跨 generation request replay / dedupe。其它 Service Frame 原样桥接到 daemon `transport` endpoint，由和 controller-managed Worker 相同的 Service dispatcher 处理。

因此 Reverse 不拥有第二套 Artifact/TCP/process 实现。

## 断线与恢复

Channel 断开时，当前 generation 的所有 Frame logical stream 立即失败。Frame 不 replay DATA，也不恢复 streamId。

普通 Service：

```text
network.tcp
process.exec
artifact.payload
artifact.receive
```

断线后由调用者决定是否重新执行操作。

`worker.rpc` 的恢复语义不同，因为它属于 RPC Protocol：Control 的 `WorkerRpcBridge` 保留未完成 request；更高 generation 建立后，通过新的 `worker.rpc` stream 以原 request ID 重放。worker 端 `ReverseRpcPayload` 维护 in-flight request 集合和有界 completed-result cache：

- 活动期间相同 request frame 合并；
- 已成功完成的相同 request 直接返回缓存响应；
- cache key 包含 request ID 与完整请求 digest；
- failed mutation 不进入成功 cache，因此可以重新尝试；
- `tool.call.cancel` 仍可在长工具执行期间被并发处理。

这提供的是 **Worker RPC request 级** replay / dedupe，不是 Reverse/Frame raw-byte exactly-once。

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
Worker RPC completed-result cache     1024 条
```

这些是当前实现默认值，不属于 Frame wire-level 兼容性要求。

## Provider 路由与 Proxy

Reverse 自己的出站路径属于 Provider 层，不复用 `network.tcp` Service。

当前实现能力：

```text
WSS
    tungstenite 直接建立 TCP/TLS/WebSocket
    不读取 DevShell-specific proxy config

SSE / HTTPS POST
    reqwest 默认读取 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY
    当前构建未启用 reqwest socks feature
```

因此：

- OS routing、Tailscale、WireGuard、透明代理等对两种 carrier 都透明；
- HTTP(S) proxy 环境变量可以作用于 SSE/POST fallback；
- 当前 WSS 不通过这些 proxy 环境变量建立 CONNECT tunnel；
- `socks5://` proxy URL 不是当前 Reverse Provider 的受支持能力；
- 当前没有持久化 `reverse.proxy` 配置字段。

如果未来需要显式 Reverse SOCKS / HTTP proxy，应在 Reverse Provider 的 Channel 建立逻辑中统一实现 WSS 与 SSE/POST routing；不能把 proxy 信息塞进 Frame OPEN 或 `network.tcp` metadata。

## 验收要求

Reverse integration 必须至少覆盖：

- WSS 鉴权与更高 generation 原子替换；
- SSE+POST fallback 和 upstream sequence dedupe；
- real Rust reverse worker tool call；
- Control restart 后 RPC/terminal 恢复；
- sibling Service 与 `worker.rpc` 共用一个 Channel；
- `network.tcp` 上真实 HTTP request/response；
- `process.exec` stdin/stdout；
- Artifact raw data plane；
- re-enroll 复用持久 credential；
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
