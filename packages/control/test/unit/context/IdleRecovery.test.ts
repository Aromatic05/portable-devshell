import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

import { ContextRegistry } from "../../../src/context/registry/index.ts";
import { ContextCleanupService } from "../../../src/context/service/Cleanup.ts";
import { ContextEnvironmentService } from "../../../src/context/service/Scope.ts";
import { ContextService } from "../../../src/context/service/index.ts";

test("idle Context GC releases resources but a normal tool call restores its workspace", async (t) => {
    const directory = await createTestTempDirectory("context-idle-recover");
    const filePath = join(directory, "contexts.json");
    let now = 1_000;
    const registry = new ContextRegistry({ filePath, now: () => now, ttlMs: 100 });
    t.after(async () => {
        registry.close();
        await rm(directory, { recursive: true, force: true });
    });
    await registry.initialize();
    const retired: string[] = [];
    const released: string[] = [];
    const acquired: string[] = [];
    const prepared: string[] = [];
    const alerts: string[] = [];
    let prepareUnavailable = true;
    const workerEnvironment = (instance: string) => ({
        async releaseAlerts(workspace: string) { released.push(`alerts:${instance}:${workspace}`); },
        async touchAlerts(workspace: string) { alerts.push(`${instance}:${workspace}`); return { advice: [] }; },
        async touchTemporaryDirectory() {
            throw Object.assign(new Error("collected temporary directory"), {
                code: "workspace.temporaryUnavailable",
            });
        },
        async prepareWorkspace(workspace: string) {
            prepared.push(`${instance}:${workspace}`);
            if (prepareUnavailable) {
                prepareUnavailable = false;
                throw new Error("Worker environment temporarily unavailable");
            }
            return { workspace, temporaryDirectory: `/${instance}/new-temporary` };
        },
    }) as never;
    const runtime = (instance: string) => ({
        async releaseReference(ctxId: string) { released.push(`reference:${instance}:${ctxId}`); },
        async acquireReference(ctxId: string) { acquired.push(`${instance}:${ctxId}`); return {}; },
    }) as never;
    const leaseInstance = () => ({ release() {} });
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        environmentRetired: async (event) => { retired.push(event.ctxId); },
        environment: workerEnvironment,
        runtime,
    });
    const environment = new ContextEnvironmentService({
        contextRegistry: registry,
        cleanup,
        environment: workerEnvironment,
        leaseInstance,
        runtime,
    });
    const service = new ContextService({
        registry,
        cleanup,
        environment,
        environmentTransport: workerEnvironment,
        leaseInstance,
        process: () => ({}) as never,
    });
    const created = await registry.create({
        principal: "owner",
        environments: [
            {
                instance: "worker-a",
                workspace: "/workspace",
                temporaryDirectory: "/collected-temporary",
            },
            {
                instance: "worker-b",
                workspace: "/secondary",
                temporaryDirectory: "/collected-secondary",
            },
        ],
    });

    now = 1_101;
    await cleanup.reconcile();
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).contexts.length, 0);
    assert.deepEqual(retired, []);
    assert.deepEqual(released.sort(), [
        `reference:worker-a:${created.ctxId}`, "alerts:worker-a:/workspace",
        `reference:worker-b:${created.ctxId}`, "alerts:worker-b:/secondary",
    ].sort());
    assert.equal((await registry.lookup(created.ctxId, { principal: "owner" })).status, "expired");
    assert.equal((await registry.resolveEnvironment(created.ctxId, "worker-a"))?.temporaryDirectory, undefined);

    await assert.rejects(service.resolve({
        ctxId: created.ctxId,
        instance: "worker-a",
        principal: "owner",
        touch: true,
    }), /temporarily unavailable/u);
    assert.equal(released.filter((entry) => entry === `reference:worker-a:${created.ctxId}`).length, 2);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).contexts.length, 0);
    assert.equal((await registry.lookup(created.ctxId, { principal: "owner" })).status, "expired");

    const restored = await service.resolve({
        ctxId: created.ctxId,
        instance: "worker-a",
        principal: "owner",
        touch: true,
    });
    assert.equal(restored.status, "active");
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).contexts[0]?.ctxId, created.ctxId);
    assert.equal(restored.environments[0]?.workspace, "/workspace");
    assert.deepEqual(acquired, [`worker-a:${created.ctxId}`, `worker-a:${created.ctxId}`]);
    assert.deepEqual(prepared, ["worker-a:/workspace", "worker-a:/workspace"]);
    assert.equal((await registry.resolveEnvironment(created.ctxId, "worker-a"))?.temporaryDirectory, "/worker-a/new-temporary");
    assert.equal((await registry.resolveEnvironment(created.ctxId, "worker-b"))?.temporaryDirectory, undefined);

    const secondary = await service.resolve({
        ctxId: created.ctxId,
        instance: "worker-b",
        principal: "owner",
        touch: true,
    });
    assert.equal(secondary.status, "active");
    assert.equal(secondary.environments[1]?.workspace, "/secondary");
    assert.equal((await registry.resolveEnvironment(created.ctxId, "worker-b"))?.temporaryDirectory, "/worker-b/new-temporary");
    assert.deepEqual(acquired, [
        `worker-a:${created.ctxId}`, `worker-a:${created.ctxId}`, `worker-b:${created.ctxId}`,
    ]);
    assert.deepEqual(prepared, ["worker-a:/workspace", "worker-a:/workspace", "worker-b:/secondary"]);
    assert.deepEqual(alerts, ["worker-a:/workspace", "worker-b:/secondary"]);
    assert.deepEqual(await registry.listCleanupPending(), []);
});

test("disk GC retains Context authority and workspace across restart", async () => {
    const directory = await createTestTempDirectory("context-idle-disk-gc");
    const filePath = join(directory, "contexts.json");
    let now = 1_000;
    try {
        const registry = new ContextRegistry({
            filePath,
            idFactory: () => "ctx-durable-idle",
            maxTerminalContexts: 0,
            now: () => now,
            ttlMs: 100,
        });
        await registry.initialize();
        const context = await registry.create({
            principal: "owner",
            environments: [{ instance: "worker-a", workspace: "/workspace", temporaryDirectory: "/ephemeral" }],
        });
        now = 1_101;
        assert.equal((await registry.listCleanupPending()).length, 1);
        await registry.settleCleanup(context.ctxId);

        const document = JSON.parse(await readFile(filePath, "utf8"));
        assert.equal(document.contexts.length, 0, "collected Context records must leave contexts.json");
        assert.equal((await registry.list())[0]?.ctxId, context.ctxId);
        registry.close();

        const reopened = new ContextRegistry({ filePath, maxTerminalContexts: 0, now: () => now, ttlMs: 100 });
        await reopened.initialize();
        const restored = await reopened.renewForPrincipal(context.ctxId, { principal: "owner" });
        assert.equal(restored.status, "active");
        assert.equal(restored.ctxId, context.ctxId);
        assert.equal(restored.environments[0]?.workspace, "/workspace");
        reopened.close();
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});


test("collected external Context identity survives restart and can be rebound", async () => {
    const directory = await createTestTempDirectory("context-cold-external");
    const filePath = join(directory, "contexts.json");
    const external = { kind: "openai/session", value: "original-session" };
    let now = 1_000;
    try {
        const original = new ContextRegistry({ filePath, now: () => now, ttlMs: 100 });
        await original.initialize();
        const first = await original.create({ principal: "owner", environments: [{ instance: "alpha" }] });
        await original.attachEnvironment(first.ctxId, { instance: "alpha", workspace: "/project" }, {
            bindings: [external], principal: "owner",
        });
        now = 1_101;
        assert.equal((await original.listCleanupPending()).length, 1);
        await original.settleCleanup(first.ctxId);
        assert.equal((await original.lookupExternal(external, { principal: "other" })), undefined);
        original.close();

        const reopened = new ContextRegistry({ filePath, now: () => now, ttlMs: 100 });
        await reopened.initialize();
        assert.equal((await reopened.lookupExternal(external, { principal: "owner" }))?.ctxId, first.ctxId);
        const next = await reopened.create({ principal: "owner", environments: [{ instance: "alpha" }] });
        await reopened.attachEnvironment(next.ctxId, { instance: "alpha", workspace: "/new-project" }, {
            bindings: [external], principal: "owner",
        });
        assert.equal((await reopened.lookupExternal(external, { principal: "owner" }))?.ctxId, next.ctxId);
        reopened.close();

        const final = new ContextRegistry({ filePath, now: () => now, ttlMs: 100 });
        await final.initialize();
        assert.equal((await final.lookupExternal(external, { principal: "owner" }))?.ctxId, next.ctxId);
        assert.equal((await final.lookup(first.ctxId, { principal: "owner" })).environments[0]?.workspace, "/project");
        final.close();
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("collected Context preserves masks and removes archived remote handles on Instance deletion", async () => {
    const directory = await createTestTempDirectory("context-cold-instance");
    const filePath = join(directory, "contexts.json");
    let now = 1_000;
    try {
        const registry = new ContextRegistry({ filePath, now: () => now, ttlMs: 100 });
        await registry.initialize();
        const ctx = await registry.create({ principal: "owner", environments: [{ instance: "alpha", workspace: "/project" }] });
        const deleted = await registry.referenceInstance(ctx.ctxId, "removed");
        const masked = await registry.referenceInstance(ctx.ctxId, "masked");
        assert.ok(deleted?.handle);
        assert.ok(masked?.handle);
        await registry.maskRemoteInstance(ctx.ctxId, masked.handle);
        now = 1_101;
        await registry.listCleanupPending();
        await registry.settleCleanup(ctx.ctxId);
        registry.close();

        const reopened = new ContextRegistry({ filePath, now: () => now, ttlMs: 100 });
        await reopened.initialize();
        assert.equal((await reopened.detachInstance("removed")).length, 1);
        await assert.rejects(reopened.resolveRemoteInstanceHandle(ctx.ctxId, deleted.handle), { code: "mcp.contextInvalid" });
        await assert.rejects(reopened.assertInstanceAvailable(ctx.ctxId, "masked"), { code: "mcp.contextInstanceMasked" });
        reopened.close();
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
test("failed recovery release keeps retryable Worker cleanup debt", async (t) => {
    const directory = await createTestTempDirectory("context-recovery-cleanup-debt");
    const filePath = join(directory, "contexts.json");
    let now = 1_000;
    let releaseUnavailable = false;
    let releases = 0;
    const registry = new ContextRegistry({ filePath, now: () => now, ttlMs: 100 });
    t.after(async () => {
        registry.close();
        await rm(directory, { recursive: true, force: true });
    });
    await registry.initialize();
    const workerEnvironment = () => ({
        async releaseAlerts() {},
        async prepareWorkspace() { throw new Error("Workspace preparation failed"); },
    }) as never;
    const runtime = () => ({
        async acquireReference() { return {}; },
        async releaseReference() {
            releases++;
            if (releaseUnavailable) throw new Error("Reference release failed");
        },
    }) as never;
    const cleanup = new ContextCleanupService({
        contextRegistry: registry,
        environment: workerEnvironment,
        runtime,
    });
    const leaseInstance = () => ({ release() {} });
    const environment = new ContextEnvironmentService({
        contextRegistry: registry, cleanup,
        environment: workerEnvironment, runtime, leaseInstance,
    });
    const service = new ContextService({
        registry, cleanup, environment, leaseInstance,
        environmentTransport: workerEnvironment,
        process: () => ({}) as never,
    });
    const created = await registry.create({
        principal: "owner",
        environments: [{ instance: "worker", workspace: "/project" }],
    });
    now = 1_101;
    await cleanup.reconcile();
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).contexts.length, 0);

    releaseUnavailable = true;
    await assert.rejects(
        service.resolve({ ctxId: created.ctxId, instance: "worker", principal: "owner", touch: true }),
        /Worker reference could not be released/u,
    );
    assert.deepEqual(await registry.listEnvironmentCleanup(), [{
        ctxId: created.ctxId,
        cleanup: { instance: "worker", kind: "instance_reference" },
    }]);

    releaseUnavailable = false;
    await cleanup.reconcile();
    assert.deepEqual(await registry.listEnvironmentCleanup(), []);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).contexts.length, 0);
    assert.equal((await registry.lookup(created.ctxId, { principal: "owner" })).status, "expired");
    assert.equal(releases, 3);
});
