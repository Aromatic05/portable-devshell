import assert from "node:assert/strict";
import test from "node:test";

import type { McpContextRecord, ToolCallRecord } from "@portable-devshell/shared";
import type { CliModelCommandBinding } from "@portable-devshell/extension/cli";

import { CliExtensionCommandService } from "../../src/control/cli/CliExtensionCommandService.ts";
import { ModelDevshellBroker } from "../../src/control/cli/ModelDevshellBroker.ts";
import type { InstanceDescriptor } from "../../src/control/instance/InstanceDescriptor.ts";
import { InstanceRegistry } from "../../src/control/instance/registry/InstanceRegistry.ts";
import type { ContextAdminPort } from "../../src/control/mcp/ContextRouteModule.ts";
import type {
    WorkerDevshellCommandClose,
    WorkerDevshellCommandOpen
} from "@portable-devshell/core";

interface Harness {
    aborts: number;
    broker: ModelDevshellBroker;
    close(request: WorkerDevshellCommandClose): void;
    completions: Array<{ error?: string; exitCode: number; sessionId: string }>;
    contextConnects: Array<{ ctxId: string; instance: string; workspace?: string }>;
    faults: unknown[];
    outputs: Array<{ data: string; sessionId: string; stream: string }>;
    open(request: WorkerDevshellCommandOpen): void;
    setRecord(record: ToolCallRecord): void;
}

function harness(options: { allow?: boolean; contextWorkspace?: string } = {}): Harness {
    let closeListener: ((request: WorkerDevshellCommandClose) => void) | undefined;
    let openListener: ((request: WorkerDevshellCommandOpen) => void) | undefined;
    let aborts = 0;
    let record = toolRecord();
    const outputs: Harness["outputs"] = [];
    const completions: Harness["completions"] = [];
    const contextConnects: Harness["contextConnects"] = [];
    const faults: unknown[] = [];
    const worker = {
        appendControlEvent(type: string, data: unknown) {
            if (type === "worker.protocolIntegrityFault") faults.push(data);
            return Promise.resolve();
        },
        completeDevshellCommand(input: Harness["completions"][number]) {
            completions.push(input);
            return Promise.resolve();
        },
        onDevshellCommandClose(next: (request: WorkerDevshellCommandClose) => void) {
            closeListener = next;
            return () => {
                if (closeListener === next) closeListener = undefined;
            };
        },
        onDevshellCommandOpen(next: (request: WorkerDevshellCommandOpen) => void) {
            openListener = next;
            return () => {
                if (openListener === next) openListener = undefined;
            };
        },
        readToolCalls() {
            return Promise.resolve([record]);
        },
        writeDevshellCommandOutput(input: Harness["outputs"][number]) {
            outputs.push(input);
            return Promise.resolve();
        }
    };
    const descriptor = {
        name: "demo-local",
        worker
    } as unknown as InstanceDescriptor;
    const registry = new InstanceRegistry([descriptor]);
    const command: CliModelCommandBinding = async (argv, invocation) => {
        assert.equal(invocation.instance, "demo-local");
        assert.equal(invocation.workspace, options.contextWorkspace ?? "/repo");
        assert.notEqual(invocation.io, undefined);
        if (argv[0] === "wait") {
            await new Promise<void>((_resolve, reject) => {
                const onAbort = () => {
                    aborts += 1;
                    reject(invocation.signal.reason ?? new Error("aborted"));
                };
                if (invocation.signal.aborted) onAbort();
                else invocation.signal.addEventListener("abort", onAbort, { once: true });
            });
        }
        if (argv[0] === "connect") {
            return {
                kind: "json",
                value: await invocation.context.connectInstance(argv[1]!, argv[2])
            };
        }
        return { kind: "text", text: `probe:${argv.join("|")}` };
    };
    const commands = new CliExtensionCommandService(modelExtensionHost(command), { surface: "model" });
    const contextAdmin = {
        async connectInstance(ctxId: string, instance: string, workspace?: string) {
            contextConnects.push({ ctxId, instance, ...(workspace === undefined ? {} : { workspace }) });
            return { instance, workspace: workspace ?? null };
        },
        async validateForInstance(ctxId: string, instance: string) {
            assert.equal(ctxId, "ctx-a");
            assert.equal(instance, "demo-local");
            return {
                ctxId,
                instance,
                workspace: options.contextWorkspace ?? "/repo"
            } as McpContextRecord;
        }
    } as unknown as ContextAdminPort;
    const broker = new ModelDevshellBroker({
        access: { allows: () => options.allow !== false },
        commands,
        contextAdmin: () => contextAdmin,
        instances: registry
    });
    return {
        get aborts() {
            return aborts;
        },
        broker,
        close(request) {
            assert.notEqual(closeListener, undefined);
            closeListener!(request);
        },
        completions,
        contextConnects,
        faults,
        outputs,
        open(request) {
            assert.notEqual(openListener, undefined);
            openListener!(request);
        },
        setRecord(next) {
            record = next;
        }
    };
}

test("model devshell executes an allowed command only under matching active bash provenance", async (t) => {
    const h = harness();
    t.after(() => h.broker.dispose());
    h.open(openRequest({ argv: ["probe", "alpha"] }));
    await waitFor(() => h.completions.length === 1);

    assert.deepEqual(h.outputs, [{ data: "probe:alpha\n", sessionId: "session-a", stream: "stdout" }]);
    assert.deepEqual(h.completions, [{ exitCode: 0, sessionId: "session-a" }]);
    assert.deepEqual(h.faults, []);
});

test("model devshell Context operations use the authoritative audited ctxId", async (t) => {
    const h = harness();
    t.after(() => h.broker.dispose());
    h.open(openRequest({ argv: ["probe", "connect", "remote-test", "/remote/workspace"] }));
    await waitFor(() => h.completions.length === 1);

    assert.deepEqual(h.contextConnects, [{
        ctxId: "ctx-a",
        instance: "remote-test",
        workspace: "/remote/workspace"
    }]);
    assert.deepEqual(h.completions, [{ exitCode: 0, sessionId: "session-a" }]);
    assert.deepEqual(h.faults, []);
});

test("model devshell rejects a forged ctxId and records a Worker protocol integrity fault", async (t) => {
    const h = harness();
    t.after(() => h.broker.dispose());
    h.open(openRequest({ ctxId: "ctx-forged" }));
    await waitFor(() => h.completions.length === 1);

    assert.equal(h.completions[0]?.exitCode, 1);
    assert.equal(h.faults.length, 1);
    assert.match(h.outputs[0]?.data ?? "", /provenance does not match/u);
});

test("model devshell accepts a completed tmux task only when its audited task id matches", async (t) => {
    const h = harness();
    t.after(() => h.broker.dispose());
    h.setRecord(toolRecord({
        output: { task: { id: "task-a", status: "running" } },
        status: "completed",
        toolName: "tmux_run"
    }));
    h.open(openRequest({ taskId: "task-a" }));
    await waitFor(() => h.completions.length === 1);
    assert.equal(h.completions[0]?.exitCode, 0);
    assert.deepEqual(h.faults, []);

    h.open(openRequest({ sessionId: "session-b", taskId: "task-forged" }));
    await waitFor(() => h.completions.length === 2);
    assert.equal(h.completions[1]?.exitCode, 1);
    assert.equal(h.faults.length, 1);
});

test("model devshell ACL denial is command unavailable, not a Worker integrity fault", async (t) => {
    const h = harness({ allow: false });
    t.after(() => h.broker.dispose());
    h.open(openRequest());
    await waitFor(() => h.completions.length === 1);

    assert.deepEqual(h.completions, [{ exitCode: 127, sessionId: "session-a" }]);
    assert.deepEqual(h.faults, []);
    assert.equal(h.outputs[0]?.data, "CLI command probe is unavailable.\n");
});

test("Worker broker close aborts the active model command without recording an integrity fault", async (t) => {
    const h = harness();
    t.after(() => h.broker.dispose());
    h.open(openRequest({ argv: ["probe", "wait"] }));
    await new Promise<void>((resolve) => setImmediate(resolve));

    h.close({ sessionId: "session-a" });
    await waitFor(() => h.aborts === 1);

    assert.equal(h.aborts, 1);
    assert.deepEqual(h.faults, []);
});

function openRequest(overrides: Partial<WorkerDevshellCommandOpen> = {}): WorkerDevshellCommandOpen {
    return {
        argv: ["probe"],
        ctxId: "ctx-a",
        cwd: "/repo",
        parentCallId: "call-a",
        sessionId: "session-a",
        workspace: "/repo",
        ...overrides
    };
}

function toolRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
    return {
        callId: "call-a",
        ctxId: "ctx-a",
        inputSummary: "{}",
        instance: "demo-local" as never,
        source: "mcp",
        startedAt: new Date().toISOString(),
        status: "running",
        toolName: "bash_run",
        workspace: "/repo",
        ...overrides
    };
}

function modelExtensionHost(binding: CliModelCommandBinding) {
    return {
        async acquireRegistration(pointId: string, id: string) {
            assert.equal(pointId, "cli.model-commands");
            assert.equal(id, "probe");
            return {
                lease: { release() {} },
                registration: {
                    binding,
                    declaration: {
                        id: "probe",
                        summary: "Probe model command",
                        title: "Probe"
                    },
                    id: "probe",
                    pointId
                }
            } as never;
        },
        listDeclarations(pointId: string) {
            if (pointId !== "cli.model-commands") return [];
            return [{
                declaration: { id: "probe", summary: "Probe model command", title: "Probe" },
                extensionId: "probe-extension",
                generation: "test",
                id: "probe",
                pointId
            }];
        }
    } as never;
}

async function waitFor(condition: () => boolean): Promise<void> {
    for (let index = 0; index < 50; index += 1) {
        if (condition()) return;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.fail("condition was not reached");
}
