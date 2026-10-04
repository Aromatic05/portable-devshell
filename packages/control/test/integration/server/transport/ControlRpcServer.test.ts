import assert from "node:assert/strict";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type {
    WorkerCommandInteractiveSession,
    WorkerInstance,
} from "@portable-devshell/core/testing";
import type {
    TerminalProcess,
    TerminalProcessExit,
} from "@portable-devshell/core/testing";
import {
    CONTROL_PROTOCOL_RANGE,
    CONTROL_PROTOCOL_VERSION,
    Endpoint,
    LocalChannel,
    Rpc,
    Stream,
    asInstanceName,
    type ActiveTodoSummary,
    MASKED_CONFIG_TOKEN,
    createDefaultControlConfig,
    controlErrorCodes,
    toRemoteErrorBody,
    type RemoteErrorBody,
    type ControlStreamMessage,
    type JsonValue,
    type MessageStream,
    type ToolCallQuery,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import { ControlRouteComposition } from "../../../../src/composition/Route.ts";
import {
    createTestInstanceDomainRuntime,
    createTestTaskApi,
} from "../../../../src/testing.ts";
import { ConfigEditorCoordinator } from "../../../../src/config/editor/index.ts";
import { CommentExtension } from "@portable-devshell/comment-extension";
import { ControlConfigStore } from "../../../../src/config/store/index.ts";
import { DebugPatchService } from "../../../../src/debug/Service.ts";
import { InstanceRegistry } from "@portable-devshell/core";
import { InstanceRegistryFactory } from "@portable-devshell/core";
import { ControlSocketServer } from "../../../../src/server/transport/endpoint/Socket.ts";
import { createTestIpcPath } from "../../../../../../test/TestPlatformSupport.ts";
import { createTestInstanceDescriptor } from "../../../support/ControlFixtures.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { cleanupInOrder } from "../../../../../../test/TestCleanup.ts";

interface Harness {
    cleanup(): Promise<void>;
    registry: InstanceRegistry;
    routes: ControlRouteComposition;
    server: ControlSocketServer;
    socketPath: string;
    worker: FakeWorker;
}

test("ControlSocketServer routes canonical control and instance operations over dedicated connections", async (t) => {
    const harness = await createHarness();
    t.after(() => harness.cleanup());

    if (process.platform !== "win32") {
        assert.equal((await stat(harness.socketPath)).mode & 0o777, 0o600);
    }

    assert.deepEqual(
        (await request(harness.socketPath, "@control", "service.ping")).payload,
        { pong: true },
    );
    assert.deepEqual(
        (await request(harness.socketPath, "@control", "server.status"))
            .payload,
        {
            instanceCount: 1,
            ok: true,
            pid: process.pid,
        },
    );
    assert.deepEqual(
        (
            await request(
                harness.socketPath,
                "@control",
                "server.hello",
                {
                    clientKind: "tui",
                    protocolRange: CONTROL_PROTOCOL_RANGE,
                },
                "tui",
            )
        ).payload,
        {
            capabilities: ["request", "stream", "streamResume"],
            protocolVersion: CONTROL_PROTOCOL_VERSION,
        },
    );
    assert.equal(
        (
            await request(
                harness.socketPath,
                "@control",
                "server.hello",
                {
                    clientKind: "tui",
                    protocolRange: { max: "2.0.0", min: "2.0.0" },
                },
                "tui",
            )
        ).error?.code,
        "protocol.versionUnsupported",
    );
    assert.equal(
        (
            await request(
                harness.socketPath,
                "@control",
                "server.hello",
                {
                    clientKind: "web",
                    protocolRange: CONTROL_PROTOCOL_RANGE,
                },
                "web",
            )
        ).error?.code,
        "control.clientIdentityInvalid",
    );

    const listed = (
        await request(harness.socketPath, "@control", "config.listInstances")
    ).payload as Array<{
        name: string;
    }>;
    assert.equal(listed[0]?.name, "alpha");

    const overview = (
        await request(harness.socketPath, "@control", "overview.get")
    ).payload as {
        counts: { instancesAttention: number; instancesTotal: number };
    };
    assert.equal(overview.counts.instancesTotal, 1);
    assert.equal(overview.counts.instancesAttention, 0);

    const snapshot = await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "process.snapshot",
    );
    assert.equal((snapshot.payload as { lastSeq: number }).lastSeq, 0);

    const goals = await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "task.getGoals",
    );
    assert.deepEqual(goals.payload, { goals: [], lastSeq: 0 });

    await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "process.readLogs",
        { limit: 1_000 },
    );
    assert.deepEqual(harness.worker.lastReadLogsQuery, {
        fromSeq: undefined,
        limit: 100,
        maxDecodedBytes: 1024 * 1024,
    });

    harness.worker.toolCalls = [1, 2, 3].map((index): ToolCallRecord => ({
        callId: `large-call-${index}`,
        inputSummary: `large-call-${index}`,
        instance: asInstanceName("alpha"),
        output: { text: "x".repeat(3 * 1024 * 1024) },
        source: "cli",
        startedAt: `2026-09-01T00:00:0${index}.000Z`,
        status: "completed",
        toolName: "bash_run",
    }));
    const boundedToolCalls = await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "tool.listCalls",
    );
    assert.deepEqual(harness.worker.lastReadToolCallsQuery, { limit: 200 });
    assert.equal(Array.isArray(boundedToolCalls.payload), true);
    const boundedToolCallIds = Array.isArray(boundedToolCalls.payload)
        ? boundedToolCalls.payload.map(readToolCallId)
        : [];
    assert.deepEqual(boundedToolCallIds, ["large-call-2", "large-call-3"]);
    assert.equal(
        Buffer.byteLength(JSON.stringify(boundedToolCalls.payload), "utf8") <=
            8 * 1024 * 1024,
        true,
    );

    harness.worker.toolCalls = [
        {
            ...harness.worker.toolCalls[0]!,
            callId: "oversized-call",
            output: { text: "x".repeat(9 * 1024 * 1024) },
        },
    ];
    const oversizedToolCall = await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "tool.listCalls",
        { callIds: ["oversized-call"], limit: 1 },
    );
    assert.equal(
        oversizedToolCall.error?.code,
        controlErrorCodes.invalidTarget,
    );
    assert.match(oversizedToolCall.error?.message ?? "", /safe response size/u);

    const toolReply = await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "tool.call",
        {
            input: { command: "pwd" },
            toolName: "bash_run",
            workspace: "/tmp/ws",
        },
        "tui",
    );
    assert.equal((toolReply.payload as { exitCode: number }).exitCode, 0);
    assert.equal(harness.worker.lastToolCall?.source, "tui");
    assert.equal(typeof harness.worker.lastToolCall?.requestId, "string");
    assert.equal(typeof harness.worker.lastToolCall?.ctxId, "string");

    const rejectedWeb = await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "tool.call",
        {
            input: { command: "pwd" },
            toolName: "bash_run",
            workspace: "/tmp/ws",
        },
        "web",
    );
    assert.equal(rejectedWeb.error?.code, "control.clientIdentityInvalid");
    assert.equal(harness.worker.lastToolCall?.source, "tui");

    await assert.rejects(
        request(
            harness.socketPath,
            asInstanceName("missing"),
            "process.snapshot",
        ),
        /No route for missing:process/u,
    );

    const missingOperation = await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "process.missing",
    );
    assert.equal(missingOperation.error?.code, "method_not_found");
});

test("local Control socket loads and rolls back a protected debug patch on a live worker object", async (t) => {
    const directory = await createTestTempDirectory("control-debug-rpc");
    const socketPath = createTestIpcPath("control-debug-rpc", directory);
    const worker = new FakeWorker("alpha");
    const registry = new InstanceRegistry([createDescriptor(worker)]);
    const debug = new DebugPatchService(registry);
    const routes = new ControlRouteComposition({
        debug,
        instanceDomains: createTestInstanceDomainRuntime(),
        instances: registry,
        shutdown() {},
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => debug.dispose(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    assert.deepEqual(
        (await request(socketPath, "@control", "debug.targets")).payload,
        [{ methods: ["callTool"], target: "worker:alpha" }],
    );
    const loaded = (
        await request(socketPath, "@control", "debug.load", {
            scope: { ctxId: "ctx-own", toolName: "file_read" },
            source: `() => ({ action: "return", value: { patched: true } })`,
            target: "worker:alpha",
        })
    ).payload as { patchId: string; state: string };
    assert.equal(loaded.state, "active");

    assert.deepEqual(
        await worker.callTool(
            "file_read",
            {},
            { ctxId: "ctx-own", source: "mcp" },
        ),
        { patched: true },
    );
    assert.deepEqual(
        await worker.callTool(
            "file_read",
            {},
            { ctxId: "ctx-other", source: "mcp" },
        ),
        { exitCode: 0 },
    );
    assert.equal(worker.lastToolCall?.ctxId, "ctx-other");

    const listed = (await request(socketPath, "@control", "debug.list"))
        .payload as Array<{
        patchId: string;
        state: string;
    }>;
    assert.equal(listed[0]?.patchId, loaded.patchId);
    assert.equal(listed[0]?.state, "active");

    const unloaded = (
        await request(socketPath, "@control", "debug.unload", {
            patchId: loaded.patchId,
        })
    ).payload as { state: string };
    assert.equal(unloaded.state, "unloaded");
    assert.deepEqual(
        await worker.callTool(
            "file_read",
            {},
            { ctxId: "ctx-own", source: "mcp" },
        ),
        { exitCode: 0 },
    );
    assert.equal(worker.lastToolCall?.ctxId, "ctx-own");
});

test("config RPC masks the Web token across get, validate, and update responses", async (t) => {
    const directory = await createTestTempDirectory("config-rpc-secret");
    const homeDirectory = join(directory, "home");
    const socketPath = createTestIpcPath("control-config-rpc", directory);
    const strongToken = "a".repeat(48);
    const configStore = new ControlConfigStore();
    let config = createDefaultControlConfig();
    config.web.auth = { mode: "token", token: strongToken };
    await configStore.write(config, homeDirectory);

    const registry = new InstanceRegistryFactory().build(config);
    const editor = new ConfigEditorCoordinator({
        configStore,
        getConfig: () => config,
        homeDirectory,
        runtimePreflight: { async assertAvailable() {} },
        setConfig: (next) => {
            config = next;
        },
    });
    const routes = new ControlRouteComposition({
        config: editor,
        instanceDomains: createTestInstanceDomainRuntime(),
        instances: registry,
        shutdown() {},
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    const getReply = await request(socketPath, "@control", "config.get");
    assert.equal(getReply.error, undefined);
    const getPayload = getReply.payload as Record<string, JsonValue>;
    assert.equal(
        (getPayload.web as Record<string, JsonValue>).token,
        MASKED_CONFIG_TOKEN,
    );
    assert.equal(JSON.stringify(getPayload).includes(strongToken), false);

    const instances = (
        getPayload.instances as Array<Record<string, JsonValue>>
    ).map((instance) => {
        const security = instance.security as Record<string, JsonValue>;
        return { ...instance, security: { mode: security.mode } };
    });
    const validateReply = await request(
        socketPath,
        "@control",
        "config.validate",
        {
            ...getPayload,
            instances,
        },
    );
    assert.equal(validateReply.error, undefined);
    assert.equal(
        (
            (validateReply.payload as Record<string, JsonValue>).web as Record<
                string,
                JsonValue
            >
        ).token,
        MASKED_CONFIG_TOKEN,
    );
    assert.equal(
        JSON.stringify(validateReply.payload).includes(strongToken),
        false,
    );

    const updateReply = await request(socketPath, "@control", "config.update", {
        web: { auth: "token", token: MASKED_CONFIG_TOKEN },
    });
    assert.equal(updateReply.error, undefined);
    assert.equal(
        JSON.stringify(updateReply.payload).includes(strongToken),
        false,
    );
    assert.deepEqual(config.web.auth, { mode: "token", token: strongToken });
    assert.deepEqual((await configStore.readOrCreate(homeDirectory)).web.auth, {
        mode: "token",
        token: strongToken,
    });
});

test("ControlSocketServer exposes server-backed Message preferences through the control route", async (t) => {
    const directory = await createTestTempDirectory(
        "message-preference-rpc",
    );
    const socketPath = createTestIpcPath(
        "message-preference-rpc",
        directory,
    );
    const comment = new CommentExtension({
        instances: {
            list: () => [],
            onChange: () => () => undefined,
        },
        preferencesFile: join(directory, "message-preferences.json"),
    });
    const routes = new ControlRouteComposition({
        extensionRoutes: {
            modules(scope) {
                return scope === "control" ? comment.routes.control() : [];
            },
            onChange() {
                return () => undefined;
            },
        },
        instanceDomains: createTestInstanceDomainRuntime(),
        instances: new InstanceRegistry([]),
        shutdown() {},
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => comment.close(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    const initialPreferences = await request(
        socketPath,
        "@control",
        "message.preferences",
        undefined,
        "tui",
    );
    assert.equal(
        initialPreferences.error,
        undefined,
        JSON.stringify(initialPreferences.error),
    );
    assert.deepEqual(initialPreferences.payload, {
        hiddenContexts: {},
        orderByWorkspace: {},
        titles: {},
        version: 1,
        workspaceOrder: [],
    });

    const updated = (
        await request(
            socketPath,
            "@control",
            "message.updatePreferences",
            {
                orderByWorkspace: {
                    "/work/portable-devshell": [
                        "alpha\u0000ctx-b",
                        "alpha\u0000ctx-a",
                    ],
                },
                titles: { "alpha\u0000ctx-a": "Audit regression" },
                workspaceOrder: ["/work/portable-devshell"],
            },
            "tui",
        )
    ).payload;
    assert.deepEqual(updated, {
        hiddenContexts: {},
        orderByWorkspace: {
            "/work/portable-devshell": ["alpha\u0000ctx-b", "alpha\u0000ctx-a"],
        },
        titles: { "alpha\u0000ctx-a": "Audit regression" },
        version: 1,
        workspaceOrder: ["/work/portable-devshell"],
    });
    assert.deepEqual(
        (
            await request(
                socketPath,
                "@control",
                "message.preferences",
                undefined,
                "tui",
            )
        ).payload,
        updated,
    );
    assert.equal(
        (
            await request(
                socketPath,
                "@control",
                "message.updatePreferences",
                { unknown: true },
                "tui",
            )
        ).error?.code,
        controlErrorCodes.invalidTarget,
    );
});

test("ControlSocketServer rebuilds route bindings after registry changes", async (t) => {
    const directory = await createTestTempDirectory("route-snapshot");
    const socketPath = createTestIpcPath("control-rpc", directory);
    const registry = new InstanceRegistry([]);
    const routes = new ControlRouteComposition({
        instanceDomains: createTestInstanceDomainRuntime(),
        instances: registry,
        shutdown() {},
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    await assert.rejects(
        request(socketPath, asInstanceName("alpha"), "process.snapshot"),
        /No route for alpha:process/u,
    );

    registry.add(createDescriptor(new FakeWorker("alpha")));

    const after = await request(
        socketPath,
        asInstanceName("alpha"),
        "process.snapshot",
    );
    assert.equal(after.error, undefined);
    assert.equal(
        (after.payload as { snapshot: { name: string } }).snapshot.name,
        "alpha",
    );
});

test("interactive runtime receives stream input while the root handler is still running", async (t) => {
    const activeTodos: ActiveTodoSummary[] = [
        {
            completed: 1,
            currentItem: "Verify release lifecycle",
            revision: 3,
            status: "in_progress",
            taskId: "release-review",
            title: "Release review",
            total: 2,
        },
    ];
    const harness = await createHarness(activeTodos);
    t.after(() => harness.cleanup());
    const client = createClient(harness.socketPath, "cli");
    await negotiateClient(client, "cli");
    const stream = await client.open(
        asInstanceName("alpha"),
        "process",
        "start",
        {},
    );
    t.after(() => void stream.close());

    await stream.send({
        name: "input",
        payload: { data: Buffer.from("hello").toString("base64") },
    });

    const output = await readStreamData(stream);
    assert.equal(output.name, "output");
    assert.deepEqual(output.payload, { chunk: "echo:hello" });

    const completed = await stream.readMessage();
    assert.equal(completed.type, "close");
    assert.equal((completed.message as { ready: boolean }).ready, true);
    assert.deepEqual(
        (completed.message as { activeTodos?: ActiveTodoSummary[] })
            .activeTodos,
        activeTodos,
    );

    const stopped = await request(
        harness.socketPath,
        asInstanceName("alpha"),
        "process.stop",
    );
    assert.deepEqual(
        (stopped.payload as { activeTodos?: ActiveTodoSummary[] }).activeTodos,
        activeTodos,
    );
});

test("terminal RPC streams real session input, resize, detach, and sequence resume", async (t) => {
    const directory = await createTestTempDirectory("terminal-rpc");
    const socketPath = createTestIpcPath("terminal-rpc", directory);
    const process = new FakeTerminalProcess();
    const descriptor = createTestInstanceDescriptor(
        new FakeWorker("alpha") as unknown as WorkerInstance,
        {
            name: "alpha",
        },
    );
    const routes = new ControlRouteComposition({
        instanceDomains: createTestInstanceDomainRuntime({
            services: () => ({
                terminal: { open: async () => process },
            }),
        }),
        instances: new InstanceRegistry([descriptor]),
        shutdown() {},
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    const client = createClient(socketPath, "tui");
    await negotiateClient(client, "tui");
    const opened = await client.request<{
        generation: number;
        terminalId: string;
    }>(asInstanceName("alpha"), "terminal", "open", {
        cols: 80,
        rows: 24,
        workspace: "/tmp/ws",
    });
    process.emit("before-attach");

    const attached = await client.open(
        asInstanceName("alpha"),
        "terminal",
        "attach",
        {
            fromSeq: 0,
            generation: opened.generation,
            terminalId: opened.terminalId,
        },
    );
    t.after(() => void attached.close());
    const seed = await readStreamData(attached);
    assert.equal(seed.name, "seed");
    assert.equal(
        (seed.payload as { session: { terminalId: string } }).session
            .terminalId,
        opened.terminalId,
    );
    const replay = await readStreamData(attached);
    assert.equal(replay.name, "output");
    assert.deepEqual(replay.payload, { data: "before-attach", seq: 1 });

    await attached.send({
        name: "input",
        payload: {
            clientSeq: 1,
            data: "printf ok\r",
            generation: opened.generation,
            terminalId: opened.terminalId,
            version: 1,
        },
    });
    const inputAccepted = await readStreamData(attached);
    assert.equal(inputAccepted.name, "inputAccepted");
    assert.deepEqual(inputAccepted.payload, {
        clientSeq: 1,
        generation: opened.generation,
        requestId: (inputAccepted.payload as { requestId: string }).requestId,
        terminalId: opened.terminalId,
        version: 1,
    });

    await attached.send({
        name: "resize",
        payload: {
            clientSeq: 2,
            cols: 120,
            generation: opened.generation,
            rows: 40,
            terminalId: opened.terminalId,
            version: 1,
        },
    });
    const resized = await readStreamData(attached);
    assert.equal(resized.name, "resized");
    assert.deepEqual(resized.payload, {
        clientSeq: 2,
        generation: opened.generation,
        requestId: (resized.payload as { requestId: string }).requestId,
        terminalId: opened.terminalId,
        version: 2,
    });
    assert.deepEqual(process.inputs, ["printf ok\r"]);
    assert.deepEqual(process.resizes, [{ cols: 120, rows: 40 }]);

    process.emit("live");
    assert.deepEqual((await readStreamData(attached)).payload, {
        data: "live",
        seq: 2,
    });
    await attached.send({
        name: "ack",
        payload: {
            generation: opened.generation,
            terminalId: opened.terminalId,
            throughSeq: 2,
            version: 2,
        },
    });
    await attached.close();
    process.emit("detached");
    assert.equal(process.killed, false);

    const resumed = await client.open(
        asInstanceName("alpha"),
        "terminal",
        "attach",
        {
            fromSeq: 2,
            generation: opened.generation,
            terminalId: opened.terminalId,
        },
    );
    t.after(() => void resumed.close());
    assert.equal((await readStreamData(resumed)).name, "seed");
    assert.deepEqual((await readStreamData(resumed)).payload, {
        data: "detached",
        seq: 3,
    });

    await client.request(asInstanceName("alpha"), "terminal", "kill", {
        generation: opened.generation,
        terminalId: opened.terminalId,
        version: 2,
    });
    assert.equal(process.killed, true);
});

test("terminal stream cancels a slow attachment at the unacknowledged window without killing the PTY", async (t) => {
    const directory = await createTestTempDirectory("terminal-window");
    const socketPath = createTestIpcPath("terminal-window", directory);
    const process = new FakeTerminalProcess();
    const descriptor = createTestInstanceDescriptor(
        new FakeWorker("alpha") as unknown as WorkerInstance,
        { name: "alpha" },
    );
    const routes = new ControlRouteComposition({
        instanceDomains: createTestInstanceDomainRuntime({
            services: () => ({
                terminal: { open: async () => process },
            }),
        }),
        instances: new InstanceRegistry([descriptor]),
        shutdown() {},
        terminalMaxUnackedBytes: 8,
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    const client = createClient(socketPath, "tui");
    await negotiateClient(client, "tui");
    const opened = await client.request<{
        generation: number;
        terminalId: string;
    }>(asInstanceName("alpha"), "terminal", "open", {
        cols: 80,
        rows: 24,
        workspace: "/tmp/ws",
    });
    const attached = await client.open(
        asInstanceName("alpha"),
        "terminal",
        "attach",
        {
            fromSeq: 0,
            generation: opened.generation,
            terminalId: opened.terminalId,
        },
    );
    assert.equal((await readStreamData(attached)).name, "seed");
    process.emit("12345");
    process.emit("67890");

    await assert.rejects(
        async () => {
            while (true) await attached.readMessage();
        },
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "stream.gap");
            return true;
        },
    );
    assert.equal(process.killed, false);

    const resumed = await client.open(
        asInstanceName("alpha"),
        "terminal",
        "attach",
        {
            fromSeq: 0,
            generation: opened.generation,
            terminalId: opened.terminalId,
        },
    );
    assert.equal((await readStreamData(resumed)).name, "seed");
    assert.deepEqual((await readStreamData(resumed)).payload, {
        data: "12345",
        seq: 1,
    });
    await resumed.close();
});

test("service.shutdown replies before invoking the shutdown action", async (t) => {
    const directory = await createTestTempDirectory("shutdown-reply");
    const socketPath = createTestIpcPath("control-rpc", directory);
    let shutdownRequested = false;
    const routes = new ControlRouteComposition({
        instanceDomains: createTestInstanceDomainRuntime(),
        instances: new InstanceRegistry([]),
        shutdown() {
            shutdownRequested = true;
        },
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    const reply = await request(socketPath, "@control", "service.shutdown");
    assert.deepEqual(reply.payload, { accepted: true });
    await waitFor(() => shutdownRequested);
});

async function createHarness(
    activeTodos: ActiveTodoSummary[] = [],
): Promise<Harness> {
    const directory = await createTestTempDirectory("control-socket");
    const socketPath = createTestIpcPath("control-rpc", directory);
    const worker = new FakeWorker("alpha");
    const registry = new InstanceRegistry([createDescriptor(worker)]);
    const routes = new ControlRouteComposition({
        instanceDomains: createTestInstanceDomainRuntime({
            services: () => ({ task: createActiveTodosTask(activeTodos) }),
        }),
        instances: registry,
        shutdown() {},
        toolCalls: {
            async call(_instance, toolName, input, context) {
                return await worker.callTool(toolName, input, {
                    ctxId: context.ctxId,
                    requestId: context.requestId,
                    source: context.source,
                });
            },
        },
    });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    return {
        async cleanup() {
            await cleanupInOrder(
                () => server.stop(),
                () => routes.dispose(),
                () => rm(directory, { force: true, recursive: true }),
            );
        },
        registry,
        routes,
        server,
        socketPath,
        worker,
    };
}

function createDescriptor(worker: FakeWorker) {
    return createTestInstanceDescriptor(worker as unknown as WorkerInstance, {
        name: "alpha",
    });
}

function createActiveTodosTask(activeTodos: ActiveTodoSummary[]) {
    return createTestTaskApi({
        todo: {
            ...createTestTaskApi().todo,
            summaries: () => activeTodos,
        },
    });
}

interface TestClient {
    close(): void;
    open(
        host: string,
        port: string,
        name: string,
        payload?: JsonValue,
    ): Promise<MessageStream>;
    request<T = JsonValue>(
        host: string,
        port: string,
        operation: string,
        payload?: JsonValue,
    ): Promise<T>;
}

function createClient(
    socketPath: string,
    _peer: "cli" | "tui" | "web",
): TestClient {
    const endpoint = new Endpoint({
        connectChannel: (signal) =>
            LocalChannel.connect(socketPath, { signal }),
    });
    const protocols: Array<Rpc | Stream> = [];
    const rpcs = new Map<string, Rpc>();
    return {
        close() {
            for (const protocol of protocols) protocol.close();
            endpoint.close();
        },
        async open(host, port, name, payload) {
            const protocol = new Stream(await endpoint.connect(host, port));
            protocols.push(protocol);
            return await protocol.open(name, payload);
        },
        async request<T = JsonValue>(
            host: string,
            port: string,
            operation: string,
            payload?: JsonValue,
        ) {
            const key = `${host}\u0000${port}`;
            let rpc = rpcs.get(key);
            if (rpc === undefined) {
                rpc = new Rpc(await endpoint.connect(host, port));
                rpcs.set(key, rpc);
                protocols.push(rpc);
            }
            return (await rpc.request(operation, payload)) as T;
        },
    };
}

async function negotiateClient(
    connection: TestClient,
    peer: "cli" | "tui" | "web",
): Promise<void> {
    await connection.request("@control", "service", "hello", {
        clientKind: peer,
        protocolRange: CONTROL_PROTOCOL_RANGE,
    });
}

function readToolCallId(value: JsonValue): string {
    if (value === null || Array.isArray(value) || typeof value !== "object")
        throw new Error("tool.listCalls returned a non-object record");
    if (typeof value.callId !== "string")
        throw new Error("tool.listCalls returned a record without callId");
    return value.callId;
}

interface RequestResult {
    error?: RemoteErrorBody;
    payload?: JsonValue;
}

async function request(
    socketPath: string,
    destination: string,
    name: string,
    payload?: JsonValue,
    peer: "cli" | "tui" | "web" = "cli",
): Promise<RequestResult> {
    const [port, operation] = name.split(".");
    const connection = createClient(socketPath, peer);
    try {
        if (name !== "server.hello") await negotiateClient(connection, peer);
        return {
            payload: (await connection.request(
                destination,
                port!,
                operation!,
                payload,
            )) as JsonValue,
        };
    } catch (error) {
        const body = toRemoteErrorBody(error);
        if (body === undefined || body.code === "error.unknown") throw error;
        return { error: body };
    } finally {
        connection.close();
    }
}

async function readStreamData(
    stream: MessageStream,
): Promise<ControlStreamMessage> {
    const next = await stream.readMessage();
    assert.equal(next.type, "data");
    return next.message as ControlStreamMessage;
}

class FakeTerminalProcess implements TerminalProcess {
    readonly inputs: string[] = [];
    readonly resizes: Array<{ cols: number; rows: number }> = [];
    killed = false;
    readonly #data = new Set<(data: string) => void>();
    readonly #exit = new Set<(exit: TerminalProcessExit) => void>();

    emit(data: string): void {
        for (const listener of [...this.#data]) listener(data);
    }

    exit(exit: TerminalProcessExit): void {
        for (const listener of [...this.#exit]) listener(exit);
    }

    kill(): void {
        this.killed = true;
    }

    onData(listener: (data: string) => void): () => void {
        this.#data.add(listener);
        return () => this.#data.delete(listener);
    }

    onExit(listener: (exit: TerminalProcessExit) => void): () => void {
        this.#exit.add(listener);
        return () => this.#exit.delete(listener);
    }

    resize(cols: number, rows: number): void {
        this.resizes.push({ cols, rows });
    }

    write(data: string): void {
        this.inputs.push(data);
    }
}

class FakeWorker {
    readonly #name: string;
    readonly #events: Array<{
        at: string;
        data?: JsonValue;
        instanceName: string;
        seq: number;
        type: string;
    }> = [];
    #lastSeq = 0;
    #ready = false;
    lastReadLogsQuery?: { fromSeq?: number; limit?: number };
    lastReadToolCallsQuery?: ToolCallQuery;
    lastToolCall?: { ctxId?: string; requestId?: string; source?: string };
    toolCalls: ToolCallRecord[] = [];

    constructor(name: string) {
        this.#name = name;
    }

    snapshot() {
        return {
            connectionState: this.#ready ? "connected" : "disconnected",
            daemonState: this.#ready ? "running" : "stopped",
            lastSeq: this.#lastSeq,
            name: asInstanceName(this.#name),
            ready: this.#ready,
            status: this.#ready ? "ready" : "stopped",
        };
    }

    async refreshStatus() {
        return this.snapshot();
    }

    async startInteractive(session: WorkerCommandInteractiveSession) {
        const input = await session.readInput();
        await session.writeOutput(`echo:${input?.toString("utf8") ?? ""}`);
        this.#ready = true;
        return this.snapshot();
    }

    async stop() {
        this.#ready = false;
        return this.snapshot();
    }

    async readLogs(query: { fromSeq?: number; limit?: number }) {
        this.lastReadLogsQuery = query;
        return [
            {
                at: new Date(0).toISOString(),
                instanceName: asInstanceName(this.#name),
                message: "ready\n",
                seq: 1,
                stream: "stdout" as const,
            },
        ];
    }

    async callTool(
        _toolName: string,
        _input: JsonValue,
        options: { ctxId?: string; requestId?: string; source?: string },
    ) {
        this.lastToolCall = options;
        return { exitCode: 0 };
    }

    readToolCalls(query: ToolCallQuery = {}) {
        this.lastReadToolCallsQuery = query;
        return this.toolCalls;
    }

    listApprovals() {
        return [];
    }

    getApproval() {
        throw new Error("unused");
    }

    decideApproval() {
        throw new Error("unused");
    }

    subscribe(fromSeq = 1) {
        const nextSeq = this.#events[0]?.seq ?? this.#lastSeq + 1;
        if (fromSeq < nextSeq) {
            return { kind: "gap" as const, lastSeq: this.#lastSeq, nextSeq };
        }
        return {
            events: this.#events.filter((event) => event.seq >= fromSeq),
            kind: "events" as const,
            lastSeq: this.#lastSeq,
        };
    }
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 1_000,
): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error("condition was not met");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
