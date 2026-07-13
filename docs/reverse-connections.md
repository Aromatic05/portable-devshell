# Reverse worker connection protocol

Version: 1

## Topology

A reverse instance is created by the control server before enrollment. The control server issues a short-lived, single-use device code for that instance. The target machine runs `devshell-worker enroll`, exchanges the device code for an instance-scoped device token, stores the credential under `~/.devshell/<instance>/`, installs the worker using the existing user-level layout, and starts the worker daemon.

The daemon owns the outbound connection for its whole lifetime. It prefers WSS and falls back to SSE downstream plus HTTPS POST upstream. Both transports carry the existing four-byte big-endian length-prefixed JSON RPC frame. No second RPC protocol is introduced.

## Identity

- One worker daemon maps to one instance.
- One instance maps to one workspace and one device credential.
- Device codes are short-lived and can be consumed once.
- Device tokens are random bearer credentials. The controller stores only a SHA-256 hash.
- Device tokens are never accepted in URL query strings.
- A token can be rotated or revoked.

## Lifecycle

Reverse instances are `selfManaged`. The worker manages its own daemon lifecycle through the existing `start`, `stop`, `status`, and `rpc` commands. Enrollment invokes the installed worker's `start --instance <name>` command in the configured workspace, and `start` daemonizes the worker itself. The controller cannot start an offline reverse worker. While online, the controller may request a graceful shutdown, but a subsequent start must run on the remote machine.

The instance exposes reverse state separately from the existing daemon and RPC axes:

- enrollment: `pending | enrolled | revoked`
- availability: `offline | online`
- transport: `wss | sse` when online
- generation: monotonically increasing positive integer for the active logical connection

## Enrollment

1. `control.createReverseDeviceCode(instance)` creates a single-use code.
2. The worker sends `POST /reverse/v1/enroll` with the code and platform metadata.
3. The controller atomically consumes the code and returns the instance name, workspace, controller URL, and a new device token.
4. The worker writes the instance configuration and credential using mode `0600` under `~/.devshell/<instance>/`.
5. The worker installs the current binary into the existing `~/.devshell/workers/<target>/<sha256>/` layout, updates `~/.devshell/bin/devshell-worker`, and invokes `devshell-worker start --instance <instance>` in the enrolled workspace.
6. Reusing an expired or consumed code fails.

CLI flow:

```text
devshell instance create
# choose provider: reverse
# CLI prints the generated device code and exact enrollment command

devshell instance device-code <instance>
devshell instance rotate-token <instance>
devshell instance revoke-token <instance>

devshell-worker enroll --controller <publicBaseUrl> --device-code <code>
```

Enrollment finishes by invoking the installed worker's existing `start --instance <instance>` command. That command performs daemonization and owns the runtime socket, pid, logs, status, and shutdown lifecycle.

## WSS transport

Endpoint: `GET /reverse/v1/connect`

Required headers:

- `Authorization: Bearer <device token>`
- `X-Devshell-Instance: <instance name>`
- `X-Devshell-Generation: <positive integer>`
- `Sec-WebSocket-Protocol: devshell-worker-rpc.v1`

Each binary WebSocket message contains exactly one complete existing length-prefixed RPC frame. Text messages are rejected. A newly authenticated higher generation atomically replaces the old active connection. Frames from a retired generation are ignored and its connection is closed.

## SSE + POST fallback

Downstream endpoint: `GET /reverse/v1/events`

Required headers are the same instance, generation, and authorization headers. A client may send `Last-Event-ID` or `X-Devshell-Downstream-Ack` to continue downstream sequence numbering for that channel. Reconnection normally creates a higher generation, and pending RPC requests are replayed by request ID rather than by replaying raw SSE events.

SSE event format:

```text
id: <downstream sequence>
event: frame
data: <base64 of one complete length-prefixed RPC frame>
```

Upstream endpoint: `POST /reverse/v1/frames`

Body:

```json
{
  "generation": 4,
  "frames": [
    { "seq": 18, "frame": "<base64>" }
  ]
}
```

The response returns the highest contiguous upstream sequence accepted. Duplicate sequence numbers are acknowledged without being delivered twice. Frames from a non-active generation are rejected. The gateway accepts a batch; the current worker uploads one response frame per POST.

SSE responses disable transformation and proxy buffering and send comment heartbeats. The worker switches transports through a new generation; WSS and SSE are never simultaneously active for the same generation.

## Reconnect and request replay

The controller preserves pending reverse RPC requests across transport loss. After a higher generation attaches, pending requests are replayed with their original RPC request IDs. The worker daemon serializes reverse request dispatch and keeps a bounded cache of completed request results keyed by request ID plus the complete request digest. An identical replay returns the cached response instead of executing the operation again.

The active generation is persisted under the instance `state/` directory before connecting. It remains monotonic across daemon restarts and clock rollback. A token rotation, revocation, or successful re-enrollment immediately closes the old active channel.

This provides at-most-once execution for identical replayed requests and allows safe recovery after a response is lost.

## Default operational parameters

- device code lifetime: 10 minutes
- WSS heartbeat: 20 seconds
- idle connection considered dead after: 60 seconds without traffic or pong when no RPC request is pending
- WSS failure threshold before SSE fallback: 3 consecutive failures
- reconnect backoff: exponential from 1 second to 30 seconds
- SSE comment heartbeat: 15 seconds
- HTTPS POST timeout: 30 seconds
- maximum enrollment/upstream JSON body: 1 MiB
- worker completed request-result cache: 1024 entries

These are implementation defaults, not wire-level compatibility requirements.

## Error codes

- `reverse.instanceNotReverse`
- `reverse.deviceCodeExpired`
- `reverse.deviceCodeInvalid`
- `reverse.deviceCodeConsumed`
- `reverse.deviceTokenInvalid`
- `reverse.deviceTokenRevoked`
- `reverse.connectionSuperseded`
- `reverse.generationInvalid`
- `reverse.frameInvalid`
- `reverse.transportUnavailable`
- `reverse.selfManagedOffline`
