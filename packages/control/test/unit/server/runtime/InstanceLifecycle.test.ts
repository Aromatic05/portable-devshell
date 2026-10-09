import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { createInstance, type Instance } from "@portable-devshell/core";
import {
    normalizeConfigInstanceDraft,
    runtimeErrorCodes,
    type ControlHostDefinition,
    type ControlPortContext,
    type ControlPortDefinition,
} from "@portable-devshell/shared";

import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

test("close retries a failed worker close without reopening the retired generation", async (t) => {
    const root = await createTestTempDirectory("instance-finalize-retry");
    const restoreHome = redirectHome(root);
    const instance = createInstance(
        normalizeConfigInstanceDraft({ name: "retry-local", provider: "local" }),
    );
    t.after(async () => {
        await instance.close().catch(() => undefined);
        restoreHome();
        await rm(root, { force: true, recursive: true });
    });
    const originalClose = instance.supervision.close.bind(instance.supervision);
    const failure = new Error("temporary close failure");
    instance.supervision.close = async () => {
        throw failure;
    };

    await assert.rejects(instance.close(), /temporary close failure/u);
    assert.equal(instance.lifecycle.retired, true);
    assert.throws(() => instance.lifecycle.acquireLease(), /retired/u);

    instance.supervision.close = originalClose;
    await instance.close();
    assert.equal(instance.lifecycle.closed, true);
    assert.throws(() => instance.lifecycle.acquireLease(), /retired/u);
});

test("shutdown waits for admitted work and closes every instance audit", { timeout: 5000 }, async (t) => {
    const root = await createTestTempDirectory("instance-shutdown-drain");
    const restoreHome = redirectHome(root);
    const first = createInstance(
        normalizeConfigInstanceDraft({ name: "first-local", provider: "local" }),
    );
    const second = createInstance(
        normalizeConfigInstanceDraft({ name: "second-local", provider: "local" }),
    );
    t.after(async () => {
        await Promise.all([
            first.close().catch(() => undefined),
            second.close().catch(() => undefined),
        ]);
        restoreHome();
        await rm(root, { force: true, recursive: true });
    });

    await first.supervision.state.appendEvent("test.shutdown", { value: 1 });
    assert.equal(first.supervision.state.snapshot().lastSeq, 1);
    const lease = first.lifecycle.acquireLease();
    let closed = false;
    const closing = Promise.all([first.close(), second.close()]).then(() => {
        closed = true;
    });
    await waitForPhase(first, "retiring");
    assert.equal(closed, false);
    assert.throws(() => first.lifecycle.acquireLease(), /retired/u);
    lease.release();
    await closing;
    assert.equal(first.lifecycle.closed, true);
    assert.equal(second.lifecycle.closed, true);
    await assert.rejects(
        first.supervision.state.appendEvent("late", { value: 2 }),
        /clos/iu,
    );
    await assert.rejects(
        second.supervision.state.appendEvent("late", { value: 2 }),
        /clos/iu,
    );
});

test("retirement cancels a pending approval before waiting for its admitted call", { timeout: 5000 }, async (t) => {
    const root = await createTestTempDirectory("instance-approval-drain");
    const restoreHome = redirectHome(root);
    const instance = createInstance(
        normalizeConfigInstanceDraft({
            approvalPolicy: { mode: "ask" },
            name: "approval-local",
            provider: "local",
        }),
    );
    t.after(async () => {
        await instance.close().catch(() => undefined);
        restoreHome();
        await rm(root, { force: true, recursive: true });
    });
    const host = instance.host();
    const list = routeOperation(routePort(host, "approval"), "list");
    const call = routeOperation(routePort(host, "tool"), "call");

    const pendingCall = call.handle(
        {
            id: "call-1",
            name: "call",
            payload: {
                input: {},
                toolName: "shell_run",
                workspace: "/workspace",
            },
        },
        createContext(instance.config.name),
    );
    const pending = await waitFor(async () => {
        const value = await list.handle(
            { id: "list-1", name: "list", payload: { pendingOnly: true } },
            createContext(instance.config.name),
        );
        return Array.isArray(value) && value.length === 1 ? value : undefined;
    });
    assert.equal((pending[0] as { status?: string }).status, "pending");

    await instance.close();
    const result = (await pendingCall) as { error?: { code?: string } };
    assert.equal(result.error?.code, runtimeErrorCodes.toolCallRejected);
    assert.equal(instance.lifecycle.closed, true);
});

test("instance generations resume the persisted event cursor after finalization", async (t) => {
    const root = await createTestTempDirectory("instance-event-generation");
    const restoreHome = redirectHome(root);
    const config = normalizeConfigInstanceDraft({
        name: "event-local",
        provider: "local",
    });
    const original = createInstance(config);
    await original.supervision.state.appendEvent("test.first", { value: 1 });
    await original.close();
    const replacement = createInstance(config);
    t.after(async () => {
        await replacement.close().catch(() => undefined);
        restoreHome();
        await rm(root, { force: true, recursive: true });
    });

    assert.equal(replacement.supervision.snapshot().lastSeq, 1);
    await replacement.supervision.state.appendEvent("test.second", { value: 2 });
    const slice = replacement.supervision.state.subscribe(1);
    assert.equal(slice.kind, "events");
    assert.ok("events" in slice);
    assert.deepEqual(
        slice.events.map((event) => ({
            data: event.data,
            seq: event.seq,
            type: event.type,
        })),
        [
            { data: { value: 1 }, seq: 1, type: "test.first" },
            { data: { value: 2 }, seq: 2, type: "test.second" },
        ],
    );
});

function redirectHome(root: string): () => void {
    const previous = {
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
    };
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    return () => {
        if (previous.HOME === undefined) delete process.env.HOME;
        else process.env.HOME = previous.HOME;
        if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previous.USERPROFILE;
    };
}

function createContext(host: string): ControlPortContext {
    return {
        afterReply() {},
        connectionId: "connection-1",
        sourceHost: "connection-1",
        host,
        peer: "cli",
        requestId: "request-1",
        signal: new AbortController().signal,
    };
}

function routePort(
    host: ControlHostDefinition,
    name: string,
): ControlPortDefinition {
    const port = host.ports.find((entry) => entry.name === name);
    if (port === undefined) throw new Error(`Route port ${name} is missing.`);
    return port;
}

function routeOperation(
    port: ControlPortDefinition,
    name: string,
): ControlPortDefinition["operations"][number] {
    const operation = port.operations.find((entry) => entry.name === name);
    if (operation === undefined)
        throw new Error(`Route operation ${name} is missing.`);
    return operation;
}

async function waitForPhase(
    instance: Instance,
    phase: Instance["lifecycle"]["phase"],
): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (instance.lifecycle.phase === phase) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error(
        `Instance ${instance.config.name} did not reach ${phase}.`,
    );
}

async function waitFor<T>(
    factory: () => Promise<T | undefined>,
    timeoutMs = 2000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await factory();
        if (value !== undefined) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for condition.");
}
