import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerInstance } from "@portable-devshell/core";

import { InstanceRegistry } from "../../dist/instance/registry/InstanceRegistry.js";
import { RouteMethodRegistry } from "../../dist/route/RouteMethodRegistry.js";
import { RouteHandlerControl } from "../../dist/route/handler/RouteHandlerControl.js";
import { RouteHandlerInstance } from "../../dist/route/handler/RouteHandlerInstance.js";
import { RouteRouterControl } from "../../dist/route/router/RouteRouterControl.js";
import { RouteRouterInstance } from "../../dist/route/router/RouteRouterInstance.js";
import { StreamSubscriptionManager } from "../../dist/stream/StreamSubscriptionManager.js";
import "../integration/ControlRpcServer.test.ts";

test("RouteMethodRegistry resolves Task 9 methods only", () => {
    const registry = new RouteMethodRegistry();

    assert.equal(registry.resolve("control.ping"), "control");
    assert.equal(registry.resolve("control.listInstances"), "control");
    assert.equal(registry.resolve("instance.callTool"), "instance");
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
        controlRouter.route({
            id: "req-1",
            method: "control.ping",
            target: { instance: "alpha", kind: "instance" },
            type: "request"
        }),
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

    const controlResult = (await controlRouter.route({
        id: "req-1",
        method: "control.ping",
        target: { kind: "control" },
        type: "request"
    })) as { pong: boolean };

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

void (0 as unknown as WorkerInstance);
