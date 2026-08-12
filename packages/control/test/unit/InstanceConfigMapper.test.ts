import assert from "node:assert/strict";
import test from "node:test";

import { InstanceFactory } from "../../src/testing.ts";

test("instance config mapper passes effective security mode, worker env, and approval policy into runtime config", () => {
    let capturedConfig: Record<string, unknown> | undefined;
    const mapper = new InstanceFactory({
        workerInstanceFactory: {
            create(config: unknown) {
                capturedConfig = config as Record<string, unknown>;
                return {
                    snapshot() {
                        return {
                            connectionState: "disconnected",
                            daemonState: "stopped",
                            effectiveSecurityMode: "workspace",
                            lastSeq: 0,
                            name: "demo-local",
                            ready: false,
                            status: "stopped"
                        };
                    }
                };
            }
        } as never
    });

    mapper.map({
        approvalPolicy: {
            mode: "ask",
            rules: [
                {
                    decision: "deny",
                    match: "exact",
                    source: "mcp",
                    toolName: "bash_run"
                }
            ]
        },
        enabled: true,
        env: {
            DEMO: "1"
        },
        logs: {
            eventBufferSize: 250,
            maxBytes: 33_554_432,
            retentionDays: 14
        },
        mcp: { auth: { mode: "none" }, enabled: true, path: "/demo-local/mcp", tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] } },
        name: "demo-local",
        provider: "local",
        security: {
            mode: "workspace"
        },
    });

    assert.equal(capturedConfig?.effectiveSecurityMode, "workspace");
    assert.equal(capturedConfig?.eventBufferSize, 250);
    assert.deepEqual(capturedConfig?.auditStorage, {
        maxBytes: 33_554_432,
        retentionDays: 14
    });
    assert.deepEqual(capturedConfig?.approvalPolicy, {
        mode: "ask",
        rules: [
            {
                decision: "deny",
                match: "exact",
                source: "mcp",
                toolName: "bash_run"
            }
        ]
    });
    assert.deepEqual(capturedConfig?.env, {
        DEMO: "1",
        DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: "workspace",
        DEVSHELL_WORKER_SECURITY_MODE: "workspace"
    });
});

test("controller-managed terminals use the instance Worker RPC surface", async () => {
    const calls: string[] = [];
    const worker = {
        async openTerminal() {
            calls.push("terminal.open");
            return {
                cols: 80,
                createdAtMs: 1,
                generation: 1,
                latestSeq: 0,
                rows: 24,
                state: "running",
                terminalId: "worker-terminal",
                version: 1,
            };
        },
        async attachTerminal() {
            calls.push("terminal.attach");
            return {
                replay: [],
                session: {
                    cols: 80,
                    createdAtMs: 1,
                    generation: 1,
                    latestSeq: 0,
                    rows: 24,
                    state: "running",
                    terminalId: "worker-terminal",
                    version: 1,
                },
            };
        },
        onTerminalNotification() { return () => undefined; },
        onRpcConnected() { return () => undefined; },
        onRpcDisconnected() { return () => undefined; },
        snapshot() {
            return {
                connectionState: "disconnected",
                daemonState: "stopped",
                lastSeq: 0,
                name: "demo-local",
                ready: false,
                status: "stopped",
            };
        },
    };
    const mapper = new InstanceFactory({
        workerInstanceFactory: { create: () => worker } as never,
    });
    const descriptor = mapper.map({
        enabled: true,
        mcp: { auth: { mode: "none" }, enabled: false, path: "/demo-local/mcp", tools: { capabilities: [], groups: [] } },
        name: "demo-local",
        provider: "local",
        security: { mode: "workspace" },
    });

    const opened = await descriptor.terminal!.open({ cols: 80, rows: 24, workspace: "/workspace" });
    ("process" in opened ? opened.process : opened).dispose?.();

    assert.deepEqual(calls, ["terminal.open", "terminal.attach"]);
});
