import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionContextObserveCapabilityControl } from "../../../../../src/extension/capability/Context.ts";

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

test("Context observe capability exposes a narrow read-only projection with filters", async () => {
    const forwarded: Array<{
        instance?: string;
        status?: string;
        workspace?: string;
    }> = [];
    const capability = new ExtensionContextObserveCapabilityControl({
        allowed: true,
        extensionId: "recall",
        listContexts: async (query) => {
            forwarded.push(query);
            return contexts.filter((record) => {
                if (
                    query.status !== undefined &&
                    record.status !== query.status
                )
                    return false;
                return record.environments.some(
                    (environment) =>
                        (query.instance === undefined ||
                            environment.instance === query.instance) &&
                        (query.workspace === undefined ||
                            environment.workspace === query.workspace),
                );
            });
        },
    });

    // Observation is read-only: there is no create/update/delete surface to mutate Context.
    assert.deepEqual(
        Object.getOwnPropertyNames(Object.getPrototypeOf(capability)).sort(),
        ["constructor", "list"],
    );

    assert.deepEqual(await capability.list({ workspace: "/repo/b" }), [
        {
            createdAt: "2026-10-01T00:00:00.000Z",
            ctxId: "ctx-1",
            environments: [
                { instance: "local", workspace: "/repo/a" },
                { instance: "remote", workspace: "/repo/b" },
            ],
            expiresAt: "2026-10-02T00:00:00.000Z",
            lastAccessedAt: "2026-10-01T01:00:00.000Z",
            status: "active",
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

    // Host-private fields never cross the observation boundary.
    const [projected] = await capability.list({ status: "active" });
    assert.ok(projected);
    assert.equal("principal" in projected, false);
    assert.equal("temporaryDirectory" in projected, false);
    assert.deepEqual(forwarded, [
        { workspace: "/repo/b" },
        { instance: "remote" },
        { status: "expired" },
        { status: "active" },
    ]);
});

test("Context observe capability rejects undeclared access", async () => {
    const capability = new ExtensionContextObserveCapabilityControl({
        allowed: false,
        extensionId: "example",
        listContexts: async () => contexts,
    });

    await assert.rejects(
        capability.list(),
        /did not declare the context\.observe capability/u,
    );
});
