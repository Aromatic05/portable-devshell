import { appendFile, readFile, rename, rm, stat } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const SAFE_ACTIONS = ["bash_run", "file_read", "todo_read", "todo_write", "tmux_run"];
const TODO_TITLE = "testspace connector activity";
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export function createSafeAction(name, { ctxId, iteration, revision = 0 }) {
    switch (name) {
        case "bash_run":
            return {
                arguments: {
                    command: `printf 'testspace connector tick ${iteration}\\n'; pwd`,
                    ctxId,
                },
                name,
            };
        case "file_read":
            return {
                arguments: {
                    ctxId,
                    path: "./README.md",
                    selector: "1-40",
                    view: "content",
                },
                name,
            };
        case "todo_read":
            return { arguments: { ctxId, title: TODO_TITLE }, name };
        case "todo_write": {
            const phase = iteration % 4;
            return {
                arguments: {
                    ctxId,
                    revision,
                    title: TODO_TITLE,
                    todos: [
                        {
                            content: "Generate harmless connector calls",
                            id: "generate-calls",
                            status: phase === 0 ? "completed" : "in_progress",
                        },
                        {
                            content: "Inspect activity in TUI Audit",
                            id: "observe-audit",
                            status: phase === 0 ? "in_progress" : "pending",
                        },
                        {
                            content: "Inspect the Web overview",
                            id: "observe-web",
                            status: "pending",
                        },
                    ],
                },
                name,
            };
        }
        case "tmux_run":
            return {
                arguments: {
                    command: `printf '\\033[32mtestspace tmux tick ${iteration}\\033[0m\\n'`,
                    ctxId,
                    timeMs: 2000,
                    wait: "block",
                },
                name,
            };
        default:
            throw new Error(`unsupported safe action: ${name}`);
    }
}

export async function runConnectorLoop(options) {
    const random = createRandom(options.seed ?? Date.now());
    let iteration = 0;
    let client;
    let ctxId;
    let toolNames = new Set();

    const stop = async () => {
        await client?.close().catch(() => undefined);
        client = undefined;
    };
    process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
    process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));

    while (options.maxIterations === undefined || iteration < options.maxIterations) {
        if (await stopRequested(options.stopFile)) break;
        try {
            if (client === undefined || ctxId === undefined) {
                ({ client, ctxId, toolNames } = await connect(options.endpoint));
                await log(options.logFile, {
                    at: new Date().toISOString(),
                    ctxId,
                    endpoint: options.endpoint,
                    event: "connector.connected",
                    model: "testspace-gpt-simulator",
                    tools: [...toolNames],
                });
                await log(options.logFile, {
                    at: new Date().toISOString(),
                    event: "conversation.started",
                    messages: [
                        {
                            content: "Use only the provided harmless tools inside the isolated testspace workspace.",
                            role: "system",
                        },
                        {
                            content: "Generate varied DevShell activity so a human can inspect TUI and Web behavior.",
                            role: "user",
                        },
                    ],
                    model: "testspace-gpt-simulator",
                });
            }

            iteration += 1;
            const available = SAFE_ACTIONS.filter((name) => toolNames.has(name));
            if (available.length === 0) throw new Error("no safe tools are exposed by the endpoint");
            const selected = available[Math.floor(random() * available.length)];
            const revision = selected === "todo_write"
                ? await readTodoRevision(client, ctxId)
                : 0;
            const call = createSafeAction(selected, { ctxId, iteration, revision });
            const toolCallId = `testspace-${process.pid}-${iteration}`;

            await log(options.logFile, {
                at: new Date().toISOString(),
                event: "assistant.tool_selection",
                finishReason: "tool_calls",
                model: "testspace-gpt-simulator",
                toolCall: {
                    arguments: call.arguments,
                    id: toolCallId,
                    name: call.name,
                },
            });

            const result = await client.callTool(call);
            await log(options.logFile, {
                at: new Date().toISOString(),
                event: "tool.result",
                isError: result.isError === true,
                structuredContent: result.structuredContent,
                toolCallId,
                toolName: call.name,
            });
        } catch (error) {
            await log(options.logFile, {
                at: new Date().toISOString(),
                error: error instanceof Error ? error.stack ?? error.message : String(error),
                event: "connector.error",
            });
            await client?.close().catch(() => undefined);
            client = undefined;
            ctxId = undefined;
            toolNames = new Set();
        }

        if (options.maxIterations === undefined || iteration < options.maxIterations) {
            await delay(options.intervalMs);
        }
    }

    await stop();
}

async function connect(endpoint) {
    const client = new Client({ name: "testspace-gpt-connector", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const listed = await client.listTools();
    const environment = await client.callTool({ arguments: {}, name: "environ_info" });
    const ctxId = environment.structuredContent?.ctxId;
    if (typeof ctxId !== "string" || ctxId.length === 0) {
        await client.close();
        throw new Error("environ_info did not return a ctxId");
    }
    return {
        client,
        ctxId,
        toolNames: new Set(listed.tools.map((tool) => tool.name)),
    };
}

async function readTodoRevision(client, ctxId) {
    const result = await client.callTool({
        arguments: { ctxId, title: TODO_TITLE },
        name: "todo_read",
    });
    const revision = result.structuredContent?.revision;
    return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

async function log(path, record) {
    await rotateLog(path);
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

async function rotateLog(path) {
    try {
        if ((await stat(path)).size < MAX_LOG_BYTES) return;
        await rm(`${path}.1`, { force: true });
        await rename(path, `${path}.1`);
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
}

async function stopRequested(path) {
    try {
        return (await readFile(path, "utf8")).trim() === "stop";
    } catch {
        return false;
    }
}

function createRandom(seed) {
    let state = Number(seed) >>> 0;
    return () => {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
