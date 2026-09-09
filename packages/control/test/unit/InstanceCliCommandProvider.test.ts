import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type InstanceEvent,
    type InstanceSnapshot,
    type JsonValue,
    type TodoReadResult
} from "@portable-devshell/shared";

import type { InstanceDescriptor } from "../../src/control/instance/InstanceDescriptor.ts";
import type { InstanceRegistry } from "../../src/control/instance/registry/InstanceRegistry.ts";
import {
    createInstanceCliCommandProvider,
    executeInstanceCommand,
    type InstanceCliCommandProviderOptions
} from "../../src/control/instance/cli/InstanceCliCommandProvider.ts";
import type { RuntimeSubscriptionManager } from "../../src/instance/runtime/RuntimeSubscriptionManager.ts";
import type {
    CliExtensionCommandInvocationContext,
    CliExtensionCommandIo
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
    enabled?: boolean;
    readLogs?: (query?: { fromSeq?: number }) => Promise<Array<{ message: string; seq: number; stream: "stderr" | "stdout" }>>;
    startInteractive?: (session?: { readInput(): Promise<Buffer | undefined>; writeOutput(chunk: string): Promise<void> }) => Promise<InstanceSnapshot>;
    stop?: () => Promise<InstanceSnapshot>;
    callTool?: (toolName: string, input: JsonValue, context: unknown, signal?: AbortSignal) => Promise<JsonValue>;
    currentSnapshot?: () => InstanceSnapshot;
    todoRead?: () => Promise<TodoReadResult>;
} = {}): InstanceDescriptor {
    const currentSnapshot = overrides.currentSnapshot ?? (() => snapshot());
    return {
        enabled: overrides.enabled ?? true,
        mcpCapabilities: [],
        mcpEnabled: true,
        mcpGroups: [],
        mcpPath: "/mcp/demo-local",
        name: "demo-local",
        provider: "local",
        todo: {
            read: overrides.todoRead ?? (async () => todoNone()),
            summaries: () => []
        },
        worker: {
            callTool: overrides.callTool ?? (async () => ({ exitCode: 0, stderr: "", stdout: "/repo\n" })),
            readLogs: overrides.readLogs ?? (async () => []),
            snapshot: currentSnapshot,
            startInteractive: overrides.startInteractive ?? (async () => snapshot("ready", 1)),
            stop: overrides.stop ?? (async () => snapshot("stopped", 2)),
            subscribe: () => ({ events: [], kind: "events", lastSeq: currentSnapshot().lastSeq })
        }
    } as unknown as InstanceDescriptor;
}

function options(
    current: InstanceDescriptor,
    overrides: Partial<InstanceCliCommandProviderOptions> = {}
): InstanceCliCommandProviderOptions {
    const registry = {
        clearOwned() {},
        delete() {},
        get(name: string) {
            return name === current.name ? current : undefined;
        },
        list() {
            return [current];
        },
        markOwned() {}
    } as unknown as InstanceRegistry;
    return {
        create: {
            async createInstance() {
                return { enabled: true, name: "created-local", snapshot: snapshot("ready", 1) };
            },
            getSchema() {
                throw new Error("unused");
            },
            validateDraft() {
                throw new Error("unused");
            }
        },
        editor: {
            async deleteInstance() { return {}; },
            async disableInstance() { return {}; },
            async enableInstance() { return {}; }
        },
        instances: registry,
        subscriptions: {
            async watch() {}
        } as unknown as RuntimeSubscriptionManager,
        ...overrides
    };
}

function invocation(
    localOwner = true,
    io?: CliExtensionCommandIo,
    controller = new AbortController()
): CliExtensionCommandInvocationContext {
    return {
        localOwner,
        requestId: "req-instance",
        signal: controller.signal,
        ...(io === undefined ? {} : { io })
    };
}

test("Instance command is a Control-resident cli.commands Extension provider", async () => {
    const provider = createInstanceCliCommandProvider(options(descriptor()));
    assert.equal(provider.extensionId, "instance");
    assert.equal(provider.declaration.id, "instance");
    const help = await provider.binding(["help"], invocation());
    assert.equal(help.kind, "text");
    assert.match(help.text, /devshell instance logs <instance> \[-f\]/u);
});

test("instance read-only commands are available without local-owner privilege", async () => {
    const result = await executeInstanceCommand(options(descriptor()), ["status", "demo-local"], invocation(false));
    assert.equal(result.kind, "text");
    assert.match(result.text, /instance: demo-local/u);
    assert.match(result.text, /status: stopped/u);
});

test("instance mutation and tool-call commands are owner-only", async () => {
    const current = descriptor();
    for (const args of [
        ["delete", "demo-local"],
        ["enable", "demo-local"],
        ["disable", "demo-local"],
        ["start", "demo-local"],
        ["stop", "demo-local"],
        ["call", "demo-local", "/repo", "bash_run", "{}"]
    ]) {
        await assert.rejects(
            async () => await executeInstanceCommand(options(current), args, invocation(false)),
            (error: unknown) => typeof error === "object" && error !== null && "code" in error
                && error.code === "control.cliAccessDenied"
        );
    }
});

test("instance start requests raw input and streams Worker startup output through resident I/O", async () => {
    const stderr: string[] = [];
    const terminalRequests: Array<{ raw?: boolean }> = [];
    const current = descriptor({
        startInteractive: async (session) => {
            assert.ok(session);
            await session.writeOutput("worker boot\n");
            return snapshot("ready", 3);
        }
    });
    const io: CliExtensionCommandIo = {
        async readInput() { return undefined; },
        async requestInput(request) { terminalRequests.push(request ?? {}); },
        async writeStderr(chunk) { stderr.push(chunk); },
        async writeStdout() {}
    };

    const result = await executeInstanceCommand(options(current), ["start", "demo-local"], invocation(true, io));
    assert.equal(result.kind, "text");
    assert.match(result.text, /status: ready/u);
    assert.deepEqual(terminalRequests, [{ raw: true }]);
    assert.deepEqual(stderr, ["worker boot\n"]);
});

test("instance logs follow uses the shared subscription owner and streams only newly pulled logs", async () => {
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

    const result = await executeInstanceCommand(
        options(current, { subscriptions }),
        ["logs", "demo-local", "-f"],
        invocation(true, io)
    );
    assert.equal(result.kind, "text");
    assert.equal(result.text, "");
    assert.equal(logRead, 2);
    assert.deepEqual(stdout, ["[1] stdout before\n", "[2] stdout after\n"]);
});

test("instance todo follow reloads current state on todo events", async () => {
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

    await executeInstanceCommand(
        options(current, { subscriptions }),
        ["todo", "demo-local", "--follow"],
        invocation(true, io)
    );
    assert.equal(reads, 2);
    assert.deepEqual(stdout, ["Todo: none\n", "Todo: none\n"]);
});

test("instance call preserves tool result rendering while moving provenance into the provider", async () => {
    let context: unknown;
    const current = descriptor({
        callTool: async (_toolName, _input, received) => {
            context = received;
            return { exitCode: 0, stderr: "", stdout: "/repo\n" };
        }
    });
    const result = await executeInstanceCommand(
        options(current),
        ["call", "demo-local", "/repo", "bash_run", "{\"command\":\"pwd\"}"],
        invocation()
    );
    assert.equal(result.kind, "text");
    assert.match(result.text, /tool: bash_run/u);
    assert.match(result.text, /stdout:\n\/repo/u);
    assert.deepEqual(context, {
        requestId: "req-instance",
        source: "cli",
        workspace: "/repo"
    });
});
