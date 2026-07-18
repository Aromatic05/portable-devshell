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
        mcp: { enabled: true, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact"] } },
        name: "demo-local",
        provider: "local",
        security: {
            mode: "workspace"
        },
        workspace: "/tmp/demo"
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
