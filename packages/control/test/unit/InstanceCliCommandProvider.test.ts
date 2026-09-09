import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type InstanceEvent,
    type InstanceSnapshot,
    type TodoReadResult
} from "@portable-devshell/shared";

import type { InstanceDescriptor } from "../../src/control/instance/InstanceDescriptor.ts";
import type { InstanceRegistry } from "../../src/control/instance/registry/InstanceRegistry.ts";
import {
    createInstanceModelCliCommandProvider,
    executeInstanceModelCommand,
    type InstanceModelCliCommandProviderOptions
} from "../../src/control/instance/cli/InstanceCliCommandProvider.ts";
import type { RuntimeSubscriptionManager } from "../../src/instance/runtime/RuntimeSubscriptionManager.ts";
import type {
    CliExtensionCommandIo,
    CliModelExtensionCommandInvocationContext
} from "../../src/control/cli/CliExtensionCommandProvider.ts";

function snapshot(status: "ready" | "stopped" = "stopped", lastSeq = 0): InstanceSnapshot {
    return {
        connectionState: status === "ready" ? "connected" : "disconnected",
        daemonState: status === "ready" ? "running" : "stopped",
        lastSeq,
        name: asInstanceName("demo-local"),
        ready: status === "ready",
        status
    };
}

function todoNone(): TodoReadResult {
    return {
        items: [],
        revision: 0,
        summary: { completed: 0, total: 0 },
        tasks: []
    };
}

function descriptor(overrides: {
    currentSnapshot?: () => InstanceSnapshot;
    readLogs?: (query?: { fromSeq?: number }) => Promise<Array<{
        message: string;
        seq: number;
        stream: "stderr" | "stdout";
    }>>;
    todoRead?: () => Promise<TodoReadResult>;
} = {}): InstanceDescriptor {
    const currentSnapshot = overrides.currentSnapshot ?? (() => snapshot());
    return {
        enabled: true,
        mcpEnabled: true,
        mcpPath: "/mcp/demo-local",
        modelExtensions: ["instance"],
        name: "demo-local",
        provider: "local",
        todo: {
            read: overrides.todoRead ?? (async () => todoNone()),
            summaries: () => []
        },
        worker: {
            readLogs: overrides.readLogs ?? (async () => []),
            snapshot: currentSnapshot,
            subscribe: () => ({ events: [], kind: "events", lastSeq: currentSnapshot().lastSeq })
        }
    } as unknown as InstanceDescriptor;
}

function options(
    current: InstanceDescriptor,
    subscriptions: RuntimeSubscriptionManager = {
        async watch() {}
    } as unknown as RuntimeSubscriptionManager
): InstanceModelCliCommandProviderOptions {
    return {
        instances: {
            get(name: string) {
                return name === current.name ? current : undefined;
            },
            list() {
                return [current];
            }
        } as unknown as InstanceRegistry,
        subscriptions
    };
}

function invocation(
    io?: CliExtensionCommandIo,
    controller = new AbortController()
): CliModelExtensionCommandInvocationContext {
    return {
        requestId: "req-instance",
        signal: controller.signal,
        surface: "model",
        ...(io === undefined ? {} : { io })
    };
}

test("Instance command is a Control-resident cli.model-commands provider", async () => {
    const provider = createInstanceModelCliCommandProvider(options(descriptor()));
    assert.equal(provider.extensionId, "instance");
    assert.equal(provider.surface, "model");
    assert.deepEqual(provider.declaration, {
        id: "instance",
        summary: "Inspect portable-devshell instances",
        title: "Instance",
        usage: "instance <list|status|logs|todo>"
    });
    const help = await provider.binding(["help"], invocation());
    assert.equal(help.kind, "text");
    assert.match(help.text, /devshell instance status <instance>/u);
    assert.doesNotMatch(help.text, /instance start|instance delete/u);
});

test("Instance model commands expose inspection but not native lifecycle mutation", async () => {
    const current = descriptor();
    const status = await executeInstanceModelCommand(
        options(current),
        ["status", "demo-local"],
        invocation()
    );
    assert.equal(status.kind, "text");
    assert.match(status.text, /instance: demo-local/u);
    assert.match(status.text, /status: stopped/u);

    for (const command of ["create", "delete", "enable", "disable", "start", "stop", "call", "device-code"]) {
        await assert.rejects(
            async () => await executeInstanceModelCommand(
                options(current),
                [command, "demo-local"],
                invocation()
            ),
            (error: unknown) => typeof error === "object"
                && error !== null
                && "code" in error
                && error.code === "cli.usage"
        );
    }
});

test("instance model logs follow uses the shared subscription owner and streams new logs", async () => {
    let logRead = 0;
    const stdout: string[] = [];
    const current = descriptor({
        currentSnapshot: () => snapshot("ready", 10),
        readLogs: async (query) => {
            logRead += 1;
            if (query?.fromSeq === 1) return [{ message: "before\n", seq: 1, stream: "stdout" }];
            if (query?.fromSeq === 2) return [{ message: "after\n", seq: 2, stream: "stdout" }];
            return [];
        }
    });
    const subscriptions = {
        async watch(
            _instanceName: string,
            _worker: unknown,
            fromSeq: number,
            _signal: AbortSignal,
            handlers: { onEvent(event: InstanceEvent): Promise<void> | void }
        ) {
            assert.equal(fromSeq, 11);
            await handlers.onEvent({ seq: 11, type: "log.appended" } as InstanceEvent);
        }
    } as unknown as RuntimeSubscriptionManager;
    const io: CliExtensionCommandIo = {
        async readInput() { return undefined; },
        async requestInput() {},
        async writeStderr() {},
        async writeStdout(chunk) { stdout.push(chunk); }
    };

    const result = await executeInstanceModelCommand(
        options(current, subscriptions),
        ["logs", "demo-local", "-f"],
        invocation(io)
    );
    assert.equal(result.kind, "text");
    assert.equal(result.text, "");
    assert.equal(logRead, 2);
    assert.deepEqual(stdout, ["[1] stdout before\n", "[2] stdout after\n"]);
});

test("instance model todo follow reloads current state on todo events", async () => {
    let reads = 0;
    const stdout: string[] = [];
    const current = descriptor({
        currentSnapshot: () => snapshot("ready", 4),
        todoRead: async () => {
            reads += 1;
            return {
                items: [],
                revision: reads,
                summary: { completed: 0, total: 0 },
                tasks: []
            };
        }
    });
    const subscriptions = {
        async watch(
            _instanceName: string,
            _worker: unknown,
            fromSeq: number,
            _signal: AbortSignal,
            handlers: { onEvent(event: InstanceEvent): Promise<void> | void }
        ) {
            assert.equal(fromSeq, 5);
            await handlers.onEvent({ seq: 5, type: "todo.updated" } as InstanceEvent);
        }
    } as unknown as RuntimeSubscriptionManager;
    const io: CliExtensionCommandIo = {
        async readInput() { return undefined; },
        async requestInput() {},
        async writeStderr() {},
        async writeStdout(chunk) { stdout.push(chunk); }
    };

    await executeInstanceModelCommand(
        options(current, subscriptions),
        ["todo", "demo-local", "--follow"],
        invocation(io)
    );
    assert.equal(reads, 2);
    assert.deepEqual(stdout, ["Todo: none\n", "Todo: none\n"]);
});
