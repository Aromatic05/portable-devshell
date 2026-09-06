import assert from "node:assert/strict";
import test from "node:test";

import type {
    DebugPatchSummary,
    PrefixRouteContext,
} from "@portable-devshell/shared";

import {
    createDebugRouteModule,
    type DebugPatchPort,
} from "../../src/control/debug/DebugRouteModule.ts";

function context(
    peer: "cli" | "tui" | "web",
    subjectKind: string,
): PrefixRouteContext {
    return {
        connectionId: "conn-1",
        peer,
        requestId: "req-1",
        subject: { id: "subject-1", kind: subjectKind },
    } as PrefixRouteContext;
}

function patch(): DebugPatchSummary {
    return {
        invocationCount: 0,
        loadedAt: "2026-09-06T00:00:00.000Z",
        patchId: "debug-1",
        state: "active",
        target: "worker:demo-local",
    };
}

function port(): DebugPatchPort {
    return {
        listPatches: () => [patch()],
        listTargets: () => [{ methods: ["callTool"], target: "worker:demo-local" }],
        load: async () => patch(),
        release: () => patch(),
        unload: async () => ({ ...patch(), state: "unloaded" }),
    };
}

test("debug routes accept only local-owner CLI connections", async () => {
    const module = createDebugRouteModule(port());
    const targets = module.operations.find((operation) => operation.name === "targets");
    if (targets === undefined) throw new Error("debug.targets operation is missing");

    assert.deepEqual(
        await targets.handle({ id: "1", name: "targets" }, context("cli", "local-owner")),
        [{ methods: ["callTool"], target: "worker:demo-local" }],
    );
    await assert.rejects(
        async () => await targets.handle(
            { id: "2", name: "targets" },
            context("cli", "bearer"),
        ),
        /restricted to the local owner CLI/iu,
    );
    await assert.rejects(
        async () => await targets.handle(
            { id: "3", name: "targets" },
            context("web", "local-owner"),
        ),
        /restricted to the local owner CLI/iu,
    );
});

test("debug load forwards source only after local ownership is established", async () => {
    let received: unknown;
    const service = port();
    service.load = async (request) => {
        received = request;
        return patch();
    };
    const module = createDebugRouteModule(service);
    const load = module.operations.find((operation) => operation.name === "load");
    if (load === undefined) throw new Error("debug.load operation is missing");

    await load.handle(
        {
            id: "1",
            name: "load",
            payload: {
                name: "probe",
                scope: { ctxId: "ctx-own", toolName: "file_info" },
                source: "() => ({ action: 'continue' })",
                target: "worker:demo-local",
            },
        },
        context("cli", "local-owner"),
    );

    assert.deepEqual(received, {
        name: "probe",
        scope: { ctxId: "ctx-own", toolName: "file_info" },
        source: "() => ({ action: 'continue' })",
        target: "worker:demo-local",
    });
});
