import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionContextRuntimeCapabilityControl } from "../../../../../src/control/extension/generation/capability/Context.ts";

const contexts = [
    {
        createdAt: "2026-10-01T00:00:00.000Z",
        ctxId: "ctx-1",
        environments: [
            {
                instance: "local",
                temporaryDirectory: "/tmp/ctx-1",
                workspace: "/repo/a",
            },
            { instance: "remote", workspace: "/repo/b" },
        ],
        expiresAt: "2026-10-02T00:00:00.000Z",
        instance: "local",
        lastAccessedAt: "2026-10-01T01:00:00.000Z",
        principal: "secret-principal",
        status: "active" as const,
        temporaryDirectory: "/tmp/ctx-1",
        workspace: "/repo/a",
    },
    {
        createdAt: "2026-09-30T00:00:00.000Z",
        ctxId: "ctx-2",
        environments: [{ instance: "local", workspace: "/repo/c" }],
        expiresAt: "2026-10-01T00:00:00.000Z",
        instance: "local",
        lastAccessedAt: "2026-09-30T01:00:00.000Z",
        principal: "other-principal",
        status: "expired" as const,
        workspace: "/repo/c",
    },
];

test("Context runtime capability exposes a narrow read-only projection with filters", async () => {
    const capability = new ExtensionContextRuntimeCapabilityControl({
        allowed: true,
        extensionId: "recall",
        listContexts: async () => contexts,
    });

    assert.deepEqual(await capability.list({ workspace: "/repo/b" }), [
        {
            createdAt: "2026-10-01T00:00:00.000Z",
            ctxId: "ctx-1",
            environments: [
                { instance: "local", workspace: "/repo/a" },
                { instance: "remote", workspace: "/repo/b" },
            ],
            expiresAt: "2026-10-02T00:00:00.000Z",
            instance: "local",
            lastAccessedAt: "2026-10-01T01:00:00.000Z",
            status: "active",
            workspace: "/repo/a",
        },
    ]);
    assert.deepEqual(
        (await capability.list({ instance: "remote" })).map(
            (record) => record.ctxId,
        ),
        ["ctx-1"],
    );
    assert.deepEqual(
        (await capability.list({ status: "expired" })).map(
            (record) => record.ctxId,
        ),
        ["ctx-2"],
    );
});

test("Context runtime capability rejects undeclared access", async () => {
    const capability = new ExtensionContextRuntimeCapabilityControl({
        allowed: false,
        extensionId: "example",
        listContexts: async () => contexts,
    });

    await assert.rejects(capability.list(), /did not declare the contextRuntime capability/u);
});
