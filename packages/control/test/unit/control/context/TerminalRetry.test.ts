import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createContextRuntime } from "../../../../src/context/index.ts";
import type { ContextEnvironmentRetiredEvent } from "../../../../src/context/Api.ts";

for (const reason of ["disabled", "expired"] as const) {
    test(`${reason} retirement retains failed attachment debt across restart without replaying successful attachments`, async (t) => {
        let now = Date.now();
        t.mock.method(Date, "now", () => now);
        const root = await mkdtemp(join(tmpdir(), "context-terminal-retry-"));
        t.after(async () => await rm(root, { recursive: true, force: true }));
        const contextFile = join(root, "contexts.json");
        const events: ContextEnvironmentRetiredEvent[] = [];
        let failing = true;
        const options = {
            contextFile,
            environment: () => ({ releaseAlerts: async () => {} }) as never,
            leaseInstance: () => ({ release() {} }),
            process: () => ({ snapshot: async () => ({ snapshot: { ready: false } }) }) as never,
            runtime: () => ({ releaseReference: async () => {} }) as never,
            environmentRetired: async (event: ContextEnvironmentRetiredEvent) => {
                events.push(event);
                if (failing && event.instance === "beta") throw new Error("notification unavailable");
            },
        };
        const runtime = createContextRuntime(options);
        await runtime.initialize();
        const record = await runtime.api.registry.create({ principal: "test", environments: [{ instance: "alpha" }, { instance: "beta" }] });
        await runtime.api.renew(record.ctxId);
        assert.deepEqual(events, []);
        if (reason === "expired") now = Date.parse(record.expiresAt) + 1;
        if (reason === "disabled")
            await assert.rejects(runtime.api.disable(record.ctxId), /cleanup was incomplete/u);
        else {
            const warnings: unknown[] = [];
            t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
            await runtime.reconcile();
            assert.ok(warnings.length > 0);
        }
        const stored = JSON.parse(await readFile(contextFile, "utf8")).contexts[0];
        assert.equal(stored.cleanupPending, true);
        assert.deepEqual(stored.retiredEnvironmentInstances, ["alpha"]);
        assert.equal((await runtime.api.registry.listCleanupPending()).length, 1);
        if (reason === "expired") await assert.rejects(runtime.api.renew(record.ctxId));
        runtime.close();
        failing = false;
        const restarted = createContextRuntime(options);
        await restarted.initialize();
        await restarted.reconcile();
        await restarted.reconcile();
        if (reason === "disabled") await restarted.api.disable(record.ctxId);
        assert.deepEqual(events, ["alpha", "beta", "beta"].map((instance) => ({ ctxId: record.ctxId, instance, reason })));
        assert.deepEqual(await restarted.api.registry.listCleanupPending(), []);
        assert.equal(JSON.parse(await readFile(contextFile, "utf8")).contexts[0].cleanupPending, false);
        if (reason === "expired") {
            await restarted.api.renew(record.ctxId);
            assert.equal(events.length, 3);
            await restarted.api.disable(record.ctxId);
            assert.deepEqual(events.slice(3), ["alpha", "beta"].map((instance) => ({ ctxId: record.ctxId, instance, reason: "disabled" })));
        }
        restarted.close();
    });
}
