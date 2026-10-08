import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ContextRegistry as McpContextRegistry } from "../../../control/src/context/registry/index.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("McpContextRegistry persists active contexts and renews their sliding expiry", async () => {
    const root = await createTestTempDirectory("context");
    const filePath = join(root, "contexts.json");
    let now = Date.parse("2026-07-15T00:00:00.000Z");

    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => "ctx-persisted",
            now: () => now,
            ttlMs: 60_000,
        });
        await registry.initialize();
        const created = await registry.create({
            environments: [
                {
                    instance: "demo-local",
                    workspace: "/workspace",
                },
            ],
            principal: "local",
        });
        assert.equal(created.ctxId, "ctx-persisted");
        assert.equal(created.expiresAt, "2026-07-15T00:01:00.000Z");
        await registry.attachEnvironment(created.ctxId, {
            instance: "remote-server",
            temporaryDirectory: "/tmp/remote-context",
            workspace: "/remote-workspace",
        });

        now += 30_000;
        const renewed = await registry.validateAndTouch("ctx-persisted", {
            principal: "local",
        });
        assert.equal(renewed.expiresAt, "2026-07-15T00:01:30.000Z");

        const reloaded = new McpContextRegistry({
            filePath,
            now: () => now,
            ttlMs: 60_000,
        });
        await reloaded.initialize();
        assert.equal(
            (
                await reloaded.validateAndTouch("ctx-persisted", {
                    principal: "local",
                })
            ).ctxId,
            "ctx-persisted",
        );
        const remote = await reloaded.validateForInstance(
            "ctx-persisted",
            "remote-server",
        );
        assert.equal(
            remote.environments.find(
                (environment) => environment.instance === "remote-server",
            )?.workspace,
            "/remote-workspace",
        );
        assert.match(await readFile(filePath, "utf8"), /ctx-persisted/u);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry keeps remote handles private and makes masking durable and irreversible", async () => {
    const root = await createTestTempDirectory("context-remote-mask");
    const filePath = join(root, "contexts.json");
    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => "ctx-remote-mask",
        });
        await registry.initialize();
        await registry.create({
            environments: [
                {
                    instance: "alpha",
                    workspace: "/alpha",
                },
            ],
            principal: "subject",
        });

        const currentReference = await registry.referenceInstance(
            "ctx-remote-mask",
            "alpha",
        );
        assert.equal(currentReference?.current, false);
        assert.match(currentReference?.handle ?? "", /^ih-/u);
        const first = await registry.referenceInstance(
            "ctx-remote-mask",
            "beta",
        );
        const second = await registry.referenceInstance(
            "ctx-remote-mask",
            "beta",
        );
        assert.equal(first?.current, false);
        assert.match(first?.handle ?? "", /^ih-/u);
        assert.deepEqual(second, first);
        const unused = await registry.referenceInstance(
            "ctx-remote-mask",
            "gamma",
        );
        assert.match(unused?.handle ?? "", /^ih-/u);
        await registry.detachInstance("gamma");
        await assert.rejects(
            registry.resolveRemoteInstanceHandle(
                "ctx-remote-mask",
                unused!.handle!,
            ),
            hasCode("mcp.contextInvalid"),
        );
        await registry.attachEnvironment("ctx-remote-mask", {
            instance: "beta",
            temporaryDirectory: "/tmp/beta",
            workspace: "/beta",
        });
        assert.equal(
            (await registry.validateForInstance("ctx-remote-mask", "beta"))
                .ctxId,
            "ctx-remote-mask",
        );

        const masked = await registry.maskRemoteInstance(
            "ctx-remote-mask",
            first!.handle!,
        );
        assert.deepEqual(masked, {
            environment: {
                instance: "beta",
                temporaryDirectory: "/tmp/beta",
                workspace: "/beta",
            },
            instance: "beta",
        });
        assert.equal(
            await registry.referenceInstance("ctx-remote-mask", "beta"),
            undefined,
        );
        await assert.rejects(
            registry.resolveRemoteInstanceHandle(
                "ctx-remote-mask",
                first!.handle!,
            ),
            hasCode("mcp.contextInstanceMasked"),
        );
        await assert.rejects(
            registry.validateForInstance("ctx-remote-mask", "beta"),
            hasCode("mcp.contextInstanceMasked"),
        );
        await assert.rejects(
            registry.attachEnvironment("ctx-remote-mask", {
                instance: "beta",
                workspace: "/beta",
            }),
            hasCode("mcp.contextInstanceMasked"),
        );
        const publicRecord = (await registry.list())[0]!;
        assert.equal("maskedInstances" in publicRecord, false);
        assert.equal("remoteInstanceHandles" in publicRecord, false);

        const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
            contexts?: Array<{
                maskedInstances?: string[];
                remoteInstanceHandles?: Array<{
                    handle: string;
                    instance: string;
                }>;
            }>;
        };
        assert.deepEqual(persisted.contexts?.[0]?.maskedInstances, ["beta"]);
        assert.deepEqual(persisted.contexts?.[0]?.remoteInstanceHandles, [
            { handle: currentReference!.handle!, instance: "alpha" },
            { handle: first!.handle!, instance: "beta" },
        ]);

        const reloaded = new McpContextRegistry({ filePath });
        await reloaded.initialize();
        assert.equal(
            await reloaded.referenceInstance("ctx-remote-mask", "beta"),
            undefined,
        );
        assert.deepEqual(
            await reloaded.maskRemoteInstance(
                "ctx-remote-mask",
                first!.handle!,
            ),
            { instance: "beta" },
        );
        await assert.rejects(
            reloaded.validateForInstance("ctx-remote-mask", "beta"),
            hasCode("mcp.contextInstanceMasked"),
        );
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
        await registry.create({
            environments: [
                {
                    instance: "alpha",
                    workspace: "/workspace",
                },
            ],
            principal: "subject",
        });

        now = 10_000;
        assert.equal(
            (
                await registry.validateAndTouch("ctx-touch-batch", {
                    principal: "subject",
                })
            ).expiresAt,
            "1970-01-01T00:01:10.000Z",
        );
        assert.equal(
            JSON.parse(await readFile(filePath, "utf8")).contexts[0].expiresAt,
            "1970-01-01T00:01:00.000Z",
        );

        now = 31_000;
        await registry.validateAndTouch("ctx-touch-batch", {
            principal: "subject",
        });
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
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => ids.shift() ?? "ctx-unexpected",
        });
        await registry.initialize();
        const single = await registry.create({
            environments: [
                {
                    instance: "alpha",
                    workspace: "/alpha/single",
                },
            ],
            principal: "subject",
        });
        const multi = await registry.create({
            environments: [
                {
                    instance: "alpha",
                    workspace: "/alpha/multi",
                },
            ],
            principal: "subject",
        });
        await registry.attachEnvironment(multi.ctxId, {
            instance: "beta",
            workspace: "/beta/multi",
        });

        const detached = await registry.detachInstance("alpha");
        assert.deepEqual(
            detached.map((record) => record.ctxId).sort(),
            [multi.ctxId, single.ctxId].sort(),
        );

        const reloaded = new McpContextRegistry({ filePath });
        await reloaded.initialize();
        const singleAfter = await reloaded.lookup(single.ctxId, {
            principal: "subject",
        });
        assert.equal(singleAfter.status, "active");
        assert.deepEqual(singleAfter.environments, []);
        const multiAfter = await reloaded.lookup(multi.ctxId, {
            principal: "subject",
        });
        assert.equal(multiAfter.status, "active");
        assert.deepEqual(multiAfter.environments, [
            {
                instance: "beta",
                workspace: "/beta/multi",
            },
        ]);
        await assert.rejects(
            reloaded.validateForInstance(multi.ctxId, "alpha"),
            hasCode("mcp.contextInvalid"),
        );
        assert.equal(
            (await reloaded.validateForInstance(multi.ctxId, "beta")).ctxId,
            multi.ctxId,
        );
        assert.deepEqual(await reloaded.detachInstance("missing"), []);
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
            idFactory: () => ids[index++]!,
        });
        await registry.initialize();
        const oldContext = await registry.create({
            environments: [
                {
                    instance: "demo-local",
                    workspace: "/old",
                },
            ],
            principal: "subject-1",
        });
        await registry.attachEnvironment(
            oldContext.ctxId,
            { instance: "demo-local", workspace: "/old" },
            { bindings: [selector], principal: "subject-1" },
        );
        assert.equal(
            (await registry.lookupExternal(selector, {
                principal: "subject-1",
            }))?.ctxId,
            oldContext.ctxId,
        );
        assert.equal("externalSelector" in (await registry.list())[0]!, false);

        const current = await registry.create({
            environments: [
                {
                    instance: "demo-local",
                    workspace: "/current",
                },
            ],
            principal: "subject-1",
        });
        await registry.attachEnvironment(
            current.ctxId,
            { instance: "demo-local", workspace: "/current" },
            { bindings: [selector], principal: "subject-1" },
        );
        assert.equal(
            (await registry.lookupExternal(selector, {
                principal: "subject-1",
            }))?.ctxId,
            current.ctxId,
        );
        const publicContexts = await registry.list();
        assert.equal(
            publicContexts.find(({ ctxId }) => ctxId === oldContext.ctxId)
                ?.status,
            "active",
        );
        assert.equal(
            publicContexts.some((record) => "externalBindings" in record),
            false,
        );
        assert.equal(
            await registry.lookupExternal(selector, { principal: "subject-2" }),
            undefined,
        );

        const reloaded = new McpContextRegistry({ filePath });
        await reloaded.initialize();
        assert.equal(
            (await reloaded.lookupExternal(selector, {
                principal: "subject-1",
            }))?.ctxId,
            current.ctxId,
        );
        assert.match(await readFile(filePath, "utf8"), /test\/session/u);
        assert.match(await readFile(filePath, "utf8"), /chat-session-1/u);
        assert.equal(
            (await reloaded.list()).some(
                (record) => "externalBindings" in record,
            ),
            false,
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry rejects legacy persisted external selectors that lack canonical bindings", async () => {
    const root = await createTestTempDirectory(
        "context-legacy-openai-selector",
    );
    const filePath = join(root, "contexts.json");
    try {
        await writeFile(
            filePath,
            JSON.stringify({
                contexts: [
                    {
                        createdAt: "2026-08-19T00:00:00.000Z",
                        ctxId: "ctx-legacy-session",
                        environments: [
                            { instance: "demo-local", workspace: "/workspace" },
                        ],
                        expiresAt: "2026-08-21T00:00:00.000Z",
                        instance: "demo-local",
                        lastAccessedAt: "2026-08-19T00:00:00.000Z",
                        openAiSessionId: "chat-session-legacy",
                        principal: "subject-1",
                        status: "active",
                        workspace: "/workspace",
                    },
                ],
                version: 1,
            }),
        );
        const registry = new McpContextRegistry({
            filePath,
            now: () => Date.parse("2026-08-20T00:00:00.000Z"),
        });
        await assert.rejects(
            registry.initialize(),
            /legacy external identity without canonical externalBindings/u,
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry fails closed for malformed legacy external selectors", async () => {
    const root = await createTestTempDirectory(
        "context-malformed-legacy-binding",
    );
    const filePath = join(root, "contexts.json");
    try {
        await writeFile(
            filePath,
            JSON.stringify({
                contexts: [
                    {
                        createdAt: "2026-08-19T00:00:00.000Z",
                        ctxId: "ctx-malformed-session",
                        environments: [
                            { instance: "demo-local", workspace: "/workspace" },
                        ],
                        expiresAt: "2026-08-21T00:00:00.000Z",
                        externalSelector: { kind: "openai/session", value: "" },
                        instance: "demo-local",
                        lastAccessedAt: "2026-08-19T00:00:00.000Z",
                        principal: "subject-1",
                        status: "active",
                        workspace: "/workspace",
                    },
                ],
                version: 1,
            }),
        );
        const registry = new McpContextRegistry({
            filePath,
            now: () => Date.parse("2026-08-20T00:00:00.000Z"),
        });
        await assert.rejects(
            registry.initialize(),
            /legacy external identity without canonical externalBindings/u,
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry rolls back in-memory mutations when persistence fails", async () => {
    const root = await createTestTempDirectory("context-persist-failure");
    const binding = {
        environments: [{ instance: "demo-local", workspace: "/workspace" }],
        principal: "local",
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

        const atomicPath = join(root, "atomic-environment-contexts.json");
        const atomicIds = ["ctx-atomic-old", "ctx-atomic-target"];
        let atomicIndex = 0;
        const atomicRegistry = new McpContextRegistry({
            filePath: atomicPath,
            idFactory: () => atomicIds[atomicIndex++]!,
        });
        await atomicRegistry.initialize();
        const old = await atomicRegistry.create({
            environments: [{ instance: "demo-local", workspace: "/old" }],
            principal: "local",
        });
        const external = {
            kind: "openai/session",
            value: "session-atomic-rollback",
        };
        await atomicRegistry.attachEnvironment(
            old.ctxId,
            { instance: "demo-local", workspace: "/old" },
            { bindings: [external], principal: "local" },
        );
        const target = await atomicRegistry.create({
            environments: [
                { instance: "demo-local", workspace: "/target-old" },
            ],
            principal: "local",
        });
        await rm(atomicPath, { force: true });
        await mkdir(atomicPath);

        await assert.rejects(
            atomicRegistry.attachEnvironment(
                target.ctxId,
                {
                    instance: "demo-local",
                    temporaryDirectory: "/tmp/target-new",
                    workspace: "/target-new",
                },
                {
                    bindings: [external],
                    principal: "local",
                },
            ),
        );
        assert.equal(
            (await atomicRegistry.list())
                .find(({ ctxId }) => ctxId === target.ctxId)
                ?.environments.find(({ instance }) => instance === "demo-local")
                ?.workspace,
            "/target-old",
        );
        assert.equal(
            (await atomicRegistry.lookupExternal(external, {
                principal: "local",
            }))?.ctxId,
            old.ctxId,
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry distinguishes invalid and expired ctxId values", async () => {
    let now = 1_000;
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-expiring",
        now: () => now,
        ttlMs: 100,
    });
    await registry.initialize();
    const binding = {
        environments: [{ instance: "demo-local", workspace: "/workspace" }],
        principal: "local",
    };
    await registry.create(binding);

    await assert.rejects(
        registry.validateAndTouch("ctx-missing", binding),
        hasCode("mcp.contextInvalid"),
    );
    await assert.rejects(
        registry.validateAndTouch("ctx-expiring", {
            ...binding,
            principal: "other",
        }),
        hasCode("mcp.contextInvalid"),
    );

    now = 1_050;
    const passive = await registry.validate("ctx-expiring", binding);
    assert.equal(passive.expiresAt, "1970-01-01T00:00:01.100Z");
    now = 1_101;
    await assert.rejects(
        registry.validate("ctx-expiring", binding),
        hasCode("mcp.contextExpired"),
    );
    await assert.rejects(
        registry.validateAndTouch("ctx-expiring", binding),
        hasCode("mcp.contextExpired"),
    );
    await assert.rejects(
        registry.validateAndTouch("ctx-expiring", binding),
        hasCode("mcp.contextExpired"),
    );
    assert.deepEqual(await registry.listCleanupPending(), []);
});

test("McpContextRegistry validates attached instances without binding ctxId authority to one instance", async () => {
    let now = Date.parse("2026-08-13T00:00:00.000Z");
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-comment",
        now: () => now,
        ttlMs: 60_000,
    });
    await registry.initialize();
    const created = await registry.create({
        environments: [
            {
                instance: "alpha",
                workspace: "/mcpapp/alpha",
            },
        ],
        principal: "client-alpha",
    });

    now += 10_000;
    const validated = await registry.validateForInstance(
        created.ctxId,
        "alpha",
    );
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
        ttlMs: 100,
    });
    await registry.initialize();
    const binding = {
        environments: [{ instance: "demo-local", workspace: "/workspace" }],
        principal: "local",
    };
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
        hasCode("mcp.contextDisabled"),
    );
    await assert.rejects(
        registry.renew("ctx-managed"),
        hasCode("mcp.contextDisabled"),
    );
    assert.equal((await registry.list())[0]?.status, "disabled");
});

test("McpContextRegistry bounds terminal history without evicting active contexts and persists the compacted state", async () => {
    const root = await createTestTempDirectory("context-terminal-history");
    const filePath = join(root, "contexts.json");
    let now = Date.parse("2026-08-13T00:00:00.000Z");
    const ids = ["ctx-active", "ctx-old-1", "ctx-old-2", "ctx-old-3"];
    let index = 0;
    const binding = {
        environments: [{ instance: "demo-local", workspace: "/workspace" }],
        principal: "local",
    };

    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => ids[index++]!,
            maxTerminalContexts: 2,
            now: () => now,
            ttlMs: 60_000,
        });
        await registry.initialize();
        await registry.create(binding);
        for (const ctxId of ids.slice(1)) {
            now += 1;
            await registry.create(binding);
            await registry.disable(ctxId);
            await registry.settleCleanup(ctxId);
        }

        assert.deepEqual(
            (await registry.list()).map(({ ctxId, status }) => [ctxId, status]),
            [
                ["ctx-active", "active"],
                ["ctx-old-2", "disabled"],
                ["ctx-old-3", "disabled"],
            ],
        );

        const reloaded = new McpContextRegistry({
            filePath,
            maxTerminalContexts: 2,
            now: () => now,
            ttlMs: 60_000,
        });
        await reloaded.initialize();
        assert.deepEqual(
            (await reloaded.list()).map(({ ctxId }) => ctxId),
            ["ctx-active", "ctx-old-2", "ctx-old-3"],
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry never compacts terminal Context cleanup debt", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-pending-terminal",
        maxTerminalContexts: 0,
    });
    await registry.initialize();
    await registry.create({
        environments: [
            {
                instance: "demo-local",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });

    await registry.disable("ctx-pending-terminal");
    assert.deepEqual(
        (await registry.list()).map(({ ctxId, status }) => [ctxId, status]),
        [["ctx-pending-terminal", "disabled"]],
    );
    assert.equal((await registry.listCleanupPending()).length, 1);

    await registry.settleCleanup("ctx-pending-terminal");
    assert.deepEqual(await registry.list(), []);
});

test("McpContextRegistry stages expired history eviction for cleanup before deletion", async () => {
    let now = 1_000;
    const ids = ["ctx-expired-old", "ctx-expired-new"];
    let index = 0;
    const registry = new McpContextRegistry({
        idFactory: () => ids[index++]!,
        maxTerminalContexts: 1,
        now: () => now,
        ttlMs: 10,
    });
    await registry.initialize();
    const binding = {
        environments: [{ instance: "demo-local", workspace: "/workspace" }],
        principal: "local",
    };
    await registry.create(binding);
    now = 1_011;
    await assert.rejects(
        registry.validateAndTouch("ctx-expired-old", binding),
        hasCode("mcp.contextExpired"),
    );
    await registry.create(binding);
    now = 1_022;
    await assert.rejects(
        registry.validateAndTouch("ctx-expired-new", binding),
        hasCode("mcp.contextExpired"),
    );

    assert.deepEqual(
        (await registry.list()).map(({ ctxId, status }) => [ctxId, status]),
        [
            ["ctx-expired-old", "expired"],
            ["ctx-expired-new", "expired"],
        ],
    );
    assert.deepEqual(
        (await registry.listCleanupPending()).map(({ ctxId }) => ctxId),
        ["ctx-expired-old"],
    );
    await assert.rejects(
        registry.renewForPrincipal("ctx-expired-old", { principal: "local" }),
        hasCode("mcp.contextExpired"),
    );

    await registry.settleCleanup("ctx-expired-old");
    assert.deepEqual(
        (await registry.list()).map(({ ctxId }) => ctxId),
        ["ctx-expired-new"],
    );
});

test("McpContextRegistry persists environment cleanup debt across workspace replacement and mask", async () => {
    const root = await createTestTempDirectory("context-environment-cleanup");
    const filePath = join(root, "contexts.json");
    try {
        const registry = new McpContextRegistry({
            filePath,
            idFactory: () => "ctx-environment-cleanup",
        });
        await registry.initialize();
        await registry.create({
            environments: [
                {
                    instance: "alpha",
                    workspace: "/alpha",
                },
            ],
            principal: "local",
        });
        const reference = await registry.referenceInstance(
            "ctx-environment-cleanup",
            "beta",
        );
        if (reference?.handle === undefined)
            throw new Error("expected remote instance handle");
        await registry.attachEnvironment("ctx-environment-cleanup", {
            instance: "beta",
            temporaryDirectory: "/tmp/beta-old",
            workspace: "/beta-old",
        });
        await registry.attachEnvironment("ctx-environment-cleanup", {
            instance: "beta",
            temporaryDirectory: "/tmp/beta-new",
            workspace: "/beta-new",
        });

        assert.deepEqual(await registry.listEnvironmentCleanup(), [
            {
                cleanup: {
                    instance: "beta",
                    kind: "alerts",
                    workspace: "/beta-old",
                },
                ctxId: "ctx-environment-cleanup",
            },
        ]);

        await registry.maskRemoteInstance(
            "ctx-environment-cleanup",
            reference.handle,
        );
        assert.deepEqual(await registry.listEnvironmentCleanup(), [
            {
                cleanup: {
                    instance: "beta",
                    kind: "alerts",
                    workspace: "/beta-old",
                },
                ctxId: "ctx-environment-cleanup",
            },
            {
                cleanup: {
                    instance: "beta",
                    kind: "instance_reference",
                },
                ctxId: "ctx-environment-cleanup",
            },
            {
                cleanup: {
                    instance: "beta",
                    kind: "alerts",
                    workspace: "/beta-new",
                },
                ctxId: "ctx-environment-cleanup",
            },
        ]);

        const reloaded = new McpContextRegistry({ filePath });
        await reloaded.initialize();
        const pending = await reloaded.listEnvironmentCleanup();
        assert.equal(pending.length, 3);
        for (const { cleanup } of pending) {
            await reloaded.settleEnvironmentCleanup(
                "ctx-environment-cleanup",
                cleanup,
            );
        }
        assert.deepEqual(await reloaded.listEnvironmentCleanup(), []);
        assert.equal(
            "pendingEnvironmentCleanup" in (await reloaded.list())[0]!,
            false,
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("McpContextRegistry detach preserves unresolved environment cleanup debt", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-detach-cleanup-debt",
    });
    await registry.initialize();
    await registry.create({
        environments: [
            {
                instance: "alpha",
                workspace: "/alpha",
            },
        ],
        principal: "local",
    });
    await registry.referenceInstance("ctx-detach-cleanup-debt", "beta");
    await registry.attachEnvironment("ctx-detach-cleanup-debt", {
        instance: "beta",
        temporaryDirectory: "/tmp/beta",
        workspace: "/beta",
    });
    await registry.recordEnvironmentCleanup("ctx-detach-cleanup-debt", {
        instance: "beta",
        kind: "instance_reference",
    });
    await registry.recordEnvironmentCleanup("ctx-detach-cleanup-debt", {
        instance: "beta",
        kind: "alerts",
        workspace: "/beta-old",
    });

    await registry.detachInstance("beta");

    assert.deepEqual(await registry.listEnvironmentCleanup(), [
        {
            cleanup: { instance: "beta", kind: "instance_reference" },
            ctxId: "ctx-detach-cleanup-debt",
        },
        {
            cleanup: {
                instance: "beta",
                kind: "alerts",
                workspace: "/beta-old",
            },
            ctxId: "ctx-detach-cleanup-debt",
        },
        {
            cleanup: {
                instance: "beta",
                kind: "alerts",
                workspace: "/beta",
            },
            ctxId: "ctx-detach-cleanup-debt",
        },
    ]);
    assert.deepEqual(
        (
            await registry.lookup("ctx-detach-cleanup-debt", {
                principal: "local",
            })
        ).environments.map((environment) => environment.instance),
        ["alpha"],
    );
});

test("McpContextRegistry fails closed on malformed persisted environment cleanup debt", async () => {
    const root = await createTestTempDirectory(
        "context-environment-cleanup-invalid",
    );
    const filePath = join(root, "contexts.json");
    try {
        await writeFile(
            filePath,
            JSON.stringify({
                contexts: [
                    {
                        createdAt: "2026-08-20T00:00:00.000Z",
                        ctxId: "ctx-cleanup-invalid",
                        environments: [
                            { instance: "alpha", workspace: "/alpha" },
                        ],
                        expiresAt: "2026-08-21T00:00:00.000Z",
                        instance: "alpha",
                        lastAccessedAt: "2026-08-20T00:00:00.000Z",
                        pendingEnvironmentCleanup: {
                            instance: "beta",
                            kind: "instance_reference",
                        },
                        principal: "local",
                        status: "active",
                        workspace: "/alpha",
                    },
                ],
                version: 1,
            }),
        );

        const registry = new McpContextRegistry({ filePath });
        await assert.rejects(registry.initialize());

        await writeFile(
            filePath,
            JSON.stringify({
                contexts: [
                    {
                        createdAt: "2026-08-20T00:00:00.000Z",
                        ctxId: "ctx-cleanup-invalid-record",
                        environments: [
                            { instance: "alpha", workspace: "/alpha" },
                        ],
                        expiresAt: "2026-08-21T00:00:00.000Z",
                        instance: "alpha",
                        lastAccessedAt: "2026-08-20T00:00:00.000Z",
                        pendingEnvironmentCleanup: [
                            {
                                instance: "beta",
                                kind: "instance_reference",
                            },
                        ],
                        principal: 7,
                        status: "active",
                        workspace: "/alpha",
                    },
                ],
                version: 1,
            }),
        );

        const malformedRecord = new McpContextRegistry({ filePath });
        await assert.rejects(malformedRecord.initialize());
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});


function hasCode(expected: string): (error: unknown) => boolean {
    return (error: unknown) => {
        assert.equal((error as { code?: string }).code, expected);
        return true;
    };
}
