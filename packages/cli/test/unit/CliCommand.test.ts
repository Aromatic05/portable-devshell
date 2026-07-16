import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { CliMain } from "../../dist/CliMain.js";

test("CliMain handles control lifecycle commands and exit code mapping", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    const lifecycle = {
        async logs() {
            return "line-1\n";
        },
        async start() {
            return { instanceCount: 1, pid: 10, running: true };
        },
        async status() {
            return { instanceCount: 1, pid: 10, running: true };
        },
        async stop() {
            return { instanceCount: 0, running: false };
        }
    };

    const cli = new CliMain({
        createCliClients: () => testClients({}),
        createLifecycleManager: async () => lifecycle,
        stderr,
        stdout
    });

    assert.equal(await cli.run(["start"]), 0);
    assert.match(stdout.flush(), /control: running/u);

    assert.equal(await cli.run(["status"]), 0);
    assert.match(stdout.flush(), /instances: 1/u);

    assert.equal(await cli.run(["logs"]), 0);
    assert.equal(stdout.flush(), "line-1\n");

    assert.equal(await cli.run(["stop"]), 0);
    assert.equal(stdout.flush(), "control: stopped\n");

    const failureCli = new CliMain({
        createCliClients: () => testClients({
            async callTool() {
                throw new Error("unused");
            },
            async createInstance() {
                throw new Error("unused");
            },
            async getInstanceCreateSchema() {
                throw new Error("unused");
            },
            async getSnapshot() {
                throw { code: "control.instanceNotFound", message: "missing" };
            },
            async listInstances() {
                return [];
            },
            async readLogs() {
                return [];
            },
            async readToolCalls() {
                return [];
            },
            async refreshStatus() {
                throw new Error("unused");
            },
            async startInstance() {
                throw new Error("unused");
            },
            async stopInstance() {
                throw new Error("unused");
            },
            async subscribe() {
                throw new Error("unused");
            },
            async validateInstanceCreateDraft() {
                throw new Error("unused");
            }
        }),
        createLifecycleManager: async () => lifecycle,
        stderr,
        stdout
    });

    assert.equal(await failureCli.run(["instance", "status", "missing"]), 4);
    assert.equal(stderr.flush(), "missing\n");
});

test("CliMain routes the tui command through the injected runtime", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    let started = false;
    const cli = new CliMain({
        createCliClients: () => testClients({}),
        createLifecycleManager: async () => {
            throw new Error("lifecycle should not be used for tui");
        },
        runTui: async () => {
            started = true;
        },
        stderr,
        stdout
    });

    assert.equal(await cli.run(["tui"]), 0);
    assert.equal(started, true);
    assert.equal(stdout.flush(), "");
    assert.equal(stderr.flush(), "");
});

test("CliMain renders structured remote errors in verbose mode", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    const cli = new CliMain({
        createCliClients: () => testClients({
            async callTool() {
                throw new Error("unused");
            },
            async createInstance() {
                throw new Error("unused");
            },
            async getInstanceCreateSchema() {
                throw new Error("unused");
            },
            async getSnapshot() {
                throw {
                    causeBody: {
                        code: "core.providerFailed",
                        message: "ssh exited",
                        retryable: false
                    },
                    code: "core.workerStartFailed",
                    details: {
                        commandDisplay: "ssh demo -- sh -lc pwd",
                        exitCode: 255,
                        operation: "start",
                        provider: "ssh",
                        stderrTail: "Permission denied\n"
                    },
                    message: "Worker start failed for instance demo-ssh.",
                    retryable: false
                };
            },
            async listInstances() {
                return [];
            },
            async readLogs() {
                return [];
            },
            async readToolCalls() {
                return [];
            },
            async refreshStatus() {
                throw new Error("unused");
            },
            async startInstance() {
                throw new Error("unused");
            },
            async stopInstance() {
                throw new Error("unused");
            },
            async subscribe() {
                throw new Error("unused");
            },
            async validateInstanceCreateDraft() {
                throw new Error("unused");
            }
        }),
        createLifecycleManager: async () => ({
            async logs() {
                return "";
            },
            async start() {
                return { instanceCount: 0, running: true };
            },
            async status() {
                return { instanceCount: 0, running: true };
            },
            async stop() {
                return { instanceCount: 0, running: false };
            }
        }),
        stderr,
        stdout
    });

    assert.equal(await cli.run(["--verbose", "instance", "status", "demo-ssh"]), 1);
    assert.match(stderr.flush(), /command: ssh demo -- sh -lc pwd/u);
    assert.equal(stdout.flush(), "");
});

test("CliMain routes interactive instance.start relay output to stderr", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    const client = {
        async callTool() {
            throw new Error("unused");
        },
        async createInstance() {
            throw new Error("unused");
        },
        async getInstanceCreateSchema() {
            throw new Error("unused");
        },
        async getSnapshot() {
            throw new Error("unused");
        },
        async listInstances() {
            return [];
        },
        async readLogs() {
            return [];
        },
        async readToolCalls() {
            return [];
        },
        async refreshStatus() {
            throw new Error("unused");
        },
        async startInstance(_instance: string, relay?: { output: { write(chunk: string): void } }) {
            relay?.output.write("Password: ");
            return {
                connectionState: "connected",
                daemonState: "running",
                lastSeq: 1,
                name: "demo-ssh",
                ready: true,
                status: "ready"
            };
        },
        async stopInstance() {
            throw new Error("unused");
        },
        async subscribe() {
            throw new Error("unused");
        },
        async validateInstanceCreateDraft() {
            throw new Error("unused");
        }
    };

    const cli = new CliMain({
        createCliClients: () => testClients(client),
        createLifecycleManager: async () => ({
            async logs() {
                return "";
            },
            async start() {
                return { instanceCount: 0, running: true };
            },
            async status() {
                return { instanceCount: 0, running: true };
            },
            async stop() {
                return { instanceCount: 0, running: false };
            }
        }),
        stdin: Readable.from(["secret\n"]),
        stderr,
        stdout
    });

    assert.equal(await cli.run(["instance", "start", "demo-ssh"]), 0);
    assert.equal(stderr.flush(), "Password: ");
    assert.match(stdout.flush(), /instance: demo-ssh/u);
});

test("CliMain handles instance logs follow and tool call through injected client", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    const stream = {
        async nextEvent() {
            return { event: "toolCall.completed", seq: 2, target: { instance: "demo-local", kind: "instance" }, type: "event" };
        },
        close() {}
    };
    let readCount = 0;
    const client = {
        async callTool() {
            return { exitCode: 0, stderr: "", stdout: "/tmp/ws\n" };
        },
        async createInstance() {
            throw new Error("unused");
        },
        async getInstanceCreateSchema() {
            throw new Error("unused");
        },
        async getSnapshot() {
            return {
                lastSeq: 1,
                snapshot: {
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: 1,
                    name: "demo-local",
                    ready: true,
                    status: "ready"
                }
            };
        },
        async listInstances() {
            return [];
        },
        async readLogs() {
            readCount += 1;
            return readCount === 1
                ? [{ at: "", instanceName: "demo-local", message: "before\n", seq: 1, stream: "stdout" as const }]
                : [{ at: "", instanceName: "demo-local", message: "after\n", seq: 2, stream: "stdout" as const }];
        },
        async readToolCalls() {
            return [];
        },
        async refreshStatus() {
            throw new Error("unused");
        },
        async startInstance() {
            throw new Error("unused");
        },
        async stopInstance() {
            throw new Error("unused");
        },
        async subscribe() {
            return stream;
        },
        async validateInstanceCreateDraft() {
            throw new Error("unused");
        }
    };

    const cli = new CliMain({
        createCliClients: () => testClients(client),
        createLifecycleManager: async () => ({
            async logs() {
                return "";
            },
            async start() {
                return { instanceCount: 0, running: true };
            },
            async status() {
                return { instanceCount: 0, running: true };
            },
            async stop() {
                return { instanceCount: 0, running: false };
            }
        }),
        followEventLimit: 1,
        stderr,
        stdout
    });

    assert.equal(await cli.run(["instance", "logs", "demo-local", "-f"]), 0);
    assert.equal(stdout.flush(), "[1] stdout before\n[2] stdout after\n");

    assert.equal(await cli.run(["instance", "call", "demo-local", "bash_run", "{\"command\":\"pwd\"}"]), 0);
    const callOutput = stdout.flush();
    assert.match(callOutput, /tool: bash_run/u);
    assert.match(callOutput, /stdout:\n\/tmp\/ws/u);
    assert.equal(stderr.flush(), "");
});

test("CliMain follows instance logs without skipping events between initial pull and subscribe", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    const stream = {
        delivered: false,
        close() {},
        async nextEvent() {
            if (this.delivered) {
                throw new Error("unexpected extra event");
            }

            this.delivered = true;
            return { event: "toolCall.completed", seq: 2, target: { instance: "demo-local", kind: "instance" }, type: "event" };
        }
    };
    let initialLogsRead = false;
    const client = {
        async callTool() {
            throw new Error("unused");
        },
        async createInstance() {
            throw new Error("unused");
        },
        async getInstanceCreateSchema() {
            throw new Error("unused");
        },
        async getSnapshot() {
            return {
                lastSeq: initialLogsRead ? 2 : 1,
                snapshot: {
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: initialLogsRead ? 2 : 1,
                    name: "demo-local",
                    ready: true,
                    status: "ready"
                }
            };
        },
        async listInstances() {
            return [];
        },
        async readLogs(_: string, query?: { fromSeq?: number; limit?: number }) {
            if (query?.fromSeq === 2) {
                return [{ at: "", instanceName: "demo-local", message: "after\n", seq: 2, stream: "stdout" as const }];
            }

            initialLogsRead = true;
            return [{ at: "", instanceName: "demo-local", message: "before\n", seq: 1, stream: "stdout" as const }];
        },
        async readToolCalls() {
            return [];
        },
        async refreshStatus() {
            throw new Error("unused");
        },
        async startInstance() {
            throw new Error("unused");
        },
        async stopInstance() {
            throw new Error("unused");
        },
        async subscribe(_: string, fromSeq: number) {
            assert.equal(fromSeq, 2);
            return stream;
        },
        async validateInstanceCreateDraft() {
            throw new Error("unused");
        }
    };

    const cli = new CliMain({
        createCliClients: () => testClients(client),
        createLifecycleManager: async () => ({
            async logs() {
                return "";
            },
            async start() {
                return { instanceCount: 0, running: true };
            },
            async status() {
                return { instanceCount: 0, running: true };
            },
            async stop() {
                return { instanceCount: 0, running: false };
            }
        }),
        followEventLimit: 1,
        stderr,
        stdout
    });

    assert.equal(await cli.run(["instance", "logs", "demo-local", "-f"]), 0);
    assert.equal(stdout.flush(), "[1] stdout before\n[2] stdout after\n");
    assert.equal(stderr.flush(), "");
});

test("CliMain recovers instance log follow when subscribe returns stream.gap", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    const stream = {
        close() {},
        async nextEvent() {
            return { event: "toolCall.completed", seq: 4, target: { instance: "demo-local", kind: "instance" }, type: "event" };
        }
    };
    let snapshotCount = 0;
    let subscribeCount = 0;
    const client = {
        async callTool() {
            throw new Error("unused");
        },
        async createInstance() {
            throw new Error("unused");
        },
        async getInstanceCreateSchema() {
            throw new Error("unused");
        },
        async getSnapshot() {
            snapshotCount += 1;

            return {
                lastSeq: snapshotCount === 1 ? 1 : 3,
                snapshot: {
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: snapshotCount === 1 ? 1 : 3,
                    name: "demo-local",
                    ready: true,
                    status: "ready"
                }
            };
        },
        async listInstances() {
            return [];
        },
        async readLogs(_: string, query?: { fromSeq?: number; limit?: number }) {
            if (query?.fromSeq === 2) {
                return [
                    { at: "", instanceName: "demo-local", message: "gap-a\n", seq: 2, stream: "stdout" as const },
                    { at: "", instanceName: "demo-local", message: "gap-b\n", seq: 3, stream: "stdout" as const }
                ];
            }

            if (query?.fromSeq === 4) {
                return [{ at: "", instanceName: "demo-local", message: "after\n", seq: 4, stream: "stdout" as const }];
            }

            return [{ at: "", instanceName: "demo-local", message: "before\n", seq: 1, stream: "stdout" as const }];
        },
        async readToolCalls() {
            return [];
        },
        async refreshStatus() {
            throw new Error("unused");
        },
        async startInstance() {
            throw new Error("unused");
        },
        async stopInstance() {
            throw new Error("unused");
        },
        async subscribe(_: string, fromSeq: number) {
            subscribeCount += 1;

            if (subscribeCount === 1) {
                assert.equal(fromSeq, 2);
                throw { code: "stream.gap", message: "gap" };
            }

            assert.equal(fromSeq, 4);
            return stream;
        },
        async validateInstanceCreateDraft() {
            throw new Error("unused");
        }
    };

    const cli = new CliMain({
        createCliClients: () => testClients(client),
        createLifecycleManager: async () => ({
            async logs() {
                return "";
            },
            async start() {
                return { instanceCount: 0, running: true };
            },
            async status() {
                return { instanceCount: 0, running: true };
            },
            async stop() {
                return { instanceCount: 0, running: false };
            }
        }),
        followEventLimit: 1,
        stderr,
        stdout
    });

    assert.equal(await cli.run(["instance", "logs", "demo-local", "-f"]), 0);
    assert.equal(stdout.flush(), "[1] stdout before\n[2] stdout gap-a\n[3] stdout gap-b\n[4] stdout after\n");
    assert.equal(stderr.flush(), "");
});

test("CliMain recovers watch status when subscribe returns stream.gap", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    const stream = {
        close() {},
        async nextEvent() {
            return { event: "toolCall.completed", seq: 4, target: { instance: "demo-local", kind: "instance" }, type: "event" };
        }
    };
    let snapshotCount = 0;
    let subscribeCount = 0;
    const client = {
        async callTool() {
            throw new Error("unused");
        },
        async createInstance() {
            throw new Error("unused");
        },
        async getInstanceCreateSchema() {
            throw new Error("unused");
        },
        async getSnapshot() {
            snapshotCount += 1;

            return {
                lastSeq: snapshotCount === 1 ? 1 : 3,
                snapshot: {
                    connectionState: snapshotCount === 1 ? "disconnected" : "connected",
                    daemonState: snapshotCount === 1 ? "stopped" : "running",
                    lastSeq: snapshotCount === 1 ? 1 : 3,
                    name: "demo-local",
                    ready: snapshotCount !== 1,
                    status: snapshotCount === 1 ? "stopped" : "ready"
                }
            };
        },
        async listInstances() {
            return [];
        },
        async readLogs() {
            return [];
        },
        async readToolCalls() {
            return [];
        },
        async refreshStatus() {
            return {
                lastSeq: 4,
                snapshot: {
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: 4,
                    name: "demo-local",
                    ready: true,
                    status: "ready"
                }
            };
        },
        async startInstance() {
            throw new Error("unused");
        },
        async stopInstance() {
            throw new Error("unused");
        },
        async subscribe(_: string, fromSeq: number) {
            subscribeCount += 1;

            if (subscribeCount === 1) {
                assert.equal(fromSeq, 2);
                throw { code: "stream.gap", message: "gap" };
            }

            assert.equal(fromSeq, 4);
            return stream;
        },
        async validateInstanceCreateDraft() {
            throw new Error("unused");
        }
    };

    const cli = new CliMain({
        createCliClients: () => testClients(client),
        createLifecycleManager: async () => ({
            async logs() {
                return "";
            },
            async start() {
                return { instanceCount: 0, running: true };
            },
            async status() {
                return { instanceCount: 0, running: true };
            },
            async stop() {
                return { instanceCount: 0, running: false };
            }
        }),
        followEventLimit: 1,
        stderr,
        stdout
    });

    assert.equal(await cli.run(["watch", "status", "demo-local"]), 0);
    assert.equal(
        stdout.flush(),
        "instance: demo-local\nstatus: stopped\nready: false\ndaemonState: stopped\nconnectionState: disconnected\nlastSeq: 1\nTodo: none\n" +
            "instance: demo-local\nstatus: ready\nready: true\ndaemonState: running\nconnectionState: connected\nlastSeq: 3\nTodo: none\n" +
            "instance: demo-local\nstatus: ready\nready: true\ndaemonState: running\nconnectionState: connected\nlastSeq: 4\nTodo: none\n"
    );
    assert.equal(stderr.flush(), "");
});

test("CliMain runs interactive instance create through control rpc", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    const calls: string[] = [];
    const client = {
        async callTool() {
            throw new Error("unused");
        },
        async createInstance(draft: Record<string, unknown>) {
            calls.push("create");
            assert.equal(draft.name, "demo-local");
            assert.equal(draft.provider, "local");
            assert.equal("workerBinaryPath" in draft, false);
            return {
                enabled: true,
                mcpPath: "/demo-local/mcp",
                name: "demo-local",
                snapshot: {
                    connectionState: "disconnected",
                    daemonState: "stopped",
                    lastSeq: 0,
                    name: "demo-local",
                    ready: false,
                    status: "stopped"
                }
            };
        },
        async getInstanceCreateSchema() {
            calls.push("schema");
            return {
                defaultMcpCapabilities: ["read", "write", "execute"],
                defaultMcpGroups: ["file", "bash", "artifact"],
                defaultEnabled: true,
                defaultMcpEnabled: true,
                defaultProvider: "local",
                defaultSecurityMode: "disabled",
                providers: ["local", "ssh", "docker", "podman"] as const
            };
        },
        async getSnapshot() {
            throw new Error("unused");
        },
        async listInstances() {
            return [];
        },
        async readLogs() {
            return [];
        },
        async readToolCalls() {
            return [];
        },
        async refreshStatus() {
            throw new Error("unused");
        },
        async startInstance() {
            throw new Error("unused");
        },
        async stopInstance() {
            throw new Error("unused");
        },
        async subscribe() {
            throw new Error("unused");
        },
            async validateInstanceCreateDraft(draft: Record<string, unknown>) {
                calls.push("validate");
                assert.equal(draft.name, "demo-local");
                return {
                    enabled: true,
                    mcp: {
                        enabled: true,
                        path: "/demo-local/mcp",
                        tools: {
                            capabilities: ["read", "write", "execute"],
                            groups: ["file", "bash", "artifact"]
                        }
                    },
                    name: "demo-local",
                    provider: "local",
                    security: {
                        mode: "disabled"
                    },
                    workspace: "/tmp/workspace"
                };
            }
    };

    const cli = new CliMain({
        createCliClients: () => testClients(client),
        createLifecycleManager: async () => ({
            async logs() {
                return "";
            },
            async start() {
                return { instanceCount: 0, running: true };
            },
            async status() {
                return { instanceCount: 0, running: true };
            },
            async stop() {
                return { instanceCount: 0, running: false };
            }
        }),
        stdin: Readable.from([
            "demo-local\n",
            "\n",
            "\n",
            "/tmp/workspace\n",
            "\n",
            "\n",
            "\n",
            "\n",
            "\n"
        ]),
        stderr,
        stdout
    });

    assert.equal(await cli.run(["instance", "create"]), 0);
    assert.deepEqual(calls, ["schema", "validate", "create"]);
    const output = stdout.flush();
    assert.match(output, /Summary\n/u);
    assert.match(output, /instance created: demo-local/u);
    assert.doesNotMatch(output, /worker binary path:/u);
    assert.doesNotMatch(output, /event buffer size:/u);
    assert.doesNotMatch(output, /retention days:/u);
    assert.doesNotMatch(output, /env entries:/u);
    assert.equal(stderr.flush(), "");
});

function createBuffer(): { flush: () => string; write: (chunk: string) => void } {
    const chunks: string[] = [];

    return {
        flush() {
            const value = chunks.join("");
            chunks.length = 0;
            return value;
        },
        write(chunk: string) {
            chunks.push(chunk);
        }
    };
}

test("CliMain reads and follows Todo through control RPC", async () => {
    const stdout = createBuffer();
    const stderr = createBuffer();
    let reads = 0;
    let closed = false;
    const cli = new CliMain({
        createCliClients: () => testClients({
            async getTodo() {
                reads += 1;
                return reads === 1
                    ? {
                          lastSeq: 0,
                          todo: {
                              items: [{ content: "Inspect", id: "inspect", status: "in_progress" }],
                              revision: 1,
                              summary: { completed: 0, currentItemId: "inspect", total: 1 },
                              taskId: "task-1",
                              title: "Todo follow"
                          }
                      }
                    : {
                          lastSeq: 1,
                          todo: {
                              items: [{ content: "Inspect", id: "inspect", status: "completed" }],
                              revision: 2,
                              summary: { completed: 1, total: 1 },
                              taskId: "task-1",
                              title: "Todo follow"
                          }
                      };
            },
            async subscribeTodo() {
                return {
                    close() {
                        closed = true;
                    },
                    async nextEvent() {
                        return {
                            event: "todo.completed",
                            payload: {},
                            seq: 1,
                            target: { instance: "demo-local", kind: "instance" },
                            type: "event"
                        };
                    }
                };
            }
        } as never),
        followEventLimit: 1,
        stderr,
        stdout
    });

    assert.equal(await cli.run(["instance", "todo", "demo-local", "--follow"]), 0);
    assert.match(stdout.flush(), /Progress: 0\/1[\s\S]*Progress: 1\/1/u);
    assert.equal(reads, 2);
    assert.equal(closed, true);
    assert.equal(stderr.flush(), "");
});

function testClients(client: Record<string, unknown>) {
    const invoke = (name: string, args: unknown[]) => {
        const method = client[name];
        if (typeof method !== "function") {
            throw new Error(`Test client method ${name} is not available.`);
        }
        return Reflect.apply(method, client, args) as unknown;
    };
    return {
        artifact: {
            cancelTransfer: (...args: unknown[]) => invoke("cancelTransfer", args),
            createShare: (...args: unknown[]) => invoke("createShare", args),
            getTransfer: (...args: unknown[]) => invoke("getTransfer", args),
            listShares: (...args: unknown[]) => invoke("listShares", args),
            listTransfers: (...args: unknown[]) => invoke("listTransfers", args),
            revokeShare: (...args: unknown[]) => invoke("revokeShare", args),
            startTransfer: (...args: unknown[]) => invoke("startTransfer", args)
        },
        instance: {
            create: (...args: unknown[]) => invoke("createInstance", args),
            createSchema: (...args: unknown[]) => invoke("getInstanceCreateSchema", args),
            list: (...args: unknown[]) => invoke("listInstances", args),
            validateCreate: (...args: unknown[]) => invoke("validateInstanceCreateDraft", args)
        },
        reverse: {
            createCode: (...args: unknown[]) => invoke("createReverseDeviceCode", args),
            revokeToken: (...args: unknown[]) => invoke("revokeReverseDeviceToken", args),
            rotateToken: (...args: unknown[]) => invoke("rotateReverseDeviceToken", args)
        },
        runtime: {
            refresh: (...args: unknown[]) => invoke("refreshStatus", args),
            snapshot: (...args: unknown[]) => invoke("getSnapshot", args),
            start: (...args: unknown[]) => invoke("startInstance", args),
            stop: (...args: unknown[]) => invoke("stopInstance", args),
            readLogs: (...args: unknown[]) => invoke("readLogs", args),
            subscribe: (...args: unknown[]) => invoke("subscribe", args)
        },
        todo: {
            get: (...args: unknown[]) => invoke("getTodo", args),
            subscribe: (...args: unknown[]) => invoke(
                typeof client.subscribeTodo === "function" ? "subscribeTodo" : "subscribe",
                args
            )
        },
        tool: {
            call: (...args: unknown[]) => invoke("callTool", args)
        }
    } as never;
}
