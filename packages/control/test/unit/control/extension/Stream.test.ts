import assert from "node:assert/strict";
import test from "node:test";
import type { ControlStreamBinding, ControlStreamMessage } from "@portable-devshell/extension/control";
import type { ControlPortContext, MessageStream } from "@portable-devshell/shared";
import { asInstanceName } from "@portable-devshell/shared";
import type { ProcessSubscriptionManager } from "../../../../../core/src/instance/runtime/supervision/Subscription.ts";
import type { InstanceEventSource } from "../../../../../core/src/instance/runtime/supervision/Event.ts";
import type { ExtensionPointSandboxBridge } from "../../../../src/extension/registration/PointRegistry.ts";
import { controlStreamsExtensionPointDefinition, controlStreamsSandboxCodec } from "../../../../src/extension/api/point/control/Stream.ts";
import { ControlExtensionRouteService } from "../../../../src/extension/api/point/control/Dispatch.ts";
import { ExtensionInstanceObserveCapabilityControl } from "../../../../src/extension/api/cap/instance/Control.ts";
import { createMessageSubscriptionBinding } from "../../../../../../extensions/comment/src/message/Route.ts";

const declaration = { id: "message-subscribe", module: "message", operation: "subscribe", scope: "instance" } as const;
const validation = { codeDirectory: "/comment", extensionId: "comment", id: declaration.id };
const event = (seq: number, type: string) => ({ at: "now", instanceName: asInstanceName("dev"), seq, type });

test("sandbox stream bridge forwards ordered frames, cancellation, and send failures", async () => {
    const controller = new AbortController();
    const messages: ControlStreamMessage[] = [];
    const binding: ControlStreamBinding = async (stream, request, context) => {
        assert.equal(context.destination, "dev");
        assert.deepEqual(request.payload, { fromSeq: 1 });
        const cancelled = new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        await stream.send({ name: "seed", payload: { events: [], lastSeq: 1 } });
        await stream.send({ name: "event", payload: event(2, "context.message.queued"), seq: 2 });
        await cancelled;
        await stream.close();
    };
    const bridge: ExtensionPointSandboxBridge = {
        async invokeBinding(pointId, id, input, options) {
            assert.equal(pointId, "control.streams");
            assert.equal(id, declaration.id);
            return await controlStreamsSandboxCodec.invokeBinding(binding, input, options!.signal!, {
                ...validation,
                requestInterface: async (operation, value) => await options!.interfacePort!.request(operation, value),
            });
        },
    };
    const proxied = controlStreamsExtensionPointDefinition.createSandboxBinding!(
        controlStreamsSandboxCodec.describeBinding(binding, validation), validation, bridge,
    ) as ControlStreamBinding;
    const context = { destination: "dev", peer: "cli" as const, requestId: "request", signal: controller.signal };
    let closed = false;
    await proxied({
        send: async (message) => { messages.push(message); if (messages.length === 2) controller.abort(); },
        close: async () => { closed = true; },
    }, { payload: { fromSeq: 1 } }, context);
    assert.deepEqual(messages.map((message) => message.name), ["seed", "event"]);
    assert.equal(closed, true);
    const failure = new Error("socket write failed");
    await assert.rejects(async () => await proxied({ send: async () => { throw failure; }, close: async () => {} },
        { payload: { fromSeq: 1 } }, { ...context, signal: new AbortController().signal }), failure);
});

test("seeded instance observation resumes after the seed and preserves initial gap errors", async () => {
    let nextFromSeq = -1;
    const source: Pick<InstanceEventSource, "subscribe"> = {
        subscribe(fromSeq: number) {
            assert.equal(fromSeq, 1);
            return { kind: "events" as const, events: [event(1, "context.message.queued")], lastSeq: 3 };
        },
    };
    const capability = new ExtensionInstanceObserveCapabilityControl({
        allowed: true, extensionId: "comment",
        instances: { get: () => ({ worker: source }) } as never,
        listConfigured: () => [],
        readLogs: async () => [],
        subscriptions: { async watch(...[_name, _source, fromSeq, _signal, handlers]: Parameters<ProcessSubscriptionManager["watch"]>) {
            nextFromSeq = fromSeq;
            await handlers.onEvent(event(4, "context.message.delivered"));
        } } as never,
    });
    const messages: ControlStreamMessage[] = [];
    await createMessageSubscriptionBinding(capability)({ send: async (message) => { messages.push(message); }, close: async () => {} },
        { payload: { fromSeq: 1 } },
        { destination: "dev", peer: "cli", requestId: "request", signal: new AbortController().signal });
    assert.equal(nextFromSeq, 4);
    assert.deepEqual(messages.map((message) => message.name), ["seed", "event"]);
    source.subscribe = () => ({ kind: "gap", code: "stream.gap", fromSeq: 1, lastSeq: 10, nextSeq: 8 });
    await assert.rejects(() => capability.watchEvents("dev", {
        fromSeq: 1, onSeed: async () => {}, onEvent: async () => {}, signal: new AbortController().signal,
    }), { code: "stream.gap", details: { instance: "dev", latestSeq: 10, oldestAvailableSeq: 8, requestedFromSeq: 1 } });
    assert.equal(nextFromSeq, 4);
});

test("stream admission releases the host handler while instance and extension retirement drain the generation", async () => {
    let generation = "v1";
    const changes = new Set<() => void>();
    let releases = 0;
    const frames: ControlStreamMessage[] = [];
    let markReady!: () => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const binding: ControlStreamBinding = async (stream, _request, context) => {
        const cancelled = new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        await stream.send({ name: "seed", payload: { events: [], lastSeq: 0 } });
        markReady();
        await cancelled;
    };
    const routes = new ControlExtensionRouteService({
        listDeclarations: (pointId) => pointId === "control.streams" ? [{ declaration, extensionId: "comment", generation, id: declaration.id, pointId }] : [],
        onChange: (listener) => { changes.add(listener); return () => { changes.delete(listener); }; },
        acquireRegistration: async () => ({
            extensionId: "comment",
            registration: { binding, declaration, id: declaration.id, pointId: "control.streams" },
            lease: { generation, release: () => { releases += 1; } } as never,
        }),
    });
    const stream = {
        send: async (message: ControlStreamMessage) => { frames.push(message); },
        close: async () => {},
        cancel: async () => { assert.fail("unexpected stream cancellation"); },
    } as unknown as MessageStream;
    const handler = routes.modules("instance")[0]!.streams![0]!.handle;
    const context = { host: "dev", peer: "cli", requestId: "request", signal: new AbortController().signal } as ControlPortContext;
    await handler(stream, { id: "request", name: "subscribe", payload: { fromSeq: 1 } }, context);
    await ready;
    assert.equal(releases, 0);
    await routes.retireInstance("dev");
    assert.equal(releases, 1);
    assert.equal(changes.size, 0);
    await handler(stream, { id: "request-2", name: "subscribe", payload: { fromSeq: 1 } }, context);
    generation = "v2";
    for (const listener of changes) listener();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(releases, 2);
    assert.equal(changes.size, 0);
    assert.deepEqual(frames.map((frame) => frame.name), ["seed", "seed"]);
});
