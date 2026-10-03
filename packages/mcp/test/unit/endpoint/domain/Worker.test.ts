import { asInstanceName } from "@portable-devshell/shared";
import {
    ToolCallPipeline,
    ToolCallHookSequence,
    type ToolCallHookValue,
} from "@portable-devshell/core";
import assert from "node:assert/strict";
import test from "node:test";

import type {
    JsonValue,
    ToolCallContext,
    ToolDefinition,
} from "@portable-devshell/shared";
import { type McpInstanceGateway } from "@portable-devshell/mcp/testing";
import { ContextRegistry as McpContextRegistry } from "../../../../../control/src/context/Registry/index.ts";
import {
    createTestContextEnvironment,
    TestMcpEndpointWorker as McpEndpointWorker,
} from "../../../ContextRuntime.ts";
import {
    withMcpContextId,
    withMcpInstanceTarget,
} from "../../../../src/endpoint/tool/Input.ts";

const bashTool: ToolDefinition = {
    requiredCapabilities: ["execute"],
    description: "Run a shell command.",
    group: "bash",
    inputSchema: {
        additionalProperties: false,
        properties: {
            command: { type: "string" },
        },
        required: ["command"],
        type: "object",
    },
    name: "bash_run",
    outputSchema: { type: "object" },
};

const fileReadTool: ToolDefinition = {
    requiredCapabilities: ["read"],
    description: "Read files.",
    group: "file",
    inputSchema: {
        additionalProperties: false,
        properties: { files: { type: "array" } },
        required: ["files"],
        type: "object",
    },
    name: "file_read",
    outputSchema: { type: "object" },
};

const context = { principal: "local", requestId: "request-1" } as const;
const contextRegistry = new McpContextRegistry({
    idFactory: () => "ctx-instance-test",
});
const activeContext = await contextRegistry.create({
    environments: [
        {
            instance: "main-pc",
            workspace: "/workspace",
        },
    ],
    principal: "local",
});
const withContext = <T extends Record<string, unknown>>(
    input: T,
): T & { ctxId: string } => ({
    ...input,
    ctxId: activeContext.ctxId,
});

test("instance attachment is absent from MCP while gateway routing remains available", () => {
    const worker = createWorker();
    const gateway = createGateway();
    const endpoint = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        worker,
    });
    const tools = endpoint.listTools();

    for (const name of [
        "instance_connect",
        "instance_list",
        "instance_status",
        "instance_create",
        "instance_stop",
    ]) {
        assert.equal(
            tools.some((tool) => tool.name === name),
            false,
            name,
        );
    }
    const remote = tools.find((tool) => tool.name === "environ_remote");
    assert.notEqual(remote, undefined);
    const remoteSchema = remote?.inputSchema as {
        anyOf?: unknown;
        oneOf?: unknown;
        properties?: Record<string, { enum?: unknown; type?: unknown }>;
        required?: string[];
        type?: unknown;
    };
    assert.equal(remoteSchema.type, "object");
    assert.equal(remoteSchema.anyOf, undefined);
    assert.equal(remoteSchema.oneOf, undefined);
    assert.equal(remoteSchema.properties?.command?.type, "string");
    assert.equal(remoteSchema.properties?.command?.enum, undefined);
    assert.deepEqual(remoteSchema.required, ["command", "ctxId"]);
    assert.notEqual(
        (
            tools.find((tool) => tool.name === "bash_run")?.inputSchema as {
                properties?: Record<string, unknown>;
            }
        ).properties?.instance,
        undefined,
    );
});

test("gateway-enabled endpoint augments worker schemas without exposing instance management tools", () => {
    const endpoint = createManagedEndpoint();
    const tools = endpoint.listTools();

    assert.notEqual(
        (
            tools.find((tool) => tool.name === "bash_run")?.inputSchema as {
                properties?: Record<string, unknown>;
            }
        ).properties?.instance,
        undefined,
    );
    assert.equal(
        (
            tools.find((tool) => tool.name === "environ_info")?.inputSchema as {
                properties?: Record<string, unknown>;
            }
        ).properties?.instance,
        undefined,
    );
    for (const name of [
        "instance_connect",
        "instance_list",
        "instance_status",
        "instance_create",
        "instance_stop",
    ]) {
        assert.equal(
            tools.some((tool) => tool.name === name),
            false,
            name,
        );
    }
});

test("environ_info never accepts a cross-instance target", async () => {
    await assert.rejects(
        createManagedEndpoint().callTool(
            "environ_info",
            { instance: "remote-server", workspace: "/remote-workspace" },
            context,
        ),
        /environ_info accepts only optional ctxId and workspace/u,
    );
});

test("environ_remote attach remains callable without a ready owner Worker", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-environ-remote-bootstrap",
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry: registry,
        gateway: createGateway(),
        instanceName: "main-pc",
        worker: createWorker({ hasSchema: false, ready: false }),
    });
    const handle = await requireRemoteHandle(
        registry,
        created.ctxId,
        "remote-server",
    );
    const attached = (await endpoint.callTool(
        "environ_remote",
        {
            command: "attach",
            ctxId: created.ctxId,
            handle,
            workspace: "/remote-workspace",
        },
        context,
    )) as { details?: { instance?: string; workspace?: string } };

    assert.equal(attached.details?.instance, "remote-server");
    assert.equal(attached.details?.workspace, "/remote-workspace");
    assert.equal(
        (
            await registry.validateForInstance(created.ctxId, "remote-server")
        ).environments.find(
            (environment) => environment.instance === "remote-server",
        )?.workspace,
        "/remote-workspace",
    );
});

test("environment tools cross the ToolCall operation boundary before side effects", async () => {
    let now = Date.parse("2026-09-14T12:00:00.000Z");
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-environ-boundary",
        now: () => now,
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    const boundaryCalls: string[] = [];
    let connectCalls = 0;
    let prepareCalls = 0;
    const gateway = createGateway({
        async callToolOperation(_instance, toolName) {
            boundaryCalls.push(toolName);
            throw new Error("boundary rejected");
        },
        async connectInstance(instance) {
            connectCalls += 1;
            return { instance };
        },
    });
    const worker = {
        ...createWorker(),
        async prepareExtensionResource() {
            return { directory: "/workspace/.devshell/skills" };
        },
        async prepareWorkspace(workspace: string) {
            prepareCalls += 1;
            return {
                projectMemoryAgentFile: `${workspace}/AGENT.md`,
                projectMemoryDirectory: workspace,
                projectMemoryPresent: true,
                temporaryDirectory: `${workspace}/tmp`,
                workspace,
            };
        },
    };
    const endpoint = new McpEndpointWorker({
        contextRegistry: registry,
        gateway,
        instanceName: "main-pc",
        worker,
    });
    const handle = await requireRemoteHandle(
        registry,
        created.ctxId,
        "remote-server",
    );
    const beforeBoundary = await registry.lookup(created.ctxId, {
        principal: "local",
    });
    now += 1_000;

    await assert.rejects(
        endpoint.callTool("environ_info", { ctxId: created.ctxId }, context),
        /boundary rejected/u,
    );
    await assert.rejects(
        endpoint.callTool(
            "environ_remote",
            {
                command: "attach",
                ctxId: created.ctxId,
                handle,
                workspace: "/remote-workspace",
            },
            context,
        ),
        /boundary rejected/u,
    );
    assert.deepEqual(boundaryCalls, ["environ_info", "environ_remote"]);
    assert.equal(prepareCalls, 0);
    assert.equal(connectCalls, 0);
    const afterBoundary = await registry.lookup(created.ctxId, {
        principal: "local",
    });
    assert.equal(afterBoundary.lastAccessedAt, beforeBoundary.lastAccessedAt);
    assert.equal(afterBoundary.expiresAt, beforeBoundary.expiresAt);
    assert.equal(
        afterBoundary.environments.find(
            (environment) => environment.instance === "remote-server",
        )?.workspace,
        undefined,
    );
});

test("environ_remote bootstraps and irreversibly masks remote routing", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-environ-remote",
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    const remoteCalls: string[] = [];
    let cleanupAttempts = 0;
    const gateway = createGateway({
        async callTool(instance) {
            remoteCalls.push(instance);
            return { remote: true };
        },
        async releaseInstanceReference() {
            cleanupAttempts += 1;
            if (cleanupAttempts === 1)
                throw new Error("remote cleanup unavailable");
        },
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry: registry,
        gateway,
        instanceName: "main-pc",
        worker: createWorker(),
    });
    const handle = await requireRemoteHandle(
        registry,
        created.ctxId,
        "remote-server",
    );

    assert.deepEqual(
        await endpoint.callTool(
            "environ_remote",
            { command: "help", ctxId: created.ctxId },
            context,
        ),
        {
            command: "help",
            ctxId: created.ctxId,
            details: {
                commands: [
                    {
                        command: "help",
                        summary:
                            "Return the authoritative current environ_remote command catalog.",
                        usage: "help",
                    },
                    {
                        command: "attach",
                        summary:
                            "Attach a remote managed instance and optional absolute workspace to the current Context.",
                        usage: "attach handle [workspace]",
                    },
                    {
                        command: "mask",
                        summary:
                            "Permanently hide a remote instance from this Context and revoke any existing attachment.",
                        usage: "mask handle",
                    },
                ],
            },
            message: "Current environ_remote command catalog.",
        },
    );

    const attached = (await endpoint.callTool(
        "environ_remote",
        {
            command: "attach",
            ctxId: created.ctxId,
            handle,
            workspace: "/remote-workspace",
        },
        context,
    )) as {
        command?: string;
        details?: { instance?: string; workspace?: string };
    };
    assert.equal(attached.command, "attach");
    assert.equal(attached.details?.instance, "remote-server");
    assert.equal(attached.details?.workspace, "/remote-workspace");
    assert.deepEqual(
        await endpoint.callTool(
            "bash_run",
            { command: "pwd", ctxId: created.ctxId, instance: "remote-server" },
            context,
        ),
        { remote: true },
    );

    await assert.rejects(
        endpoint.callTool(
            "environ_remote",
            { command: "mask", ctxId: created.ctxId, handle },
            context,
        ),
    );
    assert.equal(
        await registry.referenceInstance(created.ctxId, "remote-server"),
        undefined,
    );
    await assert.rejects(
        endpoint.callTool(
            "bash_run",
            { command: "pwd", ctxId: created.ctxId, instance: "remote-server" },
            context,
        ),
        (error: unknown) =>
            (error as { code?: string }).code === "mcp.contextInstanceMasked",
    );
    assert.deepEqual(
        await endpoint.callTool(
            "environ_remote",
            { command: "mask", ctxId: created.ctxId, handle },
            context,
        ),
        {
            command: "mask",
            ctxId: created.ctxId,
            details: { instance: "remote-server", masked: true },
            message:
                "Remote instance is permanently masked for the lifetime of the current Context.",
        },
    );
    assert.equal(cleanupAttempts, 2);
    await assert.rejects(
        endpoint.callTool(
            "environ_remote",
            { command: "unmask", ctxId: created.ctxId, handle },
            context,
        ),
        /Unknown environ_remote command "unmask".*command='help'/u,
    );
    assert.deepEqual(remoteCalls, ["remote-server"]);
});

test("routing fields are injected into strict worker schema union branches", () => {
    const unionTool: ToolDefinition = {
        requiredCapabilities: ["execute"],
        description: "Union tool",
        group: "tmux",
        inputSchema: {
            $defs: {
                Pane: {
                    additionalProperties: false,
                    properties: { pane: { type: "string" } },
                    required: ["pane"],
                    type: "object",
                },
                Task: {
                    additionalProperties: false,
                    properties: { task: { type: "string" } },
                    required: ["task"],
                    type: "object",
                },
            },
            anyOf: [{ $ref: "#/$defs/Task" }, { $ref: "#/$defs/Pane" }],
        },
        name: "tmux_input",
        outputSchema: { type: "object" },
    };
    const schema = withMcpInstanceTarget(withMcpContextId(unionTool))
        .inputSchema as {
        $defs?: Record<
            string,
            {
                properties?: Record<string, unknown>;
                required?: string[];
            }
        >;
    };
    for (const branch of Object.values(schema.$defs ?? {})) {
        assert.notEqual(branch.properties?.ctxId, undefined);
        assert.notEqual(branch.properties?.instance, undefined);
        assert.equal(branch.required?.includes("ctxId"), true);
        assert.equal(branch.required?.includes("instance"), false);
    }
});

test("worker calls default to the endpoint instance and route explicit targets through the gateway", async () => {
    const localCalls: Array<{ input: JsonValue; toolName: string }> = [];
    const remoteCalls: Array<{
        context: ToolCallContext;
        input: JsonValue;
        instance: string;
        toolName: string;
    }> = [];
    const worker = createWorker({
        tools: [bashTool, fileReadTool],
    });
    const gateway = createGateway({
        callTool: async (
            instance,
            toolName,
            input,
            callContext,
        ): Promise<JsonValue> => {
            if (instance === "main-pc") {
                localCalls.push({ input, toolName });
                return { local: true };
            }
            remoteCalls.push({
                context: callContext,
                input,
                instance,
                toolName,
            });
            return { remote: true };
        },
        listTools: () => [bashTool, fileReadTool],
    });
    const endpoint = createManagedEndpoint(worker, gateway);

    assert.deepEqual(
        await endpoint.callTool(
            "bash_run",
            withContext({ command: "pwd" }),
            context,
        ),
        { local: true },
    );
    await assert.rejects(
        endpoint.callTool(
            "bash_run",
            withContext({ command: "pwd", instance: "remote-server" }),
            context,
        ),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                "mcp.contextWorkspaceRequired",
            );
            return true;
        },
    );
    const remote = createTestContextEnvironment({
        contextRegistry,
        instanceName: "main-pc",
        gateway: () => gateway,
    });
    const handle = await requireRemoteHandle(
        contextRegistry,
        activeContext.ctxId,
        "remote-server",
    );
    await remote.attachRemote(activeContext.ctxId, handle, "/remote-workspace");
    assert.deepEqual(
        await endpoint.callTool(
            "bash_run",
            withContext({ command: "pwd", instance: "remote-server" }),
            context,
        ),
        { remote: true },
    );
    const recoveryPath =
        "/.devshell/tool-results/11111111-1111-1111-1111-111111111111/stdout";
    assert.deepEqual(
        await endpoint.callTool(
            "file_read",
            withContext({
                files: [
                    {
                        path: recoveryPath,
                        selector: "2000-2002:raw",
                        view: "content",
                    },
                ],
                instance: "remote-server",
            }),
            context,
        ),
        { remote: true },
    );
    assert.deepEqual(localCalls, [
        { input: { command: "pwd" }, toolName: "bash_run" },
    ]);
    assert.deepEqual(remoteCalls, [
        {
            context: {
                ctxId: activeContext.ctxId,
                requestId: "request-1",
                source: "mcp",
                workspace: "/remote-workspace",
            },
            input: { command: "pwd" },
            instance: "remote-server",
            toolName: "bash_run",
        },
        {
            context: {
                ctxId: activeContext.ctxId,
                requestId: "request-1",
                source: "mcp",
                workspace: "/remote-workspace",
            },
            input: {
                files: [
                    {
                        path: recoveryPath,
                        selector: "2000-2002:raw",
                        view: "content",
                    },
                ],
            },
            instance: "remote-server",
            toolName: "file_read",
        },
    ]);
});

test("remote environment attach reuses a live workspace attachment and releases a replaced alert lease", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-connect-idempotent",
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    let prepareCalls = 0;
    const touchedTemporary: string[] = [];
    const touchedAlerts: string[] = [];
    const releasedAlerts: string[] = [];
    const gateway = createGateway({
        async prepareWorkspace(instance, workspace) {
            prepareCalls += 1;
            return {
                projectMemoryAgentFile: `${workspace}/AGENT.md`,
                projectMemoryDirectory: `${workspace}/.memory`,
                projectMemoryPresent: true,
                temporaryDirectory: `/tmp/${instance}-${prepareCalls}`,
                workspace,
            };
        },
        async releaseAlerts(_instance, workspace) {
            releasedAlerts.push(workspace);
        },
        async touchAlerts(_instance, workspace) {
            touchedAlerts.push(workspace);
        },
        async touchTemporaryDirectory(_instance, path) {
            touchedTemporary.push(path);
        },
    });
    const remote = createTestContextEnvironment({
        contextRegistry: registry,
        instanceName: "main-pc",
        gateway: () => gateway,
    });
    const handle = await requireRemoteHandle(
        registry,
        created.ctxId,
        "remote-server",
    );
    const call = async (workspace: string) =>
        await remote.attachRemote(created.ctxId, handle, workspace);

    await call("/remote-a");
    await call("/remote-a");
    await call("/remote-b");

    assert.equal(prepareCalls, 2);
    assert.deepEqual(touchedTemporary, ["/tmp/remote-server-1"]);
    assert.deepEqual(touchedAlerts, ["/remote-a"]);
    assert.deepEqual(releasedAlerts, ["/remote-a"]);
});

test("remote workspace replacement keeps the committed attachment and retries cleanup debt", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-connect-cleanup-retry",
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    let releaseAttempts = 0;
    const gateway = createGateway({
        async prepareWorkspace(instance, workspace) {
            return {
                projectMemoryAgentFile: workspace + "/AGENT.md",
                projectMemoryDirectory: workspace + "/.memory",
                projectMemoryPresent: true,
                temporaryDirectory:
                    "/tmp/" + instance + "-" + workspace.slice(1),
                workspace,
            };
        },
        async releaseAlerts(_instance, workspace) {
            assert.equal(workspace, "/remote-a");
            releaseAttempts += 1;
            if (releaseAttempts === 1)
                throw new Error("old alert cleanup failed");
        },
    });
    const remote = createTestContextEnvironment({
        contextRegistry: registry,
        instanceName: "main-pc",
        gateway: () => gateway,
    });
    const handle = await requireRemoteHandle(
        registry,
        created.ctxId,
        "remote-server",
    );

    await remote.attachRemote(created.ctxId, handle, "/remote-a");
    await assert.rejects(
        remote.attachRemote(created.ctxId, handle, "/remote-b"),
    );
    assert.equal(
        (
            await registry.validateForInstance(created.ctxId, "remote-server")
        ).environments.find(
            (environment) => environment.instance === "remote-server",
        )?.workspace,
        "/remote-b",
    );
    assert.equal((await registry.listEnvironmentCleanup()).length, 1);

    await remote.attachRemote(created.ctxId, handle, "/remote-b");
    assert.equal(releaseAttempts, 2);
    assert.deepEqual(await registry.listEnvironmentCleanup(), []);
});

test("remote mask remains durable while failed cleanup is retried", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-mask-cleanup-retry",
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    let referenceAttempts = 0;
    let alertAttempts = 0;
    const gateway = createGateway({
        async releaseAlerts(_instance, workspace) {
            assert.equal(workspace, "/remote-mask");
            alertAttempts += 1;
        },
        async releaseInstanceReference(instance, reference) {
            assert.equal(instance, "remote-server");
            assert.equal(reference, created.ctxId);
            referenceAttempts += 1;
            if (referenceAttempts === 1)
                throw new Error("reference cleanup failed");
        },
    });
    const remote = createTestContextEnvironment({
        contextRegistry: registry,
        instanceName: "main-pc",
        gateway: () => gateway,
    });
    const handle = await requireRemoteHandle(
        registry,
        created.ctxId,
        "remote-server",
    );
    await remote.attachRemote(created.ctxId, handle, "/remote-mask");

    await assert.rejects(remote.maskRemote(created.ctxId, handle));
    await assert.rejects(
        registry.validateForInstance(created.ctxId, "remote-server"),
        (error: unknown) =>
            (error as { code?: string }).code === "mcp.contextInstanceMasked",
    );
    assert.equal(referenceAttempts, 1);
    assert.equal(alertAttempts, 1);
    assert.deepEqual(await registry.listEnvironmentCleanup(), [
        {
            cleanup: {
                instance: "remote-server",
                kind: "instance_reference",
            },
            ctxId: created.ctxId,
        },
    ]);

    await remote.maskRemote(created.ctxId, handle);
    assert.equal(referenceAttempts, 2);
    assert.equal(alertAttempts, 1);
    assert.deepEqual(await registry.listEnvironmentCleanup(), []);
});

test("remote environment attach cleans an unused alert lease and reference when workspace preparation fails", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-connect-failure",
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    const releasedAlerts: string[] = [];
    const releasedReferences: string[] = [];
    const gateway = createGateway({
        async prepareWorkspace(instance, workspace) {
            return {
                projectMemoryAgentFile: `${workspace}/AGENT.md`,
                projectMemoryDirectory: `${workspace}/.memory`,
                projectMemoryPresent: true,
                temporaryDirectory: `/tmp/${instance}`,
                workspace,
            };
        },
        async readAlerts() {
            throw new Error("alerts failed");
        },
        async releaseAlerts(_instance, workspace) {
            releasedAlerts.push(workspace);
        },
        async releaseInstanceReference(instance, reference) {
            releasedReferences.push(`${instance}:${reference}`);
        },
    });
    const remote = createTestContextEnvironment({
        contextRegistry: registry,
        instanceName: "main-pc",
        gateway: () => gateway,
    });
    const handle = await requireRemoteHandle(
        registry,
        created.ctxId,
        "remote-server",
    );

    await assert.rejects(
        remote.attachRemote(created.ctxId, handle, "/remote-fail"),
        /alerts failed/u,
    );
    assert.deepEqual(releasedAlerts, ["/remote-fail"]);
    assert.deepEqual(releasedReferences, [`remote-server:${created.ctxId}`]);
});

test("remote attach persists cleanup intent before acquiring external resources", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-connect-write-ahead-cleanup",
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    let referenceIntentVisible = false;
    let alertIntentVisible = false;
    let referenceReleases = 0;
    let alertReleases = 0;
    const gateway = createGateway({
        async connectInstance(instance, reference) {
            const pending = await registry.listEnvironmentCleanup(
                created.ctxId,
            );
            referenceIntentVisible = pending.some(
                ({ cleanup }) =>
                    cleanup.kind === "instance_reference" &&
                    cleanup.instance === instance,
            );
            return { instance, reference };
        },
        async readAlerts(_instance, workspace) {
            const pending = await registry.listEnvironmentCleanup(
                created.ctxId,
            );
            alertIntentVisible = pending.some(
                ({ cleanup }) =>
                    cleanup.kind === "alerts" &&
                    cleanup.workspace === workspace,
            );
            return { advice: [] };
        },
        async releaseAlerts() {
            alertReleases += 1;
        },
        async releaseInstanceReference() {
            referenceReleases += 1;
        },
    });
    const remote = createTestContextEnvironment({
        contextRegistry: registry,
        instanceName: "main-pc",
        gateway: () => gateway,
    });
    const handle = await requireRemoteHandle(
        registry,
        created.ctxId,
        "remote-server",
    );

    await remote.attachRemote(created.ctxId, handle, "/remote-write-ahead");

    assert.equal(referenceIntentVisible, true);
    assert.equal(alertIntentVisible, true);
    assert.equal(referenceReleases, 0);
    assert.equal(alertReleases, 0);
    assert.deepEqual(await registry.listEnvironmentCleanup(created.ctxId), []);
});

test("remote attach persists cleanup debt when pre-commit compensation fails", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-connect-cleanup-debt",
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    let alertReads = 0;
    let alertReleaseAttempts = 0;
    let referenceReleaseAttempts = 0;
    const gateway = createGateway({
        async prepareWorkspace(instance, workspace) {
            return {
                projectMemoryAgentFile: workspace + "/AGENT.md",
                projectMemoryDirectory: workspace + "/.memory",
                projectMemoryPresent: true,
                temporaryDirectory: "/tmp/" + instance,
                workspace,
            };
        },
        async readAlerts() {
            alertReads += 1;
            if (alertReads === 1)
                throw new Error("alerts failed before commit");
            return { advice: [] };
        },
        async releaseAlerts(_instance, workspace) {
            assert.equal(workspace, "/remote-retry");
            alertReleaseAttempts += 1;
            if (alertReleaseAttempts === 1)
                throw new Error("prepared alert cleanup failed");
        },
        async releaseInstanceReference(instance, reference) {
            assert.equal(instance, "remote-server");
            assert.equal(reference, created.ctxId);
            referenceReleaseAttempts += 1;
            if (referenceReleaseAttempts === 1)
                throw new Error("pre-commit reference cleanup failed");
        },
    });
    const remote = createTestContextEnvironment({
        contextRegistry: registry,
        instanceName: "main-pc",
        gateway: () => gateway,
    });
    const handle = await requireRemoteHandle(
        registry,
        created.ctxId,
        "remote-server",
    );

    await assert.rejects(
        remote.attachRemote(created.ctxId, handle, "/remote-retry"),
    );
    const pendingCleanup = await registry.listEnvironmentCleanup();
    assert.equal(pendingCleanup.length, 2);
    assert.equal(
        pendingCleanup.some(
            ({ cleanup, ctxId }) =>
                ctxId === created.ctxId &&
                cleanup.kind === "alerts" &&
                cleanup.instance === "remote-server" &&
                cleanup.workspace === "/remote-retry",
        ),
        true,
    );
    assert.equal(
        pendingCleanup.some(
            ({ cleanup, ctxId }) =>
                ctxId === created.ctxId &&
                cleanup.kind === "instance_reference" &&
                cleanup.instance === "remote-server",
        ),
        true,
    );

    await remote.attachRemote(created.ctxId, handle, "/remote-retry");
    assert.equal(alertReleaseAttempts, 2);
    assert.equal(referenceReleaseAttempts, 2);
    assert.deepEqual(await registry.listEnvironmentCleanup(), []);
    assert.equal(
        (
            await registry.validateForInstance(created.ctxId, "remote-server")
        ).environments.find(
            (environment) => environment.instance === "remote-server",
        )?.workspace,
        "/remote-retry",
    );
});

test("remote attach records reference cleanup debt when the gateway cannot release references", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-connect-cleanup-capability",
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    const gateway = createGateway({
        async prepareWorkspace(instance, workspace) {
            return {
                projectMemoryAgentFile: workspace + "/AGENT.md",
                projectMemoryDirectory: workspace + "/.memory",
                projectMemoryPresent: true,
                temporaryDirectory: "/tmp/" + instance,
                workspace,
            };
        },
        async readAlerts() {
            throw new Error("alerts failed before commit");
        },
    });
    delete (gateway as { releaseInstanceReference?: unknown })
        .releaseInstanceReference;
    const remote = createTestContextEnvironment({
        contextRegistry: registry,
        instanceName: "main-pc",
        gateway: () => gateway,
    });
    const handle = await requireRemoteHandle(
        registry,
        created.ctxId,
        "remote-server",
    );

    await assert.rejects(
        remote.attachRemote(created.ctxId, handle, "/remote-missing-release"),
    );
    assert.equal(
        (await registry.listEnvironmentCleanup()).some(
            ({ cleanup }) =>
                cleanup.kind === "instance_reference" &&
                cleanup.instance === "remote-server",
        ),
        true,
    );
});

test("remote bash truncation does not advertise the retired artifact_read tool", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-remote-artifact",
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    await registry.attachEnvironment(created.ctxId, {
        instance: "remote-server",
        temporaryDirectory: "/tmp/remote-artifact",
        workspace: "/remote-workspace",
    });
    const gateway = createGateway({
        async callTool(
            _instance,
            _toolName,
            _input,
            _context,
            _signal,
            _transformResult,
            _invocationInput,
        ) {
            return {
                comment: [
                    "[bash.outputTruncated] stdout output is incomplete.",
                ],
                exitCode: 0,
                stderr: "",
                stderrTruncated: false,
                stdout: "partial",
                stdoutArtifact: { handle: "artifact-1" },
                stdoutTruncated: true,
                termination: "exited",
            };
        },
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry: registry,
        gateway,
        instanceName: "main-pc",
        worker: createWorker(),
    });

    const result = (await endpoint.callTool(
        "bash_run",
        {
            command: "produce-output",
            ctxId: created.ctxId,
            instance: "remote-server",
        },
        context,
    )) as { comment?: string[] };
    assert.deepEqual(result.comment, [
        "[bash.outputTruncated] stdout output is incomplete.",
    ]);
});

test("remote worker calls never execute or query target schema while not ready", async () => {
    let listToolsCalled = false;
    let remoteCalled = false;
    const notReady = Object.assign(new Error("not ready"), {
        code: "core.instanceNotReady",
        details: { instance: "remote-server" },
        retryable: false,
    });
    const gateway = createGateway({
        assertReady() {
            throw notReady;
        },
        listTools() {
            listToolsCalled = true;
            return [bashTool];
        },
        async callTool() {
            remoteCalled = true;
            return { ok: true };
        },
    });
    const endpoint = createManagedEndpoint(createWorker(), gateway, {
        readyWaitMs: 50,
    });

    await contextRegistry.attachEnvironment(activeContext.ctxId, {
        instance: "remote-server",
        temporaryDirectory: "/tmp/remote-context",
        workspace: "/remote-workspace",
    });
    await assert.rejects(
        endpoint.callTool(
            "bash_run",
            withContext({ command: "pwd", instance: "remote-server" }),
            context,
        ),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                "core.instanceNotReady",
            );
            return true;
        },
    );
    assert.equal(listToolsCalled, false);
    assert.equal(remoteCalled, false);
});

test("worker tools missing from the endpoint catalog cannot be recovered from a remote instance", async () => {
    let remoteCalled = false;
    const gateway = createGateway({
        assertReady() {},
        async callTool() {
            remoteCalled = true;
            return { remote: true };
        },
        listTools() {
            return [bashTool];
        },
    });
    const endpoint = createManagedEndpoint(
        createWorker({ hasSchema: false, ready: false }),
        gateway,
    );

    await assert.rejects(
        endpoint.callTool(
            "bash_run",
            withContext({ command: "pwd", instance: "remote-server" }),
            context,
        ),
        (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                "core.toolSchemaUnavailable",
            );
            return true;
        },
    );
    assert.equal(remoteCalled, false);
});

test("cancelling remote environment attach stops MCP waiting while the gateway operation continues", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-cancel-remote",
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    let resolveStart!: (value: JsonValue) => void;
    let resolveConnectStarted!: () => void;
    let resolveRelease!: () => void;
    const connectStarted = new Promise<void>((resolve) => {
        resolveConnectStarted = resolve;
    });
    const start = new Promise<JsonValue>((resolve) => {
        resolveStart = resolve;
    });
    const released = new Promise<void>((resolve) => {
        resolveRelease = resolve;
    });
    const releasedReferences: string[] = [];
    const gateway = createGateway({
        async connectInstance() {
            resolveConnectStarted();
            return await start;
        },
        async releaseInstanceReference(instance, reference) {
            releasedReferences.push(`${instance}:${reference}`);
            resolveRelease();
        },
    });
    const remote = createTestContextEnvironment({
        contextRegistry: registry,
        instanceName: "main-pc",
        gateway: () => gateway,
    });
    const handle = await requireRemoteHandle(
        registry,
        created.ctxId,
        "remote-server",
    );
    const controller = new AbortController();
    const pending = remote.attachRemote(
        created.ctxId,
        handle,
        undefined,
        controller.signal,
    );

    await connectStarted;
    controller.abort(new Error("gateway timeout"));
    await assert.rejects(pending, /gateway timeout/u);
    resolveStart({ instance: "remote-server", state: "running" });
    await released;

    assert.deepEqual(releasedReferences, ["remote-server:" + created.ctxId]);
    const contextAfterAbort = (await registry.list()).find(
        (candidate) => candidate.ctxId === created.ctxId,
    );
    assert.equal(
        contextAfterAbort?.environments.some(
            (environment) => environment.instance === "remote-server",
        ),
        false,
    );
});

test("concurrent remote attaches serialize one Context reference transaction", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-concurrent-remote",
    });
    const created = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    let referenceHeld = false;
    const gateway = createGateway({
        async connectInstance() {
            referenceHeld = true;
            return { instance: "remote-server", state: "running" };
        },
        async prepareWorkspace(instance, workspace) {
            if (workspace === "/first") {
                await new Promise((resolve) => setTimeout(resolve, 10));
                throw new Error("first attach failed");
            }
            return {
                projectMemoryAgentFile: `${workspace}/AGENT.md`,
                projectMemoryDirectory: `${workspace}/.memory`,
                projectMemoryPresent: true,
                temporaryDirectory: `/tmp/${instance}`,
                workspace,
            };
        },
        async releaseInstanceReference() {
            referenceHeld = false;
        },
    });
    const remote = createTestContextEnvironment({
        contextRegistry: registry,
        instanceName: "main-pc",
        gateway: () => gateway,
    });
    const handle = await requireRemoteHandle(
        registry,
        created.ctxId,
        "remote-server",
    );

    const [first, second] = await Promise.allSettled([
        remote.attachRemote(created.ctxId, handle, "/first"),
        remote.attachRemote(created.ctxId, handle, "/second"),
    ]);

    assert.equal(first.status, "rejected");
    assert.equal(second.status, "fulfilled");
    assert.equal(referenceHeld, true);
    const context = (await registry.list()).find(
        (candidate) => candidate.ctxId === created.ctxId,
    );
    assert.equal(
        context?.environments.find(
            (environment) => environment.instance === "remote-server",
        )?.workspace,
        "/second",
    );
});

test("remote environment attach service is independent from local Worker readiness", async () => {
    const calls: string[] = [];
    const gateway = createGateway({
        connectInstance: async (instance) => {
            calls.push(`connect:${instance}`);
            return { instance };
        },
    });
    const remote = createTestContextEnvironment({
        contextRegistry,
        instanceName: "main-pc",
        gateway: () => gateway,
    });
    const handle = await requireRemoteHandle(
        contextRegistry,
        activeContext.ctxId,
        "remote-server",
    );

    await remote.attachRemote(activeContext.ctxId, handle);
    assert.deepEqual(calls, ["connect:remote-server"]);
});

async function requireRemoteHandle(
    registry: McpContextRegistry,
    ctxId: string,
    instance: string,
): Promise<string> {
    const reference = await registry.referenceInstance(ctxId, instance);
    assert.equal(reference?.current, false);
    assert.equal(typeof reference?.handle, "string");
    return reference!.handle!;
}

function createManagedEndpoint(
    worker = createWorker(),
    gateway = createGateway(),
    options?: { readyWaitMs?: number },
): McpEndpointWorker {
    return new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        readyWaitMs: options?.readyWaitMs,
        worker,
    });
}

function createWorker(
    options: {
        hasSchema?: boolean;
        ready?: boolean;
        tools?: ToolDefinition[];
    } = {},
) {
    return {
        async appendMcpSessionClosed() {},
        async appendMcpSessionOpened() {},
        async appendMcpToolCalled() {},
        async readAlerts() {
            return { advice: [] };
        },
        handshake: {
            homeDirectory: "/home/demo",
            instance: "main-pc",
            platform: {
                arch: "x86_64",
                distribution: {
                    id: "arch",
                    name: "Arch Linux",
                    version: "rolling",
                },
                os: "linux",
                packageManager: "pacman",
                shell: { executable: "/bin/bash", kind: "bash", version: "5" },
            },
        },
        hasToolSchemaCache() {
            return options.hasSchema ?? true;
        },
        listTools() {
            return options.tools ?? [bashTool];
        },
        snapshot() {
            return { ready: options.ready ?? true };
        },
    };
}

function createGateway(
    overrides: Partial<McpInstanceGateway> = {},
): McpInstanceGateway {
    return {
        async appendMcpToolCalled(instance, toolName, callContext) {
            await overrides.appendMcpToolCalled?.(
                instance,
                toolName,
                callContext,
            );
        },
        assertReady(instance) {
            overrides.assertReady?.(instance);
        },
        async callExtensionTool(
            instance,
            toolName,
            input,
            callContext,
            callId,
            signal,
        ) {
            if (overrides.callExtensionTool === undefined)
                throw new Error("Extension tool unavailable.");
            return await overrides.callExtensionTool(
                instance,
                toolName,
                input,
                callContext,
                callId,
                signal,
            );
        },
        async callToolOperation<T extends JsonValue>(
            instance: string,
            toolName: string,
            input: JsonValue,
            callContext: ToolCallContext,
            operation: (
                callId: string,
                input: JsonValue,
                finalValue: ToolCallHookValue,
            ) => Promise<T>,
            signal?: AbortSignal,
        ): Promise<T> {
            if (overrides.callToolOperation !== undefined) {
                return await overrides.callToolOperation(
                    instance,
                    toolName,
                    input,
                    callContext,
                    operation,
                    signal,
                );
            }
            return await operation("call-test", input, {
                kind: "call",
                toolName: toolName,
                payload: input,
                context: { ...callContext, instance: asInstanceName(instance) },
            });
        },
        async callTool(
            instance,
            toolName,
            input,
            callContext,
            signal,
            transformResult,
            invocationInput,
            onProgress,
            recording,
        ) {
            const finalValue: ToolCallHookValue = {
                kind: "call",
                toolName,
                payload: input,
                context: { ...callContext, instance: asInstanceName(instance) },
            };
            const preparedInput =
                (await invocationInput?.(input, "call-test", finalValue)) ??
                input;
            const result =
                overrides.callTool === undefined
                    ? { instance, toolName }
                    : await overrides.callTool(
                          instance,
                          toolName,
                          preparedInput,
                          callContext,
                          signal,
                          undefined,
                          undefined,
                          onProgress,
                          recording,
                      );
            return transformResult === undefined
                ? result
                : await transformResult(result, "call-test");
        },
        environment(instance) {
            return (
                overrides.environment?.(instance) ?? {
                    homeDirectory: "/remote",
                    instance,
                    platform: { arch: "arm64", os: "darwin" },
                }
            );
        },
        async listInstances() {
            return await (overrides.listInstances?.() ?? Promise.resolve([]));
        },
        listTools(instance) {
            return overrides.listTools?.(instance) ?? [bashTool];
        },
        listExtensionTools(instance) {
            return overrides.listExtensionTools?.(instance) ?? [];
        },
        async prepareWorkspace(instance, workspace) {
            return await (overrides.prepareWorkspace?.(instance, workspace) ??
                Promise.resolve({
                    projectMemoryAgentFile: `${workspace}/.memory/AGENT.md`,
                    projectMemoryDirectory: `${workspace}/.memory`,
                    projectMemoryPresent: true,
                    temporaryDirectory: `/tmp/${instance}-context`,
                    workspace,
                }));
        },
        async readAlerts(instance, workspace) {
            return await (overrides.readAlerts?.(instance, workspace) ??
                Promise.resolve({ advice: [] }));
        },
        async releaseAlerts(instance, workspace) {
            await overrides.releaseAlerts?.(instance, workspace);
        },
        async readTodo(instance, input) {
            return await (overrides.readTodo?.(instance, input) ??
                Promise.resolve({
                    items: [],
                    revision: 0,
                    summary: { completed: 0, total: 0 },
                }));
        },
        async connectInstance(instance, reference) {
            return await (overrides.connectInstance?.(instance, reference) ??
                Promise.resolve({ instance }));
        },
        async releaseInstanceReference(instance, reference) {
            await overrides.releaseInstanceReference?.(instance, reference);
        },
        async statusInstance(instance) {
            return await (overrides.statusInstance?.(instance) ??
                Promise.resolve({ instance }));
        },
        async stopInstance(instance) {
            return await (overrides.stopInstance?.(instance) ??
                Promise.resolve({ instance }));
        },
        async touchAlerts(instance, workspace) {
            await overrides.touchAlerts?.(instance, workspace);
        },
        async touchTemporaryDirectory(instance, path) {
            await overrides.touchTemporaryDirectory?.(instance, path);
        },
        async writeTodo(instance, input, callContext) {
            return await (overrides.writeTodo?.(instance, input, callContext) ??
                Promise.resolve({
                    items: [],
                    revision: 1,
                    summary: { completed: 0, total: 0 },
                }));
        },
    };
}

test("Todo read/write and Extension report remain available while the worker is stopped", async () => {
    const calls: string[] = [];
    const gateway = createGateway({
        async callExtensionTool(
            instance,
            toolName,
            input,
            callContext,
            callId,
        ) {
            assert.equal(toolName, "todo_report");
            const message = (input as { message?: string }).message ?? "";
            calls.push(
                `report:${instance}:${callContext.ctxId}:${callId}:${message}`,
            );
            return {
                content: [{ type: "text", text: message }],
                structuredContent: { reported: true },
            };
        },
        listExtensionTools() {
            return [
                {
                    _meta: {
                        devshell: {
                            mcp: {
                                annotations: {
                                    destructiveHint: false,
                                    idempotentHint: false,
                                    openWorldHint: false,
                                    readOnlyHint: false,
                                },
                                extensionTool: true,
                                preserveInputDescriptions: true,
                                title: "Message user",
                            },
                        },
                    },
                    description:
                        "Send a user-visible message. #push requires a reply; #stop disables tools until #resume.",
                    group: "todo",
                    inputSchema: {
                        additionalProperties: false,
                        properties: {
                            message: {
                                description: "User reply or progress update.",
                                type: "string",
                            },
                        },
                        required: ["message"],
                        type: "object",
                    },
                    name: "todo_report",
                    outputSchema: {
                        properties: { reported: { type: "boolean" } },
                        required: ["reported"],
                        type: "object",
                    },
                    requiredCapabilities: [],
                },
            ];
        },
        async readTodo(instance, input) {
            calls.push(
                `read:${instance}:${input?.taskId ?? input?.title ?? "all"}`,
            );
            return {
                items: [],
                revision: 0,
                summary: { completed: 0, total: 0 },
            };
        },
        async writeTodo(instance, input, callContext) {
            calls.push(
                `write:${instance}:${callContext.ctxId}:${String((input as { revision?: number }).revision)}`,
            );
            return {
                items: [],
                revision: 1,
                summary: { completed: 0, total: 0 },
            };
        },
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry,
        gateway,
        instanceName: "main-pc",
        worker: createWorker({ hasSchema: false, ready: false }),
    });

    assert.deepEqual(
        await endpoint.callTool("todo_read", withContext({}), context),
        {
            items: [],
            revision: 0,
            summary: { completed: 0, total: 0 },
        },
    );
    const todoReadSchema = endpoint
        .listTools()
        .find((tool) => tool.name === "todo_read")?.outputSchema;
    assert.deepEqual(todoReadSchema, { type: "object" });
    const todoWriteSchema = endpoint
        .listTools()
        .find((tool) => tool.name === "todo_write")?.inputSchema as {
        properties?: {
            todos?: {
                contains?: unknown;
                items?: {
                    allOf?: unknown;
                    properties?: Record<string, unknown>;
                };
                maxContains?: unknown;
                minContains?: unknown;
            };
        };
    };
    assert.deepEqual(
        Object.keys(
            todoWriteSchema.properties?.todos?.items?.properties ?? {},
        ).sort(),
        ["content", "detail", "id", "status"],
    );
    assert.equal(todoWriteSchema.properties?.todos?.items?.allOf, undefined);
    assert.equal(todoWriteSchema.properties?.todos?.contains, undefined);
    assert.equal(todoWriteSchema.properties?.todos?.minContains, undefined);
    assert.equal(todoWriteSchema.properties?.todos?.maxContains, undefined);
    const todoReport = endpoint
        .listTools()
        .find((tool) => tool.name === "todo_report");
    assert.match(todoReport?.description ?? "", /#push/u);
    assert.match(todoReport?.description ?? "", /#stop/u);
    const report = (await endpoint.callTool(
        "todo_report",
        withContext({ message: "Finished the first acceptance stage." }),
        context,
    )) as {
        content?: unknown;
        structuredContent?: unknown;
    };
    assert.deepEqual(report.content, [
        { type: "text", text: "Finished the first acceptance stage." },
    ]);
    assert.deepEqual(report.structuredContent, { reported: true });
    await endpoint.callTool(
        "todo_read",
        withContext({ title: "Recover" }),
        context,
    );
    await endpoint.callTool(
        "todo_read",
        withContext({ taskId: "task-recover" }),
        context,
    );
    await endpoint.callTool(
        "todo_write",
        withContext({ revision: 0, title: "Recover", todos: [] }),
        context,
    );
    assert.deepEqual(calls, [
        "read:main-pc:all",
        "report:main-pc:ctx-instance-test:call-test:Finished the first acceptance stage.",
        "read:main-pc:Recover",
        "read:main-pc:task-recover",
        "write:main-pc:ctx-instance-test:0",
    ]);

    assert.equal(
        endpoint.listTools().some((tool) => tool.name === "todo_read"),
        true,
    );
});

test("openai-session binding uses the same Todo contract as explicit ctxId", async () => {
    const registry = new McpContextRegistry({
        idFactory: () => "ctx-session-todo",
    });
    const current = await registry.create({
        environments: [
            {
                instance: "main-pc",
                workspace: "/workspace",
            },
        ],
        principal: "local",
    });
    await registry.bindExternal(
        current.ctxId,
        { kind: "openai/session", value: "chat-session-todo" },
        {
            principal: "local",
        },
    );
    const tasks = [
        {
            completed: 0,
            ctxId: current.ctxId,
            revision: 1,
            status: "in_progress",
            taskId: "task-current",
            title: "Current task",
            total: 1,
            updatedAt: "2026-08-20T00:00:00.000Z",
        },
        {
            completed: 0,
            ctxId: "ctx-other-session",
            revision: 2,
            status: "paused",
            taskId: "task-other",
            title: "Other task",
            total: 2,
            updatedAt: "2026-08-19T00:00:00.000Z",
        },
    ];
    const gateway = createGateway({
        async readTodo() {
            return {
                items: [],
                revision: 0,
                summary: { completed: 0, total: 0 },
                tasks,
            };
        },
    });
    const endpoint = new McpEndpointWorker({
        contextMode: "openai-session",
        contextRegistry: registry,
        gateway,
        instanceName: "main-pc",
        worker: createWorker({ hasSchema: false, ready: false }),
    });
    const requestContext = {
        principal: "local",
        requestId: "request-session-todo",
        requestMeta: { "openai/session": "chat-session-todo" },
    } as const;

    const discovered = (await endpoint.callTool(
        "todo_read",
        {},
        requestContext,
    )) as {
        tasks?: Array<Record<string, unknown>>;
    };
    assert.deepEqual(
        discovered.tasks?.map((task) => task.taskId),
        ["task-current", "task-other"],
    );
    assert.equal(discovered.tasks?.[0]?.ctxId, current.ctxId);

    const todoTool = endpoint
        .listTools()
        .find((tool) => tool.name === "todo_read");
    assert.deepEqual(todoTool?.outputSchema, { type: "object" });
    assert.notEqual(
        (todoTool?.inputSchema as { properties?: Record<string, unknown> })
            .properties?.title,
        undefined,
    );
});

async function rewrittenEndpoint(
    toolName: string,
    remote: boolean,
    reject = false,
) {
    let now = Date.now();
    const registry = new McpContextRegistry({ now: () => now });
    const original = await registry.create({
        environments: [{ instance: "main-pc", workspace: "/original" }],
        principal: "local",
    });
    const instance = remote ? "final" : "main-pc";
    const final = await registry.create({
        environments: [{ instance, workspace: "/final" }],
        principal: "local",
    });
    now += 1000;
    const changes: Array<[string, ...unknown[]]> = [];
    const inputs: JsonValue[] = [];
    const provenance: unknown[] = [];
    const values: ToolCallHookValue[] = [];
    const callIds: string[] = [];
    const reviews: string[] = [];
    const pipeline = new ToolCallPipeline({
        hooks: () => ({
            release() {},
            sequence: new ToolCallHookSequence({
                reviews: [
                    ({ value }) => {
                        reviews.push(value.context.instance);
                        return reject
                            ? { decision: "reject", reason: "blocked" }
                            : { decision: "continue" };
                    },
                ],
                rewrites: [
                    ({ value }) => ({
                        ...value,
                        toolName,
                        payload: {
                            command: "rewritten",
                            task: "final-task",
                            wait: "block",
                            timeMs: 180000,
                        },
                        context: {
                            ...value.context,
                            instance: asInstanceName(instance),
                            ctxId: final.ctxId,
                            workspace: "/final",
                        },
                    }),
                ],
            }),
        }),
        resolveTarget(target) {
            assert.equal(target, instance);
            return {
                async dispatch(request): Promise<JsonValue> {
                    values.push(request.value);
                    callIds.push(request.callId);
                    inputs.push(
                        (await request.invocationInput?.(
                            request.value.payload,
                            request.callId,
                            request.value,
                        )) ?? request.value.payload,
                    );
                    const result: JsonValue =
                        request.operation === undefined
                            ? {
                                  task: {
                                      id: "final-task",
                                      status: "completed",
                                  },
                                  output: "ready",
                                  waitReason: "terminal",
                              }
                            : await request.operation(
                                  request.callId,
                                  request.value.payload,
                                  request.value,
                              );
                    return (
                        (await request.transformResult?.(
                            result,
                            request.callId,
                        )) ?? result
                    );
                },
            };
        },
    });
    const prepare = async (target: string, workspace: string) => {
        changes.push(["workspace", target, workspace]);
        return {
            projectMemoryAgentFile: "/memory/AGENT.md",
            projectMemoryDirectory: "/memory",
            temporaryDirectory: "/tmp/final",
            workspace,
        };
    };
    const called = async (target: string, name: string, context: unknown) => {
        changes.push(["event", target, name, context]);
    };
    const gateway = createGateway({
        callToolOperation: (...args) => pipeline.callOperation(...args),
        assertReady(target) {
            changes.push(["ready", target]);
        },
        appendMcpToolCalled: called,
        prepareWorkspace: prepare,
        async touchAlerts(target, workspace) {
            changes.push(["alerts", target, workspace]);
        },
        async touchGoal(target, ctxId) {
            changes.push(["goal", target, ctxId]);
        },
        listTools: () => [
            bashTool,
            fileReadTool,
            { ...bashTool, group: "tmux", name: "tmux_run" },
            { ...bashTool, group: "tmux", name: "tmux_read" },
        ],
        listExtensionTools: () => [
            { ...bashTool, group: "ext", name: "ext_original" },
            { ...bashTool, group: "ext", name: "ext_final" },
        ],
        async callExtensionTool(target, name, input, context) {
            changes.push(["extension", target, name, input, context]);
            return { structuredContent: {} };
        },
    });
    Object.assign(gateway, {
        callTool: (...args: Parameters<McpInstanceGateway["callTool"]>) =>
            pipeline.call(...args),
        approval: {
            async listApprovals() {
                return [];
            },
            async listPendingApprovals() {
                return [];
            },
            async decideApproval() {
                throw new Error("unexpected approval");
            },
        },
        async listWaits() {
            return [];
        },
        async createWait() {
            throw new Error("unexpected wait");
        },
        async detachWait() {
            throw new Error("unexpected wait");
        },
        async consumeWait() {
            throw new Error("unexpected wait");
        },
        async resolveWait() {
            throw new Error("unexpected wait");
        },
        async waitForWait() {
            throw new Error("unexpected wait");
        },
        async cancelWait() {
            throw new Error("unexpected wait");
        },
        async reattachWait() {
            throw new Error("unexpected wait");
        },
        async observeTmuxTask() {
            throw new Error("unexpected observation");
        },
        invokeToolInternal: async (
            target: string,
            name: string,
            _input: JsonValue,
            context: ToolCallContext,
        ) => {
            changes.push(["internal", target, name, context]);
            return {
                task: { id: "final-task", status: "completed" },
                output: "ready",
            };
        },
    });
    const endpoint = new McpEndpointWorker({
        contextRegistry: registry,
        gateway,
        instanceName: "main-pc",
        toolProvenance: {
            async record(value) {
                provenance.push(value);
            },
        },
        worker: {
            ...createWorker({
                tools: [
                    bashTool,
                    fileReadTool,
                    { ...bashTool, group: "tmux", name: "tmux_run" },
                    { ...bashTool, group: "tmux", name: "tmux_read" },
                ],
            }),
            prepareWorkspace: (workspace) => prepare("main-pc", workspace),
            appendMcpToolCalled: (name, context) =>
                called("main-pc", name, context),
            async touchAlerts(workspace) {
                changes.push(["alerts", "main-pc", workspace]);
            },
        },
    });
    return {
        endpoint,
        registry,
        original,
        final,
        instance,
        changes,
        inputs,
        provenance,
        values,
        callIds,
        reviews,
    };
}

for (const remote of [true, false]) {
    test(`MCP accepted bookkeeping uses final instance, tool and Context (${remote ? "remote" : "local"})`, async () => {
        const h = await rewrittenEndpoint("file_read", remote);
        await h.endpoint.callTool(
            "bash_run",
            {
                ctxId: h.original.ctxId,
                instance: "unknown",
                command: "original",
                purpose: "final target",
            },
            context,
        );
        assert.deepEqual(h.reviews, ["unknown"]);
        assert.deepEqual(
            h.changes.filter((change) => change[0] === "ready"),
            [
                ["ready", h.instance],
                ["ready", h.instance],
            ],
        );
        assert.deepEqual(
            h.changes.find((change) => change[0] === "workspace"),
            ["workspace", h.instance, "/final"],
        );
        assert.deepEqual(
            h.changes.find((change) => change[0] === "event"),
            ["event", h.instance, "file_read", h.values[0]!.context],
        );
        assert.deepEqual(h.provenance, [
            {
                callId: h.callIds[0],
                instance: h.instance,
                purpose: "final target",
            },
        ]);
        assert.equal(
            (await h.registry.validate(h.original.ctxId, context))
                .lastAccessedAt,
            h.original.lastAccessedAt,
        );
        assert.notEqual(
            (await h.registry.validate(h.final.ctxId, context)).lastAccessedAt,
            h.final.lastAccessedAt,
        );
        assert.equal(
            (await h.registry.reentry.readAutomaticReentry(h.final.ctxId, h.instance))
                .executionEpoch,
            2,
        );
    });
}

for (const name of ["tmux_run", "tmux_read"]) {
    test(`${name} adapts final rewritten input and finishes against final Context`, async () => {
        const h = await rewrittenEndpoint(name, true);
        await h.endpoint.callTool(
            name,
            {
                ctxId: h.original.ctxId,
                instance: "unknown",
                command: "original",
                task: "original-task",
                wait: "block",
                timeMs: 180000,
                purpose: "tmux",
            },
            context,
        );
        assert.deepEqual(
            h.inputs[0],
            name === "tmux_run"
                ? {
                      command: "rewritten",
                      task: "final-task",
                      wait: "nonblock",
                      timeMs: 180000,
                      consumeOutput: false,
                  }
                : {
                      consumeOutput: false,
                      line: 0,
                      task: "final-task",
                      timeMs: 0,
                  },
        );
        const internal = h.changes.find(
            (change) => change[0] === "internal",
        ) as [string, string, string, ToolCallContext];
        assert.equal(internal[1], "final");
        assert.equal(internal[3].ctxId, h.final.ctxId);
    });
}

for (const name of ["bash_run", "ext_original", "tmux_run"]) {
    test(`${name} rejected review leaves accepted MCP state untouched`, async () => {
        const h = await rewrittenEndpoint(name, true, true);
        await assert.rejects(
            h.endpoint.callTool(
                name,
                {
                    ctxId: h.original.ctxId,
                    instance: "unknown",
                    wait: "block",
                    purpose: "rejected",
                },
                context,
            ),
            { code: "core.toolCallRejected" },
        );
        assert.deepEqual(h.changes, []);
        assert.deepEqual(h.values, []);
        assert.deepEqual(h.provenance, []);
        assert.deepEqual(
            await h.registry.validate(h.original.ctxId, context),
            h.original,
        );
    });
}

test("MCP Extension operation uses final rewritten tool and Context without worker preparation", async () => {
    const h = await rewrittenEndpoint("ext_final", true);
    await h.endpoint.callTool(
        "ext_original",
        { ctxId: h.original.ctxId, purpose: "operation" },
        context,
    );
    assert.deepEqual(
        h.changes.find((change) => change[0] === "extension"),
        [
            "extension",
            "final",
            "ext_final",
            h.values[0]!.payload,
            h.values[0]!.context,
        ],
    );
    assert.equal(
        h.changes.some((change) => change[0] === "workspace"),
        false,
    );
    assert.deepEqual(h.provenance, [
        { callId: h.callIds[0], instance: "final", purpose: "operation" },
    ]);
});
