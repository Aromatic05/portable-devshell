import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerInstance } from "@portable-devshell/core";
import type { ArtifactService } from "../../dist/artifact/ArtifactService.js";

import { InstanceRegistry } from "../../dist/instance/registry/InstanceRegistry.js";
import { RouteMethodRegistry } from "../../dist/route/RouteMethodRegistry.js";
import { RouteHandlerControl } from "../../dist/route/handler/RouteHandlerControl.js";
import { RouteHandlerInstance } from "../../dist/route/handler/RouteHandlerInstance.js";
import { RouteRouterControl } from "../../dist/route/router/RouteRouterControl.js";
import { RouteRouterInstance } from "../../dist/route/router/RouteRouterInstance.js";
import { StreamSubscriptionManager } from "../../dist/stream/StreamSubscriptionManager.js";

test("RouteMethodRegistry resolves control and instance methods", () => {
    const registry = new RouteMethodRegistry();

    assert.equal(registry.resolve("control.identifyClient"), "control");
    assert.equal(registry.resolve("control.ping"), "control");
    assert.equal(registry.resolve("control.restart"), "control");
    assert.equal(registry.resolve("control.listInstances"), "control");
    assert.equal(registry.resolve("control.createInstance"), "control");
    assert.equal(registry.resolve("control.artifact.createShare"), "control");
    assert.equal(registry.resolve("control.artifact.revokeShare"), "control");
    assert.equal(registry.resolve("control.artifact.startTransfer"), "control");
    assert.equal(registry.resolve("control.artifact.getTransfer"), "control");
    assert.equal(registry.resolve("control.artifact.cancelTransfer"), "control");
    assert.equal(registry.resolve("instance.callTool"), "instance");
    assert.equal(registry.resolve("instance.readToolCalls"), "instance");
    assert.equal(registry.resolve("instance.listApprovals"), "instance");
    assert.equal(registry.resolve("instance.getApproval"), "instance");
    assert.equal(registry.resolve("instance.decideApproval"), "instance");
    assert.equal(registry.resolve("control.getGlobalLogs"), undefined);
});

test("RouteRouterControl rejects instance targets with control.invalidTarget", async () => {
    const instanceRegistry = new InstanceRegistry([]);
    const controlRouter = new RouteRouterControl(
        new RouteHandlerControl({
            instanceRegistry
        })
    );

    await assert.rejects(
        controlRouter.route(
            {
                clientKind: "unknown",
                id: "conn-control",
                identifyClient() {}
            } as never,
            {
                id: "req-1",
                method: "control.ping",
                target: { instance: "alpha", kind: "instance" },
                type: "request"
            }
        ),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "control.invalidTarget");
            return true;
        }
    );
});

test("Route routers dispatch by target and return instance not found / invalid target errors", async () => {
    const instanceRegistry = new InstanceRegistry([]);
    const controlRouter = new RouteRouterControl(
        new RouteHandlerControl({
            instanceRegistry
        })
    );
    const instanceRouter = new RouteRouterInstance(
        new RouteHandlerInstance({
            instanceRegistry,
            streamSubscriptionManager: new StreamSubscriptionManager(5)
        })
    );

    const controlResult = (await controlRouter.route(
        {
            clientKind: "unknown",
            id: "conn-control",
            identifyClient() {}
        } as never,
        {
            id: "req-1",
            method: "control.ping",
            target: { kind: "control" },
            type: "request"
        }
    )) as { pong: boolean };

    assert.equal(controlResult.pong, true);

    await assert.rejects(
        instanceRouter.route(
            {
                id: "conn-route",
                async sendEvent() {}
            } as never,
            {
                id: "req-2",
                method: "instance.getSnapshot",
                target: { kind: "control" },
                type: "request"
            }
        ),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "control.invalidTarget");
            return true;
        }
    );

    await assert.rejects(
        instanceRouter.route(
            {
                id: "conn-route",
                async sendEvent() {}
            } as never,
            {
                id: "req-3",
                method: "instance.getSnapshot",
                target: { instance: "missing", kind: "instance" },
                type: "request"
            }
        ),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "control.instanceNotFound");
            return true;
        }
    );
});


test("artifact control route accepts an explicit source instance", async () => {
    const calls: unknown[] = [];
    const artifactService = {
        async startTransfer(input: unknown, defaultInstance: string) {
            calls.push({ defaultInstance, input });
            return {
                operation: "start",
                transfer: {
                    createdAt: "2026-07-13T00:00:00.000Z",
                    source: { instance: defaultInstance, path: "./result.bin" },
                    status: "queued",
                    target: { instance: "target-b", path: "/tmp/result.bin" },
                    transferId: "transfer-1",
                    transferredBytes: 0,
                    updatedAt: "2026-07-13T00:00:00.000Z"
                }
            };
        }
    } as unknown as ArtifactService;
    const router = new RouteRouterControl(
        new RouteHandlerControl({
            artifactService,
            instanceRegistry: new InstanceRegistry([])
        })
    );

    const result = await router.route(
        {
            clientKind: "cli",
            id: "artifact-route",
            identifyClient() {}
        } as never,
        {
            id: "artifact-start",
            method: "control.artifact.startTransfer",
            params: {
                instance: "source-a",
                sourcePath: "./result.bin",
                targetInstance: "target-b",
                targetPath: "/tmp/result.bin"
            },
            target: { kind: "control" },
            type: "request"
        }
    );

    assert.equal((result as { transfer: { status: string } }).transfer.status, "queued");
    assert.deepEqual(calls, [
        {
            defaultInstance: "source-a",
            input: {
                instance: "source-a",
                operation: "start",
                sourcePath: "./result.bin",
                targetInstance: "target-b",
                targetPath: "/tmp/result.bin"
            }
        }
    ]);
});
void (0 as unknown as WorkerInstance);
