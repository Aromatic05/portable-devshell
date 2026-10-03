import assert from "node:assert/strict";
import test from "node:test";

import type { ControlPortContext } from "@portable-devshell/shared";
import { asInstanceName } from "@portable-devshell/shared";
import { routes, type ControlRouteBinding } from "@portable-devshell/extension/control";

import { ControlExtensionRouteService } from "../../../../../../../src/extension/api/point/control/Dispatch.ts";

function context(): ControlPortContext {
    return {
        connectionId: "conn-1",
        host: asInstanceName("demo"),
        peer: "web",
        protocolVersion: "1.0.0",
        requestId: "req-1",
        signal: new AbortController().signal,
        afterReply() {},
        subject: { id: "subject-1", kind: "web-session" },
    } as ControlPortContext;
}

test("route dispatch preserves scope, request context, change notifications, and generation lease", async () => {
    const events: string[] = [];
    const binding: ControlRouteBinding = async (request, invocation) => {
        events.push(
            `invoke:${invocation.destination}:${invocation.peer}:${invocation.requestId}`,
        );
        return {
            payload: request.payload ?? null,
            subject: invocation.subject?.kind ?? null,
        };
    };
    let changed: (() => void) | undefined;
    const service = new ControlExtensionRouteService({
        acquireRegistration: async (pointId: string, id: string) => {
            assert.equal(pointId, routes.id);
            assert.equal(id, "comment-list");
            return {
                extensionId: "comment",
                lease: { release: () => events.push("release") },
                registration: { binding },
            } as never;
        },
        listDeclarations(pointId: string) {
            assert.equal(pointId, routes.id);
            return [
                {
                    declaration: {
                        id: "comment-list",
                        module: "contextMessage",
                        operation: "list",
                        scope: "instance",
                    },
                    extensionId: "comment",
                    generation: "g1",
                },
                {
                    declaration: {
                        id: "preferences-get",
                        module: "conversationPreferences",
                        operation: "get",
                        scope: "control",
                    },
                    extensionId: "comment",
                    generation: "g1",
                },
            ] as never;
        },
        onChange(listener: () => void) {
            changed = listener;
            return () => {
                changed = undefined;
            };
        },
    } as never);

    assert.deepEqual(
        service.modules("control").map((module) => module.name),
        ["conversationPreferences"],
    );
    const modules = service.modules("instance");
    assert.deepEqual(
        modules.map((module) => module.name),
        ["contextMessage"],
    );
    const list = modules[0]!.operations[0]!;
    assert.deepEqual(
        await list.handle(
            { id: "wire-1", name: "list", payload: { ctxId: "ctx-1" } },
            context(),
        ),
        { payload: { ctxId: "ctx-1" }, subject: "web-session" },
    );
    assert.deepEqual(events, ["invoke:demo:web:req-1", "release"]);

    let notifications = 0;
    const unsubscribe = service.onChange(() => {
        notifications += 1;
    });
    changed?.();
    assert.equal(notifications, 1);
    unsubscribe();
    assert.equal(changed, undefined);
});
