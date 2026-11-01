import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import type { MessageStream } from "@portable-devshell/shared";
import { ArtifactService } from "../../../src/artifact/Service.ts";
import { ConfigChangeHub } from "../../../src/config/change/Config.ts";
import { createConfigRouteModule } from "../../../src/config/Route.ts";
import { createContextRouteModule } from "../../../src/context/Route.ts";
import { ContextChangeHub } from "../../../src/context/registry/Change.ts";
import { ExtensionChangeHub } from "../../../src/extension/manager/Change.ts";
import { createExtensionRouteModule } from "../../../src/extension/manager/Endpoint.ts";
import { InstanceChangeHub } from "../../../src/instance/Change.ts";
import { createInstanceConfigRouteModule } from "../../../src/instance/Route.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

const tick = async () => await new Promise<void>((resolve) => setImmediate(resolve));

test("all four Control subscriptions end remote streams after send failure", async () => {
    const cases = [
        { name: "config", create: () => {
            const hub = new ConfigChangeHub();
            return {
                route: createConfigRouteModule({ getConfigView: () => ({}) } as never, hub),
                publish: () => hub.publish(["system.test"]),
            };
        } },
        { name: "context", create: () => {
            const changes = new ContextChangeHub();
            return {
                route: createContextRouteModule({ registry: { changes } } as never),
                publish: () => changes.publish(["ctx"]),
            };
        } },
        { name: "extension", create: () => {
            const changes = new ExtensionChangeHub();
            return {
                route: createExtensionRouteModule({} as never, { changes, snapshot: async () => ({}) } as never),
                publish: () => changes.publish(["extension.test"]),
            };
        } },
        { name: "instance", create: () => {
            const changes = new InstanceChangeHub();
            return {
                route: createInstanceConfigRouteModule({ changes } as never),
                publish: () => changes.publish("registry"),
            };
        } },
    ];
    for (const scenario of cases) {
        const { route, publish } = scenario.create();
        const handle = route.streams?.find((entry) => entry.name === (scenario.name === "instance" ? "subscribeInstances" : "subscribe"))?.handle;
        assert.ok(handle, `${scenario.name}: missing subscription`);
        let failSend = false, sent = 0, closed = 0;
        const stream = {
            async send() { sent += 1; if (failSend) throw new Error("send failed"); },
            async close() { closed += 1; },
            onClose: () => () => undefined,
            onCancel: () => () => undefined,
        } as unknown as MessageStream;
        await handle(stream, {
            id: "test", name: "subscribe", payload: { fromRevision: 1 },
        } as never, {} as never);
        await tick();
        failSend = true;
        publish();
        await tick();
        await tick();
        assert.equal(closed, 1, `${scenario.name}: remote close missing`);
        failSend = false;
        const afterFailure = sent;
        publish();
        await tick();
        assert.equal(sent, afterFailure, `${scenario.name}: failed producer should stay detached`);
    }
});

test("Control revision Hubs gap-recover future cursors after process restart", () => {
    const config = new ConfigChangeHub();
    const extension = new ExtensionChangeHub();
    const instances = new InstanceChangeHub();
    config.publish(["control.test"]);
    extension.publish(["extension.test"]);
    instances.publish("registry");
    assert.equal(config.readSince(21).kind, "gap");
    assert.equal(extension.readSince(21).kind, "gap");
    assert.equal(instances.replay(21).kind, "gap");
    assert.equal(config.readSince(2).kind, "events");
    assert.equal(extension.readSince(2).kind, "events");
    assert.equal(instances.replay(2).kind, "replay");
});

test("Artifact service stops a live remote subscription before leaving its stream handler", async (t) => {
    const storageDir = await createTestTempDirectory("artifact-subscription-retirement");
    t.after(async () => await rm(storageDir, { recursive: true, force: true }));
    const service = new ArtifactService({
        storageDir,
        resolveEndpoint: () => undefined,
        shareUrl: (token) => `https://example.invalid/${token}`,
    });
    let closes = 0;
    const stream = {
        async send() {},
        async close() { closes += 1; },
        onClose: () => () => undefined,
        onCancel: () => () => undefined,
    } as unknown as MessageStream;
    await service.initialize();
    try {
        const serving = service.subscribe(stream, 1);
        await tick();
        await service.stop();
        await serving;
        await tick();
        assert.equal(closes, 1);
    } finally { await service.stop(); }
});
