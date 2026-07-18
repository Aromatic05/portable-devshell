import assert from "node:assert/strict";
import test from "node:test";

import type { InstanceCreateDraft, JsonValue } from "@portable-devshell/shared";

import { TuiAppStore, TuiRuntimeOperations } from "../../src/testing.ts";

function createHarness(options: { failStart?: boolean } = {}) {
    const store = new TuiAppStore();
    store.replaceInstances([{
        defaultWorkspace: "/workspace/alpha",
        enabled: true,
        mcpEnabled: false,
        name: "alpha",
        provider: "local"
    }]);
    const calls: string[] = [];
    const refreshed: string[] = [];
    const clients = {
        artifact: {
            async cancelTransfer(transferId: string) {
                calls.push(`artifact.cancel:${transferId}`);
            },
            async revokeShare(shareId: string) {
                calls.push(`artifact.revoke:${shareId}`);
            }
        },
        config: {
            async apply() {
                calls.push("config.apply");
                return { applied: true };
            },
            async updateInstance(input: { instanceName: string }) {
                calls.push(`config.instance:${input.instanceName}`);
            },
            async updateMcp() {
                calls.push("config.mcp");
            },
            async validate() {
                calls.push("config.validate");
            }
        },
        instance: {
            async create(draft: InstanceCreateDraft) {
                calls.push(`instance.create:${draft.name}`);
                return { name: draft.name };
            },
            async createSchema() {
                return { providers: [] };
            },
            async delete(instance: string) {
                calls.push(`instance.delete:${instance}`);
            },
            async validateCreate() {
                calls.push("instance.validate");
                return {};
            }
        },
        mcp: {
            async decideApproval(approvalId: string, decision: string) {
                calls.push(`oauth.${decision}:${approvalId}`);
            }
        },
        reverse: {
            async createCode(instance: string) {
                calls.push(`reverse.code:${instance}`);
                return {
                    controllerUrl: "https://example.test",
                    deviceCode: "device-code",
                    expiresAt: "2026-07-17T00:00:00.000Z"
                };
            }
        },
        runtime: {
            async refresh(instance: string) {
                calls.push(`runtime.refresh:${instance}`);
                return { snapshot: { name: instance } };
            },
            async start(
                instance: string,
                input: {
                    relay?: {
                        onOutput(chunk: string): void;
                        onRequestId(requestId: string): void;
                    };
                }
            ) {
                calls.push(`runtime.start:${instance}`);
                input.relay?.onRequestId("request-start");
                input.relay?.onOutput("starting alpha\n");
                if (options.failStart) {
                    const error = new Error("start failed");
                    Object.assign(error, { code: "core.startFailed" });
                    throw error;
                }
                return { name: instance };
            },
            async stop(instance: string) {
                calls.push(`runtime.stop:${instance}`);
                return { name: instance };
            }
        },
        service: {
            async restart() {
                calls.push("service.restart");
            }
        },
        tool: {
            async call(instance: string, toolName: string, input: JsonValue) {
                calls.push(`tool.call:${instance}:${toolName}:${JSON.stringify(input)}`);
            },
            async decideApproval(instance: string, approvalId: string, decision: string) {
                calls.push(`approval.${decision}:${instance}:${approvalId}`);
            },
            async getApproval(instance: string, approvalId: string) {
                calls.push(`approval.get:${instance}:${approvalId}`);
                return {};
            }
        }
    } as never;
    const session = {
        async reconnect() {
            refreshed.push("reconnect");
        },
        async refresh() {
            refreshed.push("all");
        },
        async refreshArtifacts() {
            refreshed.push("artifacts");
        },
        async refreshAudit(instance: string) {
            refreshed.push(`audit:${instance}`);
        },
        async refreshConfig() {
            refreshed.push("config");
        },
        async refreshInstance(instance: string) {
            refreshed.push(`instance:${instance}`);
        },
        async refreshLogsForInstance(instance: string) {
            refreshed.push(`logs:${instance}`);
        },
        async refreshOAuth() {
            refreshed.push("oauth");
        },
        async refreshTodo(instance: string) {
            refreshed.push(`todo:${instance}`);
        }
    } as never;
    const operations = new TuiRuntimeOperations({
        clients,
        reconnectDelayMs: 0,
        session,
        store
    });
    return { calls, operations, refreshed, store };
}

test("runtime operations own instance command lifecycle and relay diagnostics", async () => {
    const harness = createHarness();

    await harness.operations.runInstanceAction("start", "alpha");

    assert.deepEqual(harness.calls, ["runtime.start:alpha"]);
    assert.deepEqual(harness.refreshed, ["instance:alpha"]);
    const command = harness.store.getState().commandRecords[0];
    assert.equal(command?.title, "Start Worker: alpha");
    assert.equal(command?.status, "succeeded");
    assert.equal(command?.targetInstance, "alpha");
    const relay = command === undefined
        ? undefined
        : harness.store.getState().relayByCommand[command.commandId];
    assert.deepEqual(relay?.output, ["starting alpha\n"]);
    assert.equal(relay?.provider, "local");
    assert.equal(relay?.workspace, "/workspace/alpha");
    assert.equal(relay?.requestId, "request-start");
    assert.match(
        harness.store.getState().interaction.screenStatusByPage.instances ?? "",
        /completed/u
    );
});

test("runtime operations preserve failed command diagnostics without throwing into the dispatcher", async () => {
    const harness = createHarness({ failStart: true });

    await harness.operations.runInstanceAction("start", "alpha");

    const command = harness.store.getState().commandRecords[0];
    assert.equal(command?.status, "failed");
    assert.equal(command?.error?.code, "core.startFailed");
    assert.equal(
        harness.store.getState().panelErrors["instances:alpha"]?.message,
        "start failed"
    );
    assert.deepEqual(harness.refreshed, []);
});

test("runtime operations expose control callbacks and route page refreshes", async () => {
    const harness = createHarness();
    const draft = {
        name: "remote-one",
        provider: "reverse"
    } as InstanceCreateDraft;

    const status = await harness.operations.createInstance(draft);
    assert.match(status ?? "", /devshell-worker enroll/u);
    await harness.operations.applyConfig();
    await harness.operations.restartControl();
    await harness.operations.decideApproval("alpha", "approval-1", "approve");
    assert.equal(
        await harness.operations.callTool(
            "alpha",
            "bash_run",
            '{"command":"pwd"}'
        ),
        true
    );
    await harness.operations.reloadPage("config", "alpha");
    await harness.operations.reloadPage("audit", "alpha");
    await harness.operations.reloadPage("logs", "alpha");
    await harness.operations.reloadPage("todo", "alpha");
    await harness.operations.reloadPage("oauth", "alpha");

    assert.equal(harness.calls.includes("instance.create:remote-one"), true);
    assert.equal(harness.calls.includes("reverse.code:remote-one"), true);
    assert.equal(harness.calls.includes("config.apply"), true);
    assert.equal(harness.calls.includes("service.restart"), true);
    assert.equal(harness.calls.includes("approval.approve:alpha:approval-1"), true);
    assert.equal(
        harness.calls.includes(
            'tool.call:alpha:bash_run:{"command":"pwd"}'
        ),
        true
    );
    assert.deepEqual(harness.refreshed, [
        "all",
        "all",
        "reconnect",
        "instance:alpha",
        "instance:alpha",
        "config",
        "audit:alpha",
        "logs:alpha",
        "todo:alpha",
        "oauth"
    ]);
});
