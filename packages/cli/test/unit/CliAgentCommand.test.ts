import assert from "node:assert/strict";
import test from "node:test";

import { CONTROL_PROTOCOL_VERSION } from "@portable-devshell/shared";

import { CliMain } from "../../src/CliMain.ts";

const record = {
    agentId: "ag-1",
    provider: "pi",
    providerVersion: "0.84.4",
    state: "running" as const,
    target: { instance: "worker-a", workspace: "/repo" }
};

function outputBuffer() {
    const chunks: string[] = [];
    return {
        flush() {
            const output = chunks.join("");
            chunks.length = 0;
            return output;
        },
        write(chunk: string) {
            chunks.push(chunk);
        }
    };
}

function config(enabled: boolean) {
    return {
        control: { artifactDirectTransfer: false, logLevel: "info" },
        instances: [],
        mcp: { enabled: false, listenHost: "127.0.0.1", listenPort: 0, publicBaseUrl: "http://127.0.0.1:0" },
        restartControlRequired: false,
        web: {
            auth: "none",
            enabled,
            listenHost: "127.0.0.1",
            listenPort: 8443,
            publicBaseUrl: "https://control.example/devshell"
        }
    };
}

test("Agent CLI exposes the shared provider WebUI after start and prompt acceptance", async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const calls: string[] = [];
    const cli = new CliMain({
        createCliClients: () => ({
            close() {},
            service: {
                async hello() {
                    return {
                        capabilities: ["request", "stream", "streamResume"] as const,
                        protocolVersion: CONTROL_PROTOCOL_VERSION
                    };
                }
            },
            config: {
                async get() {
                    calls.push("config.get");
                    return config(true);
                }
            },
            agent: {
                async start() {
                    calls.push("agent.start");
                    return record;
                },
                async prompt() {
                    calls.push("agent.prompt");
                }
            }
        } as never),
        stderr,
        stdout
    });

    assert.equal(await cli.run(["agent", "worker-a:/repo"]), 0);
    assert.deepEqual(JSON.parse(stdout.flush()), {
        ...record,
        webUrl: "https://control.example/devshell/web/agent/"
    });
    assert.deepEqual(calls, ["config.get", "agent.start"]);

    assert.equal(await cli.run(["agent", "send", "ag-1", "continue"]), 0);
    assert.deepEqual(JSON.parse(stdout.flush()), {
        accepted: true,
        webUrl: "https://control.example/devshell/web/agent/"
    });
    assert.deepEqual(calls, ["config.get", "agent.start", "config.get", "agent.prompt"]);
    assert.equal(stderr.flush(), "");
});

test("Agent CLI has an explicit WebUI discovery command and reports disabled WebUI", async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    let webEnabled = true;
    const cli = new CliMain({
        createCliClients: () => ({
            close() {},
            service: {
                async hello() {
                    return {
                        capabilities: ["request", "stream", "streamResume"] as const,
                        protocolVersion: CONTROL_PROTOCOL_VERSION
                    };
                }
            },
            config: {
                async get() {
                    return config(webEnabled);
                }
            },
            agent: {}
        } as never),
        stderr,
        stdout
    });

    assert.equal(await cli.run(["agent", "web"]), 0);
    assert.deepEqual(JSON.parse(stdout.flush()), {
        webUrl: "https://control.example/devshell/web/agent/"
    });

    webEnabled = false;
    assert.equal(await cli.run(["agent", "web"]), 0);
    assert.deepEqual(JSON.parse(stdout.flush()), { webUrl: null });
    assert.equal(stderr.flush(), "");
});
