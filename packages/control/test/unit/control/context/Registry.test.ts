import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ContextBinding } from "@portable-devshell/shared";

import { ContextRegistry } from "../../../../src/context/Registry/index.js";

test("creates an active Context without environment attachments", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-empty" });
    const record = await registry.create({ principal: "user-1" });
    assert.equal(record.status, "active");
    assert.deepEqual(record.environments, []);
});

test("rejects conflicting environments for the same instance before creating a Context", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-duplicate" });
    await assert.rejects(
        registry.create({
            principal: "user-1",
            environments: [
                { instance: "worker-a", workspace: "/work/a" },
                { instance: "worker-a", workspace: "/work/b" },
            ],
        }),
        /Invalid Context environments/u,
    );
    assert.deepEqual(await registry.list(), []);
});

test("rejects invalid environment values without creating a Context", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-invalid" });
    const invalidEnvironments: unknown[] = [
        null,
        [null],
        [{ instance: "" }],
        [{ instance: "worker-a", workspace: 1 }],
        [{ instance: "worker-a", temporaryDirectory: 1 }],
    ];
    for (const environments of invalidEnvironments) {
        await assert.rejects(
            registry.create({
                principal: "user-1",
                environments,
            } as ContextBinding),
            /Invalid Context environments/u,
        );
        assert.deepEqual(await registry.list(), []);
    }
});

test("rejects duplicate instances in a v2 document without silently selecting a workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "context-v2-duplicate-"));
    const filePath = join(directory, "contexts.json");
    const raw = JSON.stringify({
        contexts: [
            {
                ctxId: "ctx-duplicate",
                principal: "user-1",
                environments: [
                    { instance: "worker-a", workspace: "/work/a" },
                    { instance: "worker-a", workspace: "/work/b" },
                ],
                createdAt: "2026-01-01T00:00:00.000Z",
                lastAccessedAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
                status: "active",
            },
        ],
        version: 2,
    });
    await writeFile(filePath, raw);
    try {
        await assert.rejects(
            new ContextRegistry({ filePath }).initialize(),
            /Invalid MCP context registry record/u,
        );
        assert.equal(await readFile(filePath, "utf8"), raw);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("rejects duplicate v1 environment instances before rewriting the original document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "context-v1-duplicate-"));
    const filePath = join(directory, "contexts.json");
    const raw = JSON.stringify({
        contexts: [
            {
                ctxId: "ctx-duplicate",
                principal: "user-1",
                instance: "worker-a",
                workspace: "/work/a",
                environments: [
                    { instance: "worker-a", workspace: "/work/a" },
                    { instance: "worker-a", workspace: "/work/b" },
                ],
                createdAt: "2026-01-01T00:00:00.000Z",
                lastAccessedAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
                status: "active",
            },
        ],
        version: 1,
    });
    await writeFile(filePath, raw);
    try {
        await assert.rejects(
            new ContextRegistry({ filePath }).initialize(),
            /Invalid Context registry v1 environments/u,
        );
        assert.equal(await readFile(filePath, "utf8"), raw);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("detaching the last environment keeps the Context active and renewable", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-detach" });
    const record = await registry.create({
        principal: "user-1",
        environments: [{ instance: "worker-a", workspace: "/work/a" }],
    });
    const detached = await registry.detachEnvironment(record.ctxId, "worker-a");
    assert.equal(detached.status, "active");
    assert.deepEqual(detached.environments, []);
    assert.equal((await registry.renew(record.ctxId)).status, "active");
    const attached = await registry.attachEnvironment(record.ctxId, {
        instance: "worker-b",
        workspace: "/work/b",
    });
    assert.deepEqual(attached.environments, [
        { instance: "worker-b", workspace: "/work/b" },
    ]);
});

test("resolves and queries remote attachments by their own instance and workspace", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-remote" });
    const record = await registry.create({
        principal: "user-1",
        environments: [{ instance: "worker-a", workspace: "/work/a" }],
    });
    await registry.attachEnvironment(record.ctxId, {
        instance: "worker-b",
        workspace: "/work/b",
    });
    assert.deepEqual(
        await registry.resolveEnvironment(record.ctxId, "worker-b"),
        {
            instance: "worker-b",
            workspace: "/work/b",
        },
    );
    assert.equal(
        (await registry.list({ instance: "worker-a", workspace: "/work/b" }))
            .length,
        0,
    );
    assert.deepEqual(
        (
            await registry.list({
                instance: "worker-b",
                workspace: "/work/b",
                status: "active",
            })
        ).map(({ ctxId }) => ctxId),
        [record.ctxId],
    );
});

test("keeps remote references stable after attachment and allows masking", async () => {
    const registry = new ContextRegistry({
        idFactory: () => "ctx-stable-handle",
    });
    const record = await registry.create({
        principal: "user-1",
        environments: [{ instance: "worker-a", workspace: "/work/a" }],
    });
    const before = await registry.referenceInstance(record.ctxId, "worker-b");
    assert.equal(before?.current, false);
    assert.ok(before?.handle);
    await registry.attachEnvironment(record.ctxId, {
        instance: "worker-b",
        workspace: "/work/b",
    });
    const after = await registry.referenceInstance(record.ctxId, "worker-b");
    assert.deepEqual(after, before);
    assert.equal(
        await registry.resolveRemoteInstanceHandle(record.ctxId, before.handle),
        "worker-b",
    );
    const masked = await registry.maskRemoteInstance(
        record.ctxId,
        before.handle,
    );
    assert.deepEqual(masked, {
        environment: { instance: "worker-b", workspace: "/work/b" },
        instance: "worker-b",
    });
    assert.equal(
        await registry.referenceInstance(record.ctxId, "worker-b"),
        undefined,
    );
});

test("detaching an instance invalidates only its automatic reentry claim", async () => {
    const registry = new ContextRegistry({ idFactory: () => "ctx-claim" });
    const record = await registry.create({
        principal: "user-1",
        environments: [
            { instance: "worker-a", workspace: "/work/a" },
            { instance: "worker-b", workspace: "/work/b" },
        ],
    });
    await registry.reentry.claimAutomaticReentry(record.ctxId, "worker-a", "claim-a");
    await registry.detachInstance("worker-a");
    assert.deepEqual(
        await registry.reentry.listAutomaticReentryClaimsForInstance("worker-a"),
        [],
    );
    assert.deepEqual(
        (await registry.resolveEnvironment(record.ctxId, "worker-b"))
            ?.workspace,
        "/work/b",
    );
    assert.equal(
        (await registry.lookup(record.ctxId, { principal: "user-1" })).status,
        "active",
    );
});

test("instance detachment atomically persists cleanup for its removed workspace", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "context-detachment-debt-"));
    t.after(async () => await rm(directory, { force: true, recursive: true }));
    const filePath = join(directory, "contexts.json");
    const registry = new ContextRegistry({
        filePath,
        idFactory: () => "ctx-retired-scope",
    });
    await registry.initialize();
    const context = await registry.create({
        principal: "user",
        environments: [
            { instance: "removed", workspace: "/current" },
            { instance: "other", workspace: "/other" },
        ],
    });
    await registry.detachInstance("removed");
    assert.deepEqual(await registry.detachInstance("removed"), []);
    const restored = new ContextRegistry({ filePath });
    await restored.initialize();
    assert.deepEqual(
        (await restored.lookup(context.ctxId, { principal: "user" }))
            .environments,
        [{ instance: "other", workspace: "/other" }],
    );
    assert.deepEqual(await restored.listEnvironmentCleanup(), [
        {
            ctxId: context.ctxId,
            cleanup: { instance: "removed", kind: "instance_reference" },
        },
        {
            ctxId: context.ctxId,
            cleanup: {
                instance: "removed",
                kind: "alerts",
                workspace: "/current",
            },
        },
    ]);
});

test("migrates valid v1 records with explicit environments to v2", async () => {
    const directory = await mkdtemp(join(tmpdir(), "context-v1-"));
    const filePath = join(directory, "contexts.json");
    const legacy = {
        contexts: [
            {
                ctxId: "ctx-v1",
                principal: "user-1",
                instance: "worker-a",
                workspace: "/old",
                temporaryDirectory: "/tmp/old",
                environments: [{ instance: "worker-b", workspace: "/work/b" }],
                createdAt: "2026-01-01T00:00:00.000Z",
                lastAccessedAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
                status: "active",
                externalBindings: [{ kind: "old", value: "removed" }],
                externalSelector: { kind: "old", value: "removed" },
            },
        ],
        version: 1,
    };
    await writeFile(filePath, JSON.stringify(legacy));
    try {
        const registry = new ContextRegistry({ filePath });
        await registry.initialize();
        assert.deepEqual(
            (await registry.lookup("ctx-v1", { principal: "user-1" }))
                .environments,
            [{ instance: "worker-b", workspace: "/work/b" }],
        );
        const migrated = JSON.parse(await readFile(filePath, "utf8")) as Record<
            string,
            unknown
        >;
        assert.equal(migrated.version, 2);
        const [stored] = migrated.contexts as Array<Record<string, unknown>>;
        assert.equal("instance" in stored!, false);
        assert.equal("workspace" in stored!, false);
        assert.equal("temporaryDirectory" in stored!, false);
        assert.equal("externalSelector" in stored!, false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("fails closed on legacy external identity without canonical bindings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "context-v1-identity-"));
    const filePath = join(directory, "contexts.json");
    const legacy = {
        contexts: [
            {
                ctxId: "ctx-identity",
                principal: "user-1",
                instance: "worker-a",
                workspace: "/work/a",
                environments: [{ instance: "worker-a", workspace: "/work/a" }],
                createdAt: "2026-01-01T00:00:00.000Z",
                lastAccessedAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
                status: "active",
                openAiSessionId: "session-old",
            },
        ],
        version: 1,
    };
    const raw = JSON.stringify(legacy);
    await writeFile(filePath, raw);
    try {
        await assert.rejects(
            new ContextRegistry({ filePath }).initialize(),
            /migration needed/u,
        );
        assert.equal(await readFile(filePath, "utf8"), raw);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("leaves malformed v1 environment documents untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "context-v1-invalid-"));
    const filePath = join(directory, "contexts.json");
    const raw = JSON.stringify({
        contexts: [
            { ctxId: "ctx-bad", environments: [{ workspace: "/work" }] },
        ],
        version: 1,
    });
    await writeFile(filePath, raw);
    try {
        const registry = new ContextRegistry({ filePath });
        await assert.rejects(registry.initialize(), /environments/u);
        assert.equal(await readFile(filePath, "utf8"), raw);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
