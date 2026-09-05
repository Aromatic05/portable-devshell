import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { McpContextRegistry, McpEndpointWorker, McpHost, McpNativeToolResult } from "@portable-devshell/mcp/testing";
import type { JsonValue, ToolCallContext, ToolDefinition } from "@portable-devshell/shared";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

function structuredResult<T>(result: JsonValue | McpNativeToolResult): T {
    return (result instanceof McpNativeToolResult ? result.structuredContent : result) as T;
}

const bashRun: ToolDefinition = {
    description: "Run a shell command.",
    group: "bash",
    inputSchema: {
        additionalProperties: false,
        properties: { command: { type: "string" } },
        required: ["command"],
        type: "object"
    },
    name: "bash_run",
    outputSchema: { type: "object" },
    requiredCapabilities: ["execute"]
};

test("McpContextRegistry persists active contexts and renews their sliding expiry", async () => {
    const root = await createTestTempDirectory("context");
    const filePath = join(root, "contexts.json");
    let now = Date.parse("2026-07-15T00:00:00.000Z");

    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => "ctx-persisted",
            now: () => now,
            ttlMs: 60_000
        });
        await registry.initialize();
        const created = await registry.create({
            instance: "demo-local",
            principal: "local",
            workspace: "/workspace"
        });
        assert.equal(created.ctxId, "ctx-persisted");
        assert.equal(created.expiresAt, "2026-07-15T00:01:00.000Z");
        await registry.attachEnvironment(created.ctxId, {
            instance: "remote-server",
            temporaryDirectory: "/tmp/remote-context",
            workspace: "/remote-workspace"
        });

        now += 30_000;
        const renewed = await registry.validateAndTouch("ctx-persisted", {
            principal: "local"
        });
        assert.equal(renewed.expiresAt, "2026-07-15T00:01:30.000Z");

        const reloaded = new McpContextRegistry({ filePath, now: () => now, ttlMs: 60_000 });
        await reloaded.initialize();
        assert.equal(
            (await reloaded.validateAndTouch("ctx-persisted", {
                principal: "local"
            })).ctxId,
            "ctx-persisted"
        );
        const remote = await reloaded.validateForInstance("ctx-persisted", "remote-server");
        assert.equal(
            remote.environments.find((environment) => environment.instance === "remote-server")?.workspace,
            "/remote-workspace"
        );
        assert.match(await readFile(filePath, "utf8"), /ctx-persisted/u);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry batches sliding lease persistence until the durable lease reaches half TTL", async () => {
    const root = await createTestTempDirectory("context-touch-batch-");
    const filePath = join(root, "contexts.json");
    let now = 0;
    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => "ctx-touch-batch",
            now: () => now,
            ttlMs: 60_000,
        });
        await registry.initialize();
        await registry.create({ instance: "alpha", principal: "subject", workspace: "/workspace" });

        now = 10_000;
        assert.equal(
            (await registry.validateAndTouch("ctx-touch-batch", { principal: "subject" })).expiresAt,
            "1970-01-01T00:01:10.000Z",
        );
        assert.equal(
            JSON.parse(await readFile(filePath, "utf8")).contexts[0].expiresAt,
            "1970-01-01T00:01:00.000Z",
        );

        now = 31_000;
        await registry.validateAndTouch("ctx-touch-batch", { principal: "subject" });
        assert.equal(
            JSON.parse(await readFile(filePath, "utf8")).contexts[0].expiresAt,
            "1970-01-01T00:01:31.000Z",
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry persists detached instance environments across restart", async () => {
    const root = await createTestTempDirectory("context-detach-instance");
    const filePath = join(root, "contexts.json");
    const ids = ["ctx-single-env", "ctx-multi-env"];
    try {
        const registry = new McpContextRegistry({ filePath, idFactory: () => ids.shift() ?? "ctx-unexpected" });
        await registry.initialize();
        const single = await registry.create({
            instance: "alpha",
            principal: "subject",
            workspace: "/alpha/single",
        });
        const multi = await registry.create({
            instance: "alpha",
            principal: "subject",
            workspace: "/alpha/multi",
        });
        await registry.attachEnvironment(multi.ctxId, {
            instance: "beta",
            workspace: "/beta/multi",
        });

        const detached = await registry.detachInstance("alpha");
        assert.deepEqual(detached.map((record) => record.ctxId).sort(), [multi.ctxId, single.ctxId].sort());

        const reloaded = new McpContextRegistry({ filePath });
        await reloaded.initialize();
        const singleAfter = await reloaded.lookup(single.ctxId, { principal: "subject" });
        assert.equal(singleAfter.status, "disabled");
        assert.deepEqual(singleAfter.environments, []);
        const multiAfter = await reloaded.lookup(multi.ctxId, { principal: "subject" });
        assert.equal(multiAfter.status, "active");
        assert.deepEqual(multiAfter.environments, [{
            instance: "beta",
            temporaryDirectory: undefined,
            workspace: "/beta/multi",
        }]);
        await assert.rejects(
            reloaded.validateForInstance(multi.ctxId, "alpha"),
            hasCode("mcp.contextInvalid"),
        );
        assert.equal((await reloaded.validateForInstance(multi.ctxId, "beta")).ctxId, multi.ctxId);
        assert.deepEqual(await reloaded.detachInstance("missing"), []);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry arbitrates one automatic re-entry and preserves explicit user yield", async () => {
    const root = await createTestTempDirectory("context-reentry");
    const filePath = join(root, "contexts.json");
    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => "ctx-reentry",
        });
        await registry.initialize();
        await registry.create({ instance: "demo-local", principal: "local", workspace: "/workspace" });

        const first = await registry.claimAutomaticReentry("ctx-reentry", "demo-local", "claim-1");
        assert.equal(first.claimed, true);
        assert.equal(first.state.pending, true);
        const second = await registry.claimAutomaticReentry("ctx-reentry", "demo-local", "claim-2");
        assert.equal(second.claimed, false);
        assert.equal((await registry.validateAutomaticReentry("ctx-reentry", "demo-local", "claim-1")).valid, true);

        await registry.clearAutomaticReentryClaim("ctx-reentry", "demo-local");
        assert.equal((await registry.readAutomaticReentry("ctx-reentry", "demo-local")).pending, false);
        await registry.suppressAutomaticReentry("ctx-reentry", "demo-local", "user action", "user_owned");
        const suppressed = await registry.readAutomaticReentry("ctx-reentry", "demo-local");
        assert.equal(typeof suppressed.suppressedAt, "string");
        assert.equal(suppressed.mode, "user_owned");
        await registry.clearAutomaticReentryClaim("ctx-reentry", "demo-local");
        assert.equal(typeof (await registry.readAutomaticReentry("ctx-reentry", "demo-local")).suppressedAt, "string");
        assert.equal((await registry.claimAutomaticReentry("ctx-reentry", "demo-local", "claim-3")).claimed, false);
        await registry.observeAutomaticReentryActivity("ctx-reentry", "demo-local", "observation");
        assert.equal((await registry.readAutomaticReentry("ctx-reentry", "demo-local")).mode, "user_owned");
        await registry.observeAutomaticReentryActivity("ctx-reentry", "demo-local", "mutation");
        assert.equal((await registry.readAutomaticReentry("ctx-reentry", "demo-local")).mode, "automatic");

        await registry.suppressAutomaticReentry("ctx-reentry", "demo-local", "goal paused", "paused");
        await registry.observeAutomaticReentryActivity("ctx-reentry", "demo-local", "mutation");
        assert.equal((await registry.readAutomaticReentry("ctx-reentry", "demo-local")).mode, "paused");
        assert.equal((await registry.claimAutomaticReentry("ctx-reentry", "demo-local", "claim-paused")).claimed, false);

        await registry.resumeAutomaticReentry("ctx-reentry", "demo-local");
        const resumed = await registry.claimAutomaticReentry("ctx-reentry", "demo-local", "claim-4");
        assert.equal(resumed.claimed, true);

        const reloaded = new McpContextRegistry({ filePath });
        await reloaded.initialize();
        assert.equal((await reloaded.readAutomaticReentry("ctx-reentry", "demo-local")).pending, true);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry binds re-entry ownership to one instance and exposes only that owner's claim", async () => {
    const root = await createTestTempDirectory("context-reentry-instance-owner");
    const filePath = join(root, "contexts.json");
    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => "ctx-reentry-owner",
        });
        await registry.initialize();
        await registry.create({ instance: "alpha", principal: "local", workspace: "/alpha" });
        await registry.attachEnvironment("ctx-reentry-owner", { instance: "beta", workspace: "/beta" });

        const claimed = await registry.claimAutomaticReentry("ctx-reentry-owner", "alpha", "claim-alpha");
        assert.equal(claimed.claimed, true);
        await registry.bindAutomaticReentrySource("ctx-reentry-owner", "alpha", "claim-alpha", "wait", "wait-alpha");
        assert.equal((await registry.validateAutomaticReentry("ctx-reentry-owner", "beta", "claim-alpha")).valid, false);
        assert.equal((await registry.listAutomaticReentryClaimsForInstance("beta")).length, 0);
        assert.equal((await registry.readAutomaticReentry("ctx-reentry-owner", "alpha")).pending, true);

        const owned = await registry.listAutomaticReentryClaimsForInstance("alpha");
        assert.deepEqual(owned, [{
            attempted: false,
            claimId: "claim-alpha",
            ctxId: "ctx-reentry-owner",
            sourceId: "wait-alpha",
            sourceKind: "wait",
        }]);
        await registry.markAutomaticReentryRejected("ctx-reentry-owner", "alpha", "claim-alpha");
        const after = await registry.readAutomaticReentry("ctx-reentry-owner", "alpha");
        assert.equal(after.pending, false);
        assert.equal(after.attempted, false);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry drops legacy re-entry claims that have no instance owner", async () => {
    const root = await createTestTempDirectory("context-reentry-legacy-owner");
    const filePath = join(root, "contexts.json");
    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => "ctx-reentry-legacy-owner",
        });
        await registry.initialize();
        await registry.create({ instance: "demo-local", principal: "local", workspace: "/workspace" });
        await registry.claimAutomaticReentry("ctx-reentry-legacy-owner", "demo-local", "claim-legacy");
        await registry.bindAutomaticReentrySource(
            "ctx-reentry-legacy-owner",
            "demo-local",
            "claim-legacy",
            "wait",
            "wait-legacy",
        );
        await registry.markAutomaticReentryAttempted("ctx-reentry-legacy-owner", "demo-local", "claim-legacy");

        const document = JSON.parse(await readFile(filePath, "utf8")) as { contexts?: Array<Record<string, unknown>> };
        assert.equal(document.contexts?.length, 1);
        delete document.contexts?.[0]?.automaticReentryInstance;
        await writeFile(filePath, `${JSON.stringify(document)}\n`);

        const reloaded = new McpContextRegistry({ filePath });
        await reloaded.initialize();
        const state = await reloaded.readAutomaticReentry("ctx-reentry-legacy-owner", "demo-local");
        assert.equal(state.pending, false);
        assert.equal(state.attempted, false);
        assert.equal(state.sourceId, undefined);
        assert.equal(state.sourceKind, undefined);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry execution lease fences automatic re-entry across tool activity and accepted delivery", async () => {
    const root = await createTestTempDirectory("context-execution-lease");
    const filePath = join(root, "contexts.json");
    let now = Date.parse("2026-09-03T00:00:00.000Z");
    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => "ctx-execution",
            now: () => now,
        });
        await registry.initialize();
        await registry.create({ instance: "demo-local", principal: "local", workspace: "/workspace" });

        assert.equal((await registry.readAutomaticReentry("ctx-execution", "demo-local")).executionActive, false);
        assert.equal((await registry.claimAutomaticReentry("ctx-execution", "demo-local", "claim-before-tool")).claimed, true);

        const active = await registry.observeExecutionActivity("ctx-execution", "demo-local");
        assert.equal(active.executionActive, true);
        assert.equal(active.executionEpoch, 1);
        assert.equal(active.pending, false);
        assert.equal((await registry.validateAutomaticReentry("ctx-execution", "demo-local", "claim-before-tool")).valid, false);
        assert.equal((await registry.claimAutomaticReentry("ctx-execution", "demo-local", "claim-during-tool")).claimed, false);

        now += 60_001;
        assert.equal((await registry.readAutomaticReentry("ctx-execution", "demo-local")).executionActive, false);
        assert.equal((await registry.claimAutomaticReentry("ctx-execution", "demo-local", "claim-after-idle")).claimed, true);
        const delivered = await registry.markAutomaticReentryAccepted("ctx-execution", "demo-local", "claim-after-idle");
        assert.equal(delivered.executionActive, true);
        assert.equal(delivered.executionEpoch, 2);
        assert.equal(delivered.pending, false);

        const reloaded = new McpContextRegistry({ filePath, now: () => now });
        await reloaded.initialize();
        assert.equal((await reloaded.readAutomaticReentry("ctx-execution", "demo-local")).executionActive, true);
        assert.equal((await reloaded.claimAutomaticReentry("ctx-execution", "demo-local", "claim-after-reload")).claimed, false);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry releases only the execution lease owned by the expected epoch", async () => {
    const root = await createTestTempDirectory("context-execution-release");
    const filePath = join(root, "contexts.json");
    const now = Date.parse("2026-09-03T01:00:00.000Z");
    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => "ctx-execution-release",
            now: () => now,
        });
        await registry.initialize();
        await registry.create({ instance: "demo-local", principal: "local", workspace: "/workspace" });

        const first = await registry.observeExecutionActivity("ctx-execution-release", "demo-local");
        assert.equal(first.executionEpoch, 1);
        assert.equal(first.executionActive, true);
        const staleBefore = await registry.releaseExecutionActivity("ctx-execution-release", "demo-local", 0);
        assert.equal(staleBefore.executionEpoch, 1);
        assert.equal(staleBefore.executionActive, true);

        const second = await registry.observeExecutionActivity("ctx-execution-release", "demo-local");
        assert.equal(second.executionEpoch, 2);
        const staleAfter = await registry.releaseExecutionActivity("ctx-execution-release", "demo-local", 1);
        assert.equal(staleAfter.executionEpoch, 2);
        assert.equal(staleAfter.executionActive, true);

        const released = await registry.releaseExecutionActivity("ctx-execution-release", "demo-local", 2);
        assert.equal(released.executionEpoch, 3);
        assert.equal(released.executionActive, false);

        const reloaded = new McpContextRegistry({ filePath, now: () => now });
        await reloaded.initialize();
        const persisted = await reloaded.readAutomaticReentry("ctx-execution-release", "demo-local");
        assert.equal(persisted.executionEpoch, 3);
        assert.equal(persisted.executionActive, false);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry attempted delivery survives claim TTL and execution activity until it is settled", async () => {
    const root = await createTestTempDirectory("context-attempted-reentry-fence");
    const filePath = join(root, "contexts.json");
    let now = Date.parse("2026-09-03T02:00:00.000Z");
    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => "ctx-attempted",
            now: () => now,
        });
        await registry.initialize();
        await registry.create({ instance: "demo-local", principal: "local", workspace: "/workspace" });
        assert.equal((await registry.claimAutomaticReentry("ctx-attempted", "demo-local", "claim-attempted")).claimed, true);
        await registry.bindAutomaticReentrySource(
            "ctx-attempted",
            "demo-local",
            "claim-attempted",
            "task-resume",
            "task-1",
        );
        const attempted = await registry.markAutomaticReentryAttempted("ctx-attempted", "demo-local", "claim-attempted");
        assert.equal(attempted.attempted, true);
        assert.equal(attempted.sourceKind, "task-resume");

        now += 10 * 60_000;
        const afterTtl = await registry.readAutomaticReentry("ctx-attempted", "demo-local");
        assert.equal(afterTtl.pending, true);
        assert.equal(afterTtl.attempted, true);
        assert.equal((await registry.claimAutomaticReentry("ctx-attempted", "demo-local", "claim-replay")).claimed, false);

        const active = await registry.observeExecutionActivity("ctx-attempted", "demo-local");
        assert.equal(active.executionActive, true);
        assert.equal(active.attempted, true);
        assert.equal(active.claimId, "claim-attempted");
        assert.equal(active.sourceId, "task-1");
        assert.equal((await registry.claimAutomaticReentry("ctx-attempted", "demo-local", "claim-during-execution")).claimed, false);

        const settled = await registry.markAutomaticReentryAccepted("ctx-attempted", "demo-local", "claim-attempted");
        assert.equal(settled.attempted, false);
        assert.equal(settled.pending, false);
        assert.equal(settled.sourceKind, undefined);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry keeps external bindings private and does not retire the previous Context", async () => {
    const root = await createTestTempDirectory("context-external-selector");
    const filePath = join(root, "contexts.json");
    const ids = ["ctx-session-old", "ctx-session-current"];
    const selector = { kind: "test/session", value: "chat-session-1" };
    let index = 0;

    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => ids[index++]!
        });
        await registry.initialize();
        const oldContext = await registry.create({
            instance: "demo-local",
            principal: "subject-1",
            workspace: "/old"
        });
        await registry.bindExternal(oldContext.ctxId, selector, { principal: "subject-1" });
        assert.equal(
            (await registry.resolveExternal(selector, { principal: "subject-1" })).ctxId,
            oldContext.ctxId
        );
        assert.equal("externalSelector" in (await registry.list())[0]!, false);

        const current = await registry.create({
            instance: "demo-local",
            principal: "subject-1",
            workspace: "/current"
        });
        await registry.bindExternal(current.ctxId, selector, { principal: "subject-1" });
        assert.equal(
            (await registry.resolveExternal(selector, { principal: "subject-1" })).ctxId,
            current.ctxId
        );
        const publicContexts = await registry.list();
        assert.equal(publicContexts.find(({ ctxId }) => ctxId === oldContext.ctxId)?.status, "active");
        assert.equal(publicContexts.some((record) => "externalBindings" in record), false);
        await assert.rejects(
            registry.resolveExternal(selector, { principal: "subject-2" }),
            hasCode("mcp.contextInvalid")
        );

        const reloaded = new McpContextRegistry({ filePath });
        await reloaded.initialize();
        assert.equal(
            (await reloaded.resolveExternal(selector, { principal: "subject-1" })).ctxId,
            current.ctxId
        );
        assert.match(await readFile(filePath, "utf8"), /test\/session/u);
        assert.match(await readFile(filePath, "utf8"), /chat-session-1/u);
        assert.equal((await reloaded.list()).some((record) => "externalBindings" in record), false);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry migrates persisted OpenAI session selectors to generic external bindings", async () => {
    const root = await createTestTempDirectory("context-legacy-openai-selector");
    const filePath = join(root, "contexts.json");
    try {
        await writeFile(filePath, JSON.stringify({
            contexts: [{
                createdAt: "2026-08-19T00:00:00.000Z",
                ctxId: "ctx-legacy-session",
                environments: [{ instance: "demo-local", workspace: "/workspace" }],
                expiresAt: "2026-08-21T00:00:00.000Z",
                instance: "demo-local",
                lastAccessedAt: "2026-08-19T00:00:00.000Z",
                openAiSessionId: "chat-session-legacy",
                principal: "subject-1",
                status: "active",
                workspace: "/workspace"
            }],
            version: 1
        }));
        const registry = new McpContextRegistry({
            filePath,
            now: () => Date.parse("2026-08-20T00:00:00.000Z")
        });
        await registry.initialize();
        const selected = await registry.resolveExternal(
            { kind: "openai/session", value: "chat-session-legacy" },
            { principal: "subject-1" }
        );
        assert.equal(selected.ctxId, "ctx-legacy-session");
        assert.equal("externalSelector" in (await registry.list())[0]!, false);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry rejects malformed legacy external bindings instead of silently dropping them", async () => {
    const root = await createTestTempDirectory("context-malformed-legacy-binding");
    const filePath = join(root, "contexts.json");
    try {
        await writeFile(filePath, JSON.stringify({
            contexts: [{
                createdAt: "2026-08-19T00:00:00.000Z",
                ctxId: "ctx-malformed-session",
                environments: [{ instance: "demo-local", workspace: "/workspace" }],
                expiresAt: "2026-08-21T00:00:00.000Z",
                externalSelector: { kind: "openai/session", value: "" },
                instance: "demo-local",
                lastAccessedAt: "2026-08-19T00:00:00.000Z",
                principal: "subject-1",
                status: "active",
                workspace: "/workspace"
            }],
            version: 1
        }));
        const registry = new McpContextRegistry({
            filePath,
            now: () => Date.parse("2026-08-20T00:00:00.000Z")
        });
        await registry.initialize();
        assert.deepEqual(await registry.list(), []);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry rolls back in-memory mutations when persistence fails", async () => {
    const root = await createTestTempDirectory("context-persist-failure");
    const binding = {
        instance: "demo-local",
        principal: "local",
        workspace: "/workspace",
    };

    try {
        const createPath = join(root, "create-contexts.json");
        const createRegistry = new McpContextRegistry({
            filePath: createPath,
            idFactory: () => "ctx-create-failure",
        });
        await createRegistry.initialize();
        await mkdir(createPath);

        await assert.rejects(createRegistry.create(binding));
        assert.deepEqual(await createRegistry.list(), []);

        const updatePath = join(root, "update-contexts.json");
        const updateRegistry = new McpContextRegistry({
            filePath: updatePath,
            idFactory: () => "ctx-update-failure",
        });
        await updateRegistry.initialize();
        await updateRegistry.create(binding);
        await rm(updatePath, { force: true });
        await mkdir(updatePath);

        await assert.rejects(updateRegistry.disable("ctx-update-failure"));
        const listed = await updateRegistry.list();
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.ctxId, "ctx-update-failure");
        assert.equal(listed[0]?.status, "active");
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry distinguishes invalid and expired ctxId values", async () => {
    let now = 1_000;
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-expiring",
        now: () => now,
        ttlMs: 100
    });
    await registry.initialize();
    const binding = { instance: "demo-local", principal: "local", workspace: "/workspace" };
    await registry.create(binding);

    await assert.rejects(registry.validateAndTouch("ctx-missing", binding), hasCode("mcp.contextInvalid"));
    await assert.rejects(
        registry.validateAndTouch("ctx-expiring", { ...binding, principal: "other" }),
        hasCode("mcp.contextInvalid")
    );

    now = 1_050;
    const passive = await registry.validate("ctx-expiring", binding);
    assert.equal(passive.expiresAt, "1970-01-01T00:00:01.100Z");
    now = 1_101;
    await assert.rejects(registry.validate("ctx-expiring", binding), hasCode("mcp.contextExpired"));
    await assert.rejects(registry.validateAndTouch("ctx-expiring", binding), hasCode("mcp.contextExpired"));
    await assert.rejects(registry.validateAndTouch("ctx-expiring", binding), hasCode("mcp.contextExpired"));
});

test("McpContextRegistry validates attached instances without binding ctxId authority to one instance", async () => {
    let now = Date.parse("2026-08-13T00:00:00.000Z");
    const registry = new McpContextRegistry({ idFactory: () => "ctx-comment", now: () => now, ttlMs: 60_000 });
    await registry.initialize();
    const created = await registry.create({
        instance: "alpha",
        principal: "client-alpha",
        workspace: "/workspace/alpha",
    });

    now += 10_000;
    const validated = await registry.validateForInstance(created.ctxId, "alpha");
    assert.equal(validated.expiresAt, created.expiresAt);
    await assert.rejects(
        registry.validateForInstance(created.ctxId, "beta"),
        hasCode("mcp.contextInvalid"),
    );
    await registry.attachEnvironment(created.ctxId, { instance: "beta" });
    const attached = await registry.validateForInstance(created.ctxId, "beta");
    assert.equal(attached.ctxId, created.ctxId);
    assert.equal(attached.expiresAt, created.expiresAt);

    await registry.disable(created.ctxId);
    await assert.rejects(
        registry.validateForInstance(created.ctxId, "alpha"),
        hasCode("mcp.contextDisabled"),
    );
});

test("McpContextRegistry lists contexts and supports manual disable and renew", async () => {
    const now = 1_000;
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-managed",
        now: () => now,
        ttlMs: 100
    });
    await registry.initialize();
    const binding = { instance: "demo-local", principal: "local", workspace: "/workspace" };
    await registry.create(binding);

    const listed = await registry.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.ctxId, "ctx-managed");
    assert.equal(listed[0]?.status, "active");

    const renewed = await registry.renew("ctx-managed");
    assert.equal(renewed.status, "active");
    assert.equal(renewed.expiresAt, "1970-01-01T00:00:01.100Z");

    const disabled = await registry.disable("ctx-managed");
    assert.equal(disabled.status, "disabled");
    await assert.rejects(
        registry.validateAndTouch("ctx-managed", binding),
        hasCode("mcp.contextDisabled")
    );
    await assert.rejects(registry.renew("ctx-managed"), hasCode("mcp.contextDisabled"));
    assert.equal((await registry.list())[0]?.status, "disabled");
});

test("McpContextRegistry bounds terminal history without evicting active contexts and persists the compacted state", async () => {
    const root = await createTestTempDirectory("context-terminal-history");
    const filePath = join(root, "contexts.json");
    let now = Date.parse("2026-08-13T00:00:00.000Z");
    const ids = ["ctx-active", "ctx-old-1", "ctx-old-2", "ctx-old-3"];
    let index = 0;
    const binding = { instance: "demo-local", principal: "local", workspace: "/workspace" };

    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => ids[index++]!,
            maxTerminalContexts: 2,
            now: () => now,
            ttlMs: 60_000
        });
        await registry.initialize();
        await registry.create(binding);
        for (const ctxId of ids.slice(1)) {
            now += 1;
            await registry.create(binding);
            await registry.disable(ctxId);
        }

        assert.deepEqual(
            (await registry.list()).map(({ ctxId, status }) => [ctxId, status]),
            [
                ["ctx-active", "active"],
                ["ctx-old-2", "disabled"],
                ["ctx-old-3", "disabled"]
            ]
        );

        const reloaded = new McpContextRegistry({ filePath, maxTerminalContexts: 2, now: () => now, ttlMs: 60_000 });
        await reloaded.initialize();
        assert.deepEqual(
            (await reloaded.list()).map(({ ctxId }) => ctxId),
            ["ctx-active", "ctx-old-2", "ctx-old-3"]
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpHost context admin releases alerts only after the last workspace context is disabled", async () => {
    const released: string[] = [];
    const releasedReferences: string[] = [];
    const stoppedGoals: string[] = [];
    const cancelledWaits: string[] = [];
    const consumedWaits: string[] = [];
    const cancelledApprovals: string[] = [];
    const failedContextMessages: string[] = [];
    const waits: Array<Record<string, unknown>> = [];
    const approvals: Array<Record<string, unknown>> = [];
    const touched: string[] = [];
    const host = new McpHost({
        instances: [{
            gateway: {
                async goalContinuation() { return {}; },
                async manageGoal(_instance: string, input: { action: string }, ctxId: string) {
                    if (input.action === "stop") stoppedGoals.push(ctxId);
                    return undefined;
                },
                async readGoal(_instance: string, ctxId: string) {
                    return {
                        autoContinueExhausted: false,
                        continuationCount: 0,
                        continuationDue: false,
                        continuationDueAt: "2099-01-01T00:00:00.000Z",
                        continuationPending: false,
                        createdAt: "2026-08-20T00:00:00.000Z",
                        goalId: `goal-${ctxId}`,
                        lastAgentActivityAt: "2026-08-20T00:00:00.000Z",
                        maxContinuations: 10,
                        objective: "Context Goal",
                        revision: 1,
                        status: "active",
                        steps: [{ id: "work", status: "active", text: "Work" }],
                        updatedAt: "2026-08-20T00:00:00.000Z",
                    };
                },
                async releaseInstanceReference(instance: string, reference: string) {
                    releasedReferences.push(`${instance}:${reference}`);
                },
                async listWaits() { return waits; },
                async cancelWait(_instance: string, waitId: string) {
                    cancelledWaits.push(waitId);
                    const wait = waits.find((entry) => entry.waitId === waitId)!;
                    wait.status = "cancelled";
                    return wait;
                },
                async consumeWait(_instance: string, waitId: string) {
                    consumedWaits.push(waitId);
                    const wait = waits.find((entry) => entry.waitId === waitId)!;
                    wait.status = "consumed";
                    return wait;
                },
                async failContextMessages(_instance: string, ctxId: string, reason: string) {
                    assert.match(reason, /disabled before Comment delivery/u);
                    failedContextMessages.push(ctxId);
                    return [];
                },
                async listApprovals() { return approvals; },
                async cancelApproval(_instance: string, approvalId: string, reason?: string) {
                    assert.match(reason ?? "", /Context .* was disabled/u);
                    cancelledApprovals.push(approvalId);
                    const approval = approvals.find((entry) => entry.approvalId === approvalId)!;
                    approval.status = "cancelled";
                    return approval;
                }
            } as never,
            name: "demo-local",
            policy: { capabilities: [], groups: [] },
            worker: {
                async releaseAlerts(workspace: string) { released.push(workspace); },
                snapshot: () => ({ ready: true }),
                async touchAlerts(workspace: string) { touched.push(workspace); },
            } as never,
        }],
        listenHost: "127.0.0.1",
        listenPort: 0,
    });
    await host.contextRegistry.initialize();
    const first = await host.contextRegistry.create({
        instance: "demo-local",
        principal: "local",
        workspace: "/projects/alpha",
    });
    const second = await host.contextRegistry.create({
        instance: "demo-local",
        principal: "local",
        workspace: "/projects/alpha",
    });
    waits.push(
        { createdByCtxId: first.ctxId, status: "waiting", waitId: "wait-first-live" },
        { createdByCtxId: first.ctxId, status: "resolved", waitId: "wait-first-resolved" },
        { createdByCtxId: second.ctxId, status: "waiting", waitId: "wait-second-live" },
    );
    approvals.push(
        { approvalId: "approval-first-pending", ctxId: first.ctxId, status: "pending" },
        { approvalId: "approval-first-done", ctxId: first.ctxId, status: "approved" },
        { approvalId: "approval-second-pending", ctxId: second.ctxId, status: "pending" },
    );

    await host.contextAdmin.disable(first.ctxId);
    assert.deepEqual(stoppedGoals, [first.ctxId]);
    assert.deepEqual(cancelledWaits, ["wait-first-live"]);
    assert.deepEqual(consumedWaits, ["wait-first-resolved"]);
    assert.deepEqual(cancelledApprovals, ["approval-first-pending"]);
    assert.deepEqual(failedContextMessages, [first.ctxId]);
    assert.deepEqual(released, []);
    assert.deepEqual(releasedReferences, [`demo-local:${first.ctxId}`]);
    await host.contextAdmin.disable(second.ctxId);
    assert.deepEqual(stoppedGoals, [first.ctxId, second.ctxId]);
    assert.deepEqual(cancelledWaits, ["wait-first-live", "wait-second-live"]);
    assert.deepEqual(consumedWaits, ["wait-first-resolved"]);
    assert.deepEqual(cancelledApprovals, ["approval-first-pending", "approval-second-pending"]);
    assert.deepEqual(failedContextMessages, [first.ctxId, second.ctxId]);
    assert.deepEqual(released, ["/projects/alpha"]);
    assert.deepEqual(releasedReferences, [
        `demo-local:${first.ctxId}`,
        `demo-local:${second.ctxId}`
    ]);

    const renewed = await host.contextRegistry.create({
        instance: "demo-local",
        principal: "local",
        workspace: "/projects/beta",
    });
    await host.contextAdmin.renew(renewed.ctxId);
    assert.deepEqual(touched, ["/projects/beta"]);
});

test("McpEndpointWorker exposes Context tools while explicit mode still requires a resolvable Context at runtime", async () => {
    let now = 1_000;
    const registry = new McpContextRegistry({ idFactory: () => "ctx-created", now: () => now, ttlMs: 100 });
    await registry.initialize();
    const calls: Array<{ context: ToolCallContext; input: JsonValue; toolName: string }> = [];
    const preparedTemporaryDirectories: string[] = [];
    const touchedAlertWorkspaces: string[] = [];
    const touchedTemporaryDirectories: string[] = [];
    let temporaryTouchError: Error | undefined;
    const endpoint = new McpEndpointWorker({
        contextRegistry: registry,
        instanceName: "demo-local",
        policy: { capabilities: ["execute"], groups: ["bash"] },
        worker: {
            async auditToolCall<T extends JsonValue>(
                _toolName: string,
                _input: JsonValue,
                _context: ToolCallContext,
                operation: (callId: string) => Promise<T>
            ): Promise<T> { return await operation("call-test"); },
            async appendMcpSessionClosed() {},
            async appendMcpSessionOpened() {},
            async appendMcpToolCalled() {},
            async callTool(toolName, input, context) {
                calls.push({ context, input, toolName });
                return { ok: true };
            },
            handshake: {
                homeDirectory: "/home/demo",
                instance: "demo-local",
                skillsDirectory: "/home/demo/.devshell/skill",
                platform: {
                    arch: "x86_64",
                    distribution: { id: "arch", name: "Arch Linux", version: "rolling" },
                    os: "linux",
                    packageManager: "pacman",
                    shell: { executable: "/bin/bash", kind: "bash", version: "5.3" }
                }
            },
            listTools: () => [bashRun],
            async prepareWorkspace(workspace) {
                const temporaryDirectory = preparedTemporaryDirectories.length === 0
                    ? "/tmp/demo-local-123456"
                    : "/tmp/demo-local-rebound";
                preparedTemporaryDirectories.push(temporaryDirectory);
                return {
                    projectMemoryAgentFile: `${workspace}/.memory/AGENT.md`,
                    projectMemoryDirectory: `${workspace}/.memory`,
                    projectMemoryPresent: false,
                    temporaryDirectory,
                    workspace
                };
            },
            async readAlerts() {
                return { advice: [{ code: "worker.memory.high", text: "Worker memory is high." }] };
            },
            async touchAlerts(workspace) {
                touchedAlertWorkspaces.push(workspace);
            },
            async touchTemporaryDirectory(path) {
                touchedTemporaryDirectories.push(path);
                if (temporaryTouchError !== undefined) {
                    throw temporaryTouchError;
                }
            },
            snapshot: () => ({ ready: true })
        }
    });

    const tools = endpoint.listTools();
    const bashTool = tools.find((tool) => tool.name === "bash_run");
    const environmentTool = tools.find((tool) => tool.name === "environ_info");
    const bashSchema = bashTool?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    assert.ok(bashSchema.properties?.ctxId);
    assert.equal(bashTool?.title, "Run shell command");
    assert.equal(environmentTool?.title, "Create environment");
    assert.equal((environmentTool?._meta as Record<string, unknown> | undefined)?.["openai/outputTemplate"], undefined);
    assert.deepEqual(bashTool?.annotations, {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
    });
    assert.deepEqual(environmentTool?.annotations, {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
    });
    assert.equal(bashSchema.required?.includes("ctxId"), true);
    assert.equal(bashSchema.required?.includes("command"), true);
    assert.equal(tools.find((tool) => tool.name === "context_acquire"), undefined);
    assert.equal(tools.find((tool) => tool.name === "context_renew"), undefined);

    const environment = await endpoint.callTool(
        "environ_info",
        { workspace: "/projects/alpha" },
        { principal: "local", requestId: "env" }
    );
    const environmentRecord = structuredResult<Record<string, JsonValue>>(environment);
    assert.equal(environmentRecord.ctxId, "ctx-created");
    assert.equal(typeof environmentRecord.expiresAt, "string");
    assert.equal(environmentRecord.instance, "demo-local");
    assert.equal(environmentRecord.skillsDirectory, "/home/demo/.devshell/skill");
    assert.equal(environmentRecord.workspace, "/projects/alpha");
    assert.equal("projectMemoryAgentFile" in environmentRecord, false);
    assert.equal("projectMemoryDirectory" in environmentRecord, false);
    assert.equal(environmentRecord.temporaryDirectory, "/tmp/demo-local-123456");
    assert.deepEqual(environmentRecord.comment, [
        "Use /tmp/demo-local-123456 for all temporary files.",
        "Worker memory is high."
    ]);
    assert.deepEqual(environmentRecord.platform, {
        arch: "x86_64",
        distribution: { id: "arch", name: "Arch Linux", version: "rolling" },
        os: "linux",
        packageManager: "pacman",
        shell: "bash"
    });

    await assert.rejects(
        endpoint.callTool("bash_run", { command: "pwd" }, { principal: "local", requestId: "missing" }),
        hasCode("mcp.contextInvalid")
    );
    await endpoint.callTool(
        "bash_run",
        { command: "pwd", ctxId: "ctx-created" },
        { principal: "local", requestId: "run" }
    );
    assert.deepEqual(calls, [
        {
            context: { ctxId: "ctx-created", requestId: "run", source: "mcp", workspace: "/projects/alpha" },
            input: { command: "pwd" },
            toolName: "bash_run"
        }
    ]);
    assert.deepEqual(touchedAlertWorkspaces, ["/projects/alpha"]);
    assert.deepEqual(touchedTemporaryDirectories, ["/tmp/demo-local-123456"]);

    now = 1_101;
    const renewed = await registry.renew("ctx-created");
    assert.equal(renewed.status, "active");
    temporaryTouchError = Object.assign(
        new Error("temporary directory no longer exists on this worker"),
        { code: "workspace.temporaryUnavailable" }
    );
    await endpoint.callTool(
        "bash_run",
        { command: "pwd", ctxId: "ctx-created" },
        { principal: "local", requestId: "rebound" }
    );
    assert.deepEqual(preparedTemporaryDirectories, ["/tmp/demo-local-123456", "/tmp/demo-local-rebound"]);
    assert.equal((await registry.list())[0]?.temporaryDirectory, "/tmp/demo-local-rebound");

    temporaryTouchError = undefined;
    await endpoint.callTool(
        "bash_run",
        { command: "pwd", ctxId: "ctx-created" },
        { principal: "local", requestId: "reused" }
    );
    assert.deepEqual(preparedTemporaryDirectories, ["/tmp/demo-local-123456", "/tmp/demo-local-rebound"]);
    assert.equal(touchedTemporaryDirectories.at(-1), "/tmp/demo-local-rebound");

    temporaryTouchError = Object.assign(new Error("worker rpc disconnected"), {
        code: "core.workerRpcDisconnected"
    });
    await assert.rejects(
        endpoint.callTool(
            "bash_run",
            { command: "pwd", ctxId: "ctx-created" },
            { principal: "local", requestId: "transport-failure" }
        ),
        /worker rpc disconnected/u
    );
    assert.deepEqual(preparedTemporaryDirectories, ["/tmp/demo-local-123456", "/tmp/demo-local-rebound"]);
});

function hasCode(expected: string): (error: unknown) => boolean {
    return (error: unknown) => {
        assert.equal((error as { code?: string }).code, expected);
        return true;
    };
}
