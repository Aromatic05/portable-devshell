import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createContextRuntime } from "../../../src/context/index.ts";
import { ContextService } from "../../../src/context/service/index.ts";
import { ContextCleanupService } from "../../../src/context/service/Cleanup.ts";

test("startup retains cleanup debt and permits Control to start when an Instance is absent", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devshell-context-cleanup-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const contextFile = join(root, "contexts.json");
    await writeFile(contextFile, JSON.stringify({
        version: 2,
        contexts: [{
            ctxId: "ctx-startup-deferred",
            principal: "test-principal",
            createdAt: "2026-09-01T00:00:00.000Z",
            lastAccessedAt: "2026-09-01T00:00:00.000Z",
            expiresAt: "2026-09-02T00:00:00.000Z",
            environments: [{ instance: "removed" }],
            status: "expired",
            cleanupPending: true,
            pendingEnvironmentCleanup: [{ kind: "instance_reference", instance: "removed" }],
        }],
    }));
    let available = false;
    let releaseCalls = 0;
    const runtime = createContextRuntime({
        contextFile,
        environment: () => ({}) as never,
        leaseInstance: () => ({ release() {} }),
        process: () => ({}) as never,
        runtime: () => ({
            async releaseReference() {
                releaseCalls++;
                if (!available) throw new Error("Instance removed is unavailable");
            },
        }) as never,
    });
    await runtime.initialize();
    const warning = console.warn;
    const reported: unknown[][] = [];
    console.warn = (...args: unknown[]) => { reported.push(args); };
    try {
        await runtime.reconcile();
        assert.ok(reported.length > 0, "Deferred cleanup must remain visible in diagnostics");
        assert.equal((await runtime.api.registry.listEnvironmentCleanup()).length, 1);
        assert.equal(JSON.parse(await readFile(contextFile, "utf8")).contexts[0].cleanupPending, true);
        await assert.rejects(runtime.api.reconcileInstance("removed"), /cleanup was incomplete/u);
        available = true;
        await runtime.api.reconcileInstance("removed");
        await runtime.reconcile();
        assert.deepEqual(await runtime.api.registry.listEnvironmentCleanup(), []);
        assert.ok(releaseCalls >= 2);
    } finally {
        console.warn = warning;
        runtime.close();
    }
});

test("startup does not hide non-cleanup storage errors", async () => {
    const failure = new Error("Context storage unavailable");
    const service = new ContextService({
        registry: {} as never,
        cleanup: { async reconcile() { throw failure; } } as never,
        environment: {} as never,
        environmentTransport: () => ({}) as never,
        leaseInstance: () => ({ release() {} }),
        process: () => ({}) as never,
    });
    await assert.rejects(service.reconcile(), (error) => error === failure);
});

test("Context startup defers a failed cleanup ledger read but scoped reconciliation reports it", async () => {
    const error = new Error("ledger read failed");
    const cleanup = new ContextCleanupService({
        contextRegistry: {
            async listCleanupPending() { return []; },
            async listEnvironmentCleanup() {
                return [{
                    ctxId: "ctx-broken-ledger",
                    cleanup: { kind: "instance_reference", instance: "remote" },
                }];
            },
            async list() { throw error; },
        } as never,
        environment: () => ({}) as never,
        runtime: () => ({}) as never,
    });
    const warning = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
        await cleanup.reconcile();
        assert.equal(warnings.length, 1);
        await assert.rejects(cleanup.reconcile("ctx-broken-ledger"), (thrown) => thrown === error);
    } finally {
        console.warn = warning;
    }
});
