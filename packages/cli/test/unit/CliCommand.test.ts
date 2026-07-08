import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { CliMain } from "../../dist/cli/CliMain.js";

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
        createClient: () => {
            throw new Error("client should not be used for control lifecycle commands");
        },
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
        createClient: () => ({
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
        createClient: () => client,
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
        createClient: () => client,
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
        createClient: () => client,
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
        createClient: () => client,
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
        "instance: demo-local\nstatus: stopped\nready: false\ndaemonState: stopped\nconnectionState: disconnected\nlastSeq: 1\n" +
            "instance: demo-local\nstatus: ready\nready: true\ndaemonState: running\nconnectionState: connected\nlastSeq: 3\n" +
            "instance: demo-local\nstatus: ready\nready: true\ndaemonState: running\nconnectionState: connected\nlastSeq: 4\n"
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
            assert.equal(draft.workerBinaryPath, "/worker/bin");
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
                defaultAllowTools: ["bash_run"],
                defaultEnabled: true,
                defaultEventBufferSize: 1000,
                defaultMcpEnabled: true,
                defaultProvider: "local",
                defaultRetentionDays: 7,
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
                defaultWorkspace: "/tmp/workspace",
                enabled: true,
                logs: {
                    eventBufferSize: 1000,
                    retentionDays: 7
                },
                mcp: {
                    allowTools: ["bash_run"],
                    enabled: true,
                    path: "/demo-local/mcp"
                },
                name: "demo-local",
                provider: "local",
                security: {
                    mode: "disabled"
                },
                workerBinaryPath: "/worker/bin"
            };
        }
    };

    const cli = new CliMain({
        createClient: () => client,
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
            "/worker/bin\n",
            "\n",
            "\n",
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
