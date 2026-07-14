# 反向 Worker 连接协议

版本：1

## 拓扑

reverse instance 必须先由 control 创建。control 为该 instance 签发一个短期、单次使用的 device code。目标机器运行 `devshell-worker enroll`，用 device code 换取 instance 专属 device token，将凭据保存到 `~/.devshell/<instance>/`，按照现有用户级目录安装 worker，并启动 worker daemon。

worker daemon 在整个生命周期内持有出站连接。首选 WSS，失败后回退到 SSE 下行加 HTTPS POST 上行。两种 transport 都承载现有的四字节大端长度前缀 JSON RPC frame，不引入第二套 RPC 协议。

## 身份模型

- 一个 worker daemon 对应一个 instance；
- 一个 instance 对应一个 workspace 和一份设备凭据；
- device code 有较短有效期，只能消费一次；
- device token 是随机 bearer credential，control 只保存其 SHA-256；
- device token 不接受 URL query string 传递；
- token 可以轮换或撤销。

## 生命周期

reverse instance 是 `selfManaged`。worker 仍通过既有 `start`、`stop`、`status` 和 `rpc` 命令管理自己的 daemon 生命周期。注册完成后，安装好的 worker 在配置 workspace 中执行：

```text
devshell-worker start --instance <name>
```

`start` 由 worker 自行 daemonize。control 无法启动一台离线 reverse worker；在线时可以请求优雅停止，但再次启动必须在目标机器上发生。

reverse 状态与原有 daemon/RPC 状态轴分开：

```text
enrollment    pending | enrolled | revoked
availability  offline | online
transport     wss | sse
 generation   当前逻辑连接的单调递增正整数
```

## 注册流程

1. `control.createReverseDeviceCode(instance)` 创建单次 device code；
2. worker 向 `POST /reverse/v1/enroll` 提交 code 和平台元数据；
3. control 原子消费 code，返回 instance 名、workspace、controller URL 和新 device token；
4. worker 以 `0600` 权限把实例配置和凭据写入 `~/.devshell/<instance>/`；
5. worker 把当前二进制安装到 `~/.devshell/workers/<target>/<sha256>/`，更新 `~/.devshell/bin/devshell-worker`，再启动 daemon；
6. 重复使用、已经过期或已消费的 code 必须失败。

CLI 流程：

```text
devshell instance create
# provider 选择 reverse
# CLI 输出 device code 和完整注册命令

devshell instance device-code <instance>
devshell instance rotate-token <instance>
devshell instance revoke-token <instance>

devshell-worker enroll --controller <publicBaseUrl> --device-code <code>
```

注册的最后一步仍调用已有 `start --instance`，由 worker 负责 runtime socket、pid、日志、状态和停止流程。

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
Sec-WebSocket-Protocol: devshell-worker-rpc.v1
```

每个二进制 WebSocket message 恰好包含一个完整的现有长度前缀 RPC frame。文本 message 被拒绝。

经过认证、generation 更高的新连接会原子替换旧连接。来自已退役 generation 的 frame 被忽略，并关闭对应连接。

## SSE + POST 回退传输

下行 endpoint：

```text
GET /reverse/v1/events
```

使用与 WSS 相同的 instance、generation 和 authorization header。客户端可发送 `Last-Event-ID` 或 `X-Devshell-Downstream-Ack`，继续该 channel 的下行 sequence。重连通常创建更高 generation；未完成 RPC 按 request ID 重放，而不是重放原始 SSE event。

SSE event：

```text
id: <downstream sequence>
event: frame
data: <一个完整长度前缀 RPC frame 的 base64>
```

上行 endpoint：

```text
POST /reverse/v1/frames
```

请求体：

```json
{
    "generation": 4,
    "frames": [{ "seq": 18, "frame": "<base64>" }]
}
```

响应返回已经接受的最高连续上行 sequence。重复 sequence 只确认，不重复投递；非活动 generation 的 frame 被拒绝。gateway 接受批量 frame，当前 worker 实现每次 POST 上传一个响应 frame。

SSE 响应禁用转换和代理缓冲，并发送 comment heartbeat。worker 通过新 generation 切换 transport；同一 generation 不会同时保持 WSS 和 SSE 活动。

## 重连与请求重放

control 在 transport 断开后保留未完成的 reverse RPC。更高 generation 接入后，以原始 RPC request ID 重放请求。

worker daemon 并发执行 reverse 工具请求，并由接收循环继续处理控制请求，因此 `tool.call.cancel` 不会被长工具阻塞。WSS 周期性冲刷异步响应；SSE 使用独立 HTTPS POST 上行线程。worker 同时维护活动请求集合和有界的已完成结果缓存：活动期间的相同 frame 会合并，完成后的相同 frame 直接返回缓存响应，不再次执行操作。缓存 key 包含 request ID 和完整请求 digest。

活动 generation 在连接前持久化到 instance 的 `state/` 目录，即使 daemon 重启或时钟回退也保持单调递增。token 轮换、撤销或重新注册成功后，旧活动 channel 立即关闭。

该模型为内容完全相同的重放请求提供至多一次执行语义，并允许响应丢失后的安全恢复。

## 默认运行参数

```text
device code 有效期                    10 分钟
WSS heartbeat                         20 秒
空闲连接死亡判定                      无流量或 pong 60 秒，且没有未完成 RPC
切换到 SSE 前的连续 WSS 失败阈值       3 次
重连退避                              1 秒指数增长到 30 秒
SSE comment heartbeat                 15 秒
HTTPS POST timeout                    30 秒
注册/上行 JSON body 上限              1 MiB
worker 已完成请求结果缓存             1024 条
```

这些是实现默认值，不属于 wire-level 兼容性要求。

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
reverse.selfManagedOffline
```
