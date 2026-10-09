import assert from "node:assert/strict";
import test from "node:test";

import type { ControlPortContext, ExtensionRuntimeRecord, MessageStream } from "@portable-devshell/shared";

import { ExtensionChangeHub } from "../../../../../src/extension/manager/Change.ts";
import {
    createExtensionRouteModule,
} from "../../../../../src/extension/manager/Endpoint.ts";

import type { ExtensionControlPort } from "../../../../../src/extension/Api.ts";

function createPort(): ExtensionControlPort {
    return {
        async disable() {},
        async enable() {},
        async install() {
            return {
                activeGeneration: "g1",
                enabled: true,
                id: "x",
                retired: [],
                selectedGeneration: "g1",
                state: "active",
                version: "1.0.0",
            };
        },
        async list() { return []; },
        async reload() {},
        async remove(id, purge) { return { id, purged: purge, removed: true }; },
    };
}

function streamRecorder() {
    const sent: unknown[] = [];
    let close!: () => void;
    let cancel!: () => void;
    const stream = {
        async send(message: unknown) { sent.push(message); },
        onClose(listener: () => void) { close = listener; },
        onCancel(listener: () => void) { cancel = listener; },
    } as unknown as MessageStream;
    return { cancel: () => cancel(), close: () => close(), sent, stream };
}

function subscribe(module: ReturnType<typeof createExtensionRouteModule>, stream: MessageStream, fromRevision: number): void {
    const handler = module.streams?.find(({ name }) => name === "subscribe");
    assert.ok(handler);
    handler.handle(stream, { id: "req", name: "subscribe", payload: { fromRevision } }, {} as never);
}

test("extension route snapshot delegates to its contextual atomic snapshot provider", async () => {
    const hub = new ExtensionChangeHub();
    const expected = { extensions: [], revision: 4, tuiPages: [], tuiSupported: true, webApplications: [], webPages: [], webSupported: true };
    const context = { requestId: "snapshot-request" };
    let received: unknown;
    const module = createExtensionRouteModule(createPort(), {
        changes: hub,
        async snapshot(value) { received = value; return expected; },
    });
    const operation = module.operations.find(({ name }) => name === "snapshot");
    assert.ok(operation);
    assert.deepEqual(await operation.handle({ id: "req", name: "snapshot" }, context as never), expected);
    assert.equal(received, context);
});

test("extension subscription serializes replay and live sends until the prior send resolves", async () => {
    const hub = new ExtensionChangeHub();
    hub.publish(["first"]);
    const sent: unknown[] = [];
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    let markSecondEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const secondEntered = new Promise<void>((resolve) => { markSecondEntered = resolve; });
    let sendCount = 0;
    let close!: () => void;
    let cancel!: () => void;
    const stream = {
        async send(message: unknown) {
            sendCount += 1;
            sent.push(message);
            if (sendCount === 1) {
                markFirstEntered();
                await firstGate;
            }
            if (sendCount === 2) markSecondEntered();
        },
        onClose(listener: () => void) { close = listener; },
        onCancel(listener: () => void) { cancel = listener; },
    } as unknown as MessageStream;
    subscribe(createExtensionRouteModule(createPort(), { changes: hub, async snapshot() { throw new Error("unused"); } }), stream, 1);
    await firstEntered;
    hub.publish(["second"]);
    await Promise.resolve();
    assert.equal(sendCount, 1);
    releaseFirst();
    await secondEntered;
    assert.deepEqual(sent, [
        { name: "event", payload: { extensionIds: ["first"], revision: 1 }, seq: 1 },
        { name: "event", payload: { extensionIds: ["second"], revision: 2 }, seq: 2 },
    ]);
    close();
    hub.publish(["third"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 2);
    assert.equal(typeof cancel, "function");
});

test("extension subscription reports replay gaps and cancel stops later events", async () => {
    const hub = new ExtensionChangeHub({ historyLimit: 1 });
    hub.publish(["old"]);
    hub.publish(["current"]);
    const recorder = streamRecorder();
    subscribe(createExtensionRouteModule(createPort(), { changes: hub, async snapshot() { throw new Error("unused"); } }), recorder.stream, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    recorder.cancel();
    hub.publish(["later"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(recorder.sent, [
        { name: "gap", payload: { latestSeq: 2, oldestAvailableSeq: 2, requestedFromSeq: 1 } },
    ]);
});

test("extension subscription detaches after send rejection", async () => {
    const hub = new ExtensionChangeHub();
    let sendCount = 0;
    let close!: () => void;
    let cancel!: () => void;
    const stream = {
        async send() {
            sendCount += 1;
            throw new Error("stream send failed");
        },
        onClose(listener: () => void) { close = listener; },
        onCancel(listener: () => void) { cancel = listener; },
    } as unknown as MessageStream;
    subscribe(createExtensionRouteModule(createPort(), { changes: hub, async snapshot() { throw new Error("unused"); } }), stream, 1);
    hub.publish(["first"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    hub.publish(["second"]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sendCount, 1);
    assert.equal(typeof close, "function");
    assert.equal(typeof cancel, "function");
});

test("extension subscription rejects a negative fromRevision", () => {
    const hub = new ExtensionChangeHub();
    const recorder = streamRecorder();
    const module = createExtensionRouteModule(createPort(), {
        changes: hub,
        async snapshot() { throw new Error("unused"); },
    });
    assert.throws(() => subscribe(module, recorder.stream, -1), /non-negative integer fromRevision/u);
    assert.deepEqual(recorder.sent, []);
});

function context(
    peer: "cli" | "tui" | "web",
    subjectKind: string,
): ControlPortContext {
    return {
        connectionId: "conn-1",
        sourceHost: "conn-1",
        host: "@control",
        peer,
        requestId: "req-1",
        signal: new AbortController().signal,
        afterReply() {},
        subject: { id: "subject-1", kind: subjectKind },
    } as ControlPortContext;
}

function record(enabled = true): ExtensionRuntimeRecord {
    return {
        activeGeneration: enabled ? "g1" : undefined,
        enabled,
        id: "example",
        retired: [],
        selectedGeneration: "g1",
        state: enabled ? "active" : "disabled",
        version: "1.0.0",
    };
}

function port(events: string[] = []): ExtensionControlPort {
    let enabled = true;
    return {
        async disable(id) {
            events.push(`disable:${id}`);
            enabled = false;
        },
        async enable(id) {
            events.push(`enable:${id}`);
            enabled = true;
        },
        async install(sourcePath) {
            events.push(`install:${sourcePath}`);
            return record();
        },
        async list() {
            events.push("list");
            return [record(enabled)];
        },
        async reload(id) {
            events.push(`reload:${id}`);
        },
        async remove(id, purge) {
            events.push(`remove:${id}:${purge}`);
            return { id, purged: purge, removed: true };
        },
    };
}

function operation(
    module: ReturnType<typeof createExtensionRouteModule>,
    name: string,
) {
    const found = module.operations.find(
        (candidate) => candidate.name === name,
    );
    if (found === undefined)
        throw new Error(`extension.${name} operation is missing`);
    return found;
}

test("Extension routes expose management reads without command or generic RPC surfaces", async () => {
    const events: string[] = [];
    const module = createExtensionRouteModule(port(events));

    assert.equal(
        module.operations.some((candidate) => candidate.name === "command"),
        false,
    );
    assert.deepEqual(
        await operation(module, "list").handle(
            { id: "1", name: "list" },
            context("web", "web-session"),
        ),
        [record()],
    );
    assert.deepEqual(
        await operation(module, "get").handle(
            {
                id: "2",
                name: "get",
                payload: { extensionId: "example" },
            },
            context("web", "web-session"),
        ),
        record(),
    );
    assert.deepEqual(events, ["list", "list"]);
});

test("Extension lifecycle mutations require local-owner CLI", async () => {
    const events: string[] = [];
    const module = createExtensionRouteModule(port(events));
    const install = operation(module, "install");
    const reload = operation(module, "reload");
    const remove = operation(module, "remove");

    await assert.rejects(
        async () =>
            await reload.handle(
                {
                    id: "1",
                    name: "reload",
                    payload: { extensionId: "example" },
                },
                context("cli", "bearer"),
            ),
        /restricted to the local owner CLI/iu,
    );
    await assert.rejects(
        async () =>
            await reload.handle(
                {
                    id: "2",
                    name: "reload",
                    payload: { extensionId: "example" },
                },
                context("web", "local-owner"),
            ),
        /restricted to the local owner CLI/iu,
    );
    await assert.rejects(
        async () =>
            await install.handle(
                {
                    id: "3",
                    name: "install",
                    payload: { sourcePath: "/tmp/example.dsext" },
                },
                context("cli", "bearer"),
            ),
        /restricted to the local owner CLI/iu,
    );
    assert.deepEqual(
        await reload.handle(
            { id: "4", name: "reload", payload: { extensionId: "example" } },
            context("cli", "local-owner"),
        ),
        record(),
    );
    assert.deepEqual(
        await install.handle(
            {
                id: "5",
                name: "install",
                payload: { sourcePath: "/tmp/example.dsext" },
            },
            context("cli", "local-owner"),
        ),
        record(),
    );
    assert.deepEqual(
        await remove.handle(
            {
                id: "6",
                name: "remove",
                payload: { extensionId: "example", purge: true },
            },
            context("cli", "local-owner"),
        ),
        { id: "example", purged: true, removed: true },
    );
    assert.deepEqual(events, [
        "reload:example",
        "list",
        "install:/tmp/example.dsext",
        "remove:example:true",
    ]);
});

test("Extension route parser rejects invalid management ids before dispatch", async () => {
    const events: string[] = [];
    const module = createExtensionRouteModule(port(events));

    await assert.rejects(
        async () =>
            await operation(module, "get").handle(
                {
                    id: "1",
                    name: "get",
                    payload: { extensionId: "Bad_ID" },
                },
                context("cli", "local-owner"),
            ),
        /extensionId must match/iu,
    );
    assert.deepEqual(events, []);
});
