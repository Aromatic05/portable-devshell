import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName, type JsonValue } from "@portable-devshell/shared";

import { TuiAppStore, TuiControlSessionRefresh, TuiControlSessionSubscriptions } from "../../dist/testing.js";

function createRefreshHarness() {
    const store = new TuiAppStore();
    let oauthReads = 0;
    const clients = {
        artifact: {
            async listShares() {
                return [];
            },
            async listTransfers() {
                return [];
            }
        },
        config: {
            async get() {
                return {
                    instances: [
                        {
                            enabled: true,
                            mcp: { enabled: false, path: "/alpha/mcp" },
                            name: "alpha",
                            provider: "local",
                            workspace: "/workspace/alpha"
                        },
                        {
                            enabled: false,
                            mcp: { enabled: true, path: "/beta/mcp" },
                            name: "beta",
                            provider: "reverse",
                            workspace: "/workspace/beta"
                        }
                    ],
                    mcp: {
                        auth: { mode: "none" },
                        enabled: false
                    }
                };
            }
        },
        instance: {
            async list() {
                return [{
                    mcpEnabled: false,
                    name: "alpha"
                }];
            }
        },
        mcp: {
            async listApprovals() {
                oauthReads += 1;
                return [];
            },
            async status() {
                return { running: false };
            }
        },
        runtime: {
            async readLogs(instance: string) {
                return [{
                    at: "2026-07-16T00:00:00.000Z",
                    instanceName: instance,
                    message: "ready",
                    seq: 4,
                    stream: "stdout"
                }];
            },
            async snapshot(instance: string) {
                return {
                    lastSeq: 4,
                    snapshot: {
                        connectionState: "connected",
                        daemonState: "running",
                        lastSeq: 4,
                        name: asInstanceName(instance),
                        ready: true,
                        status: "ready"
                    }
                };
            }
        },
        todo: {
            async get() {
                return {
                    todo: {
                        items: [],
                        revision: 0,
                        summary: { completed: 0, total: 0 }
                    }
                };
            }
        },
        tool: {
            async listApprovals() {
                return [];
            },
            async listCalls() {
                return [];
            }
        }
    } as never;
    const refresh = new TuiControlSessionRefresh({ clients, store });
    return { oauthReads: () => oauthReads, refresh, store };
}

test("session refresh independently merges configured and runtime instances and returns subscription cursors", async () => {
    const harness = createRefreshHarness();

    const subscriptions = await harness.refresh.refreshAll();

    assert.deepEqual(
        harness.store.getState().instances.map((instance) => ({
            enabled: instance.enabled,
            name: instance.name,
            provider: instance.provider
        })),
        [
            { enabled: true, name: "alpha", provider: "local" },
            { enabled: false, name: "beta", provider: "reverse" }
        ]
    );
    assert.equal(harness.store.getState().snapshotsByInstance.alpha?.ready, true);
    assert.equal(harness.store.getState().snapshotsByInstance.beta, undefined);
    assert.equal(harness.store.getState().logsByInstance.alpha?.[0]?.message, "ready");
    assert.deepEqual(subscriptions, [{ fromSeq: 4, instance: "alpha" }]);
    assert.equal(harness.oauthReads(), 0);
});

test("session refresh routes page-specific reloads without rebuilding unrelated data", async () => {
    const harness = createRefreshHarness();
    await harness.refresh.refreshAll();

    await harness.refresh.refreshConfig();
    await harness.refresh.refreshAudit("alpha");
    await harness.refresh.refreshLogsForInstance("alpha");
    await harness.refresh.refreshTodo("alpha");
    await harness.refresh.refreshOAuth();

    assert.equal(harness.store.getState().configView?.instances !== undefined, true);
    assert.equal(harness.store.getState().toolCallsByInstance.alpha?.length, 0);
    assert.equal(harness.store.getState().approvalsByInstance.alpha?.length, 0);
    assert.equal(harness.store.getState().todoByInstance.alpha?.revision, 0);
    assert.equal(harness.oauthReads(), 0);
});

test("subscription manager applies events, reports gaps, and closes replaced streams", async () => {
    const events: JsonValue[] = [];
    const gaps: string[] = [];
    const closed: string[] = [];
    const errors: string[] = [];
    let firstClosed = false;
    let subscriptionCount = 0;
    const manager = new TuiControlSessionSubscriptions({
        onConnectionClosed: (instance) => {
            closed.push(instance);
        },
        onEvent: (message) => {
            events.push(message.event.payload ?? null);
        },
        onGap: async (instance) => {
            gaps.push(instance);
        },
        onSubscribeError: async (instance, error) => {
            errors.push(`${instance}:${String(error)}`);
        },
        subscribe: async (instance) => {
            subscriptionCount += 1;
            const messages = subscriptionCount === 1
                ? [
                    {
                        event: {
                            destination: asInstanceName(instance),
                            name: "log.appended",
                            payload: { line: "one" },
                            seq: 2
                        },
                        kind: "instance.event"
                    },
                    {
                        code: "stream.gap",
                        fromSeq: 2,
                        kind: "stream.gap",
                        lastSeq: 5,
                        nextSeq: 4
                    }
                ]
                : [{ kind: "connection.closed" }];
            return {
                close() {
                    if (subscriptionCount === 1) {
                        firstClosed = true;
                    }
                },
                async nextMessage() {
                    const message = messages.shift();
                    if (message === undefined) {
                        return await new Promise<never>(() => undefined);
                    }
                    return message as never;
                }
            };
        }
    });

    manager.subscribeInstance("alpha", 2);
    await waitFor(() => gaps.length === 1);
    assert.deepEqual(events, [{ line: "one" }]);
    assert.deepEqual(gaps, ["alpha"]);
    assert.equal(firstClosed, true);
    assert.deepEqual(errors, []);

    manager.subscribeInstance("alpha", 5);
    await waitFor(() => closed.length === 1);
    assert.deepEqual(closed, ["alpha"]);
    manager.closeAll();
    assert.equal(manager.size, 0);
});

async function waitFor(factory: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (factory()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for condition.");
}
