import {
    appendFile,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import {
    Client,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

export const SAFE_ACTIONS = [
    "bash_run",
    "file_read",
    "workspace_goal",
    "tmux_run",
];
const GOAL_OBJECTIVE = "testspace connector activity";
const GOAL_ACTIVITY_INTERVAL_MS = 35_000;
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export function createSafeAction(name, { ctxId, iteration, goal }) {
    switch (name) {
        case "bash_run":
            return {
                arguments: {
                    command: `printf 'testspace connector tick ${iteration}\\n'; pwd`,
                    ctxId,
                    timeoutMs: 30_000,
                },
                name,
            };
        case "file_read":
            return {
                arguments: {
                    ctxId,
                    files: [
                        {
                            path: "./README.md",
                            selector: "1-40",
                            view: "content",
                        },
                    ],
                },
                name,
            };
        case "workspace_goal":
            return {
                arguments: {
                    ctxId,
                    action: goal?.status === "active" ? "update" : "get",
                    ...(goal?.status === "active" ? {
                        expectedGoalId: goal.goalId,
                        expectedRevision: goal.revision,
                        note: `Connector activity iteration ${iteration}; inspect actual ToolCalls in TUI Audit and Web.`,
                    } : {}),
                },
                name,
            };
        case "tmux_run":
            return {
                arguments: {
                    command: `printf '\\033[32mtestspace tmux tick ${iteration}\\033[0m\\n'`,
                    ctxId,
                    timeout: 2000,
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
    const connectClient = options.connectClient ?? connect;
    let iteration = 0;
    let client;
    let ctxId;
    let toolNames = new Set();
    let goal;
    let nextGoalAt = 0;
    let health = {
        endpoint: options.endpoint,
        instance: options.instance,
        startedAt: new Date().toISOString(),
        status: "starting",
    };

    const updateHealth = async (update) => {
        health = {
            ...health,
            ...update,
            updatedAt: new Date().toISOString(),
        };
        if (options.healthFile !== undefined) {
            await writeConnectorHealth(options.healthFile, health);
        }
    };
    const stop = async () => {
        await client?.close().catch(() => undefined);
        client = undefined;
    };
    const onSignal = () => void stop().finally(() => process.exit(0));
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    await updateHealth({});
    try {
        while (
            options.maxIterations === undefined ||
            iteration < options.maxIterations
        ) {
            if (await stopRequested(options.stopFile)) break;
            try {
                if (client === undefined || ctxId === undefined) {
                    ({ client, ctxId, toolNames } = await connectClient(
                        options.endpoint,
                        options.workspace,
                    ));
                    const connectedAt = new Date().toISOString();
                    await updateHealth({
                        lastConnectedAt: connectedAt,
                        lastError: undefined,
                        lastErrorAt: undefined,
                        status: "connected",
                    });
                    await log(options.logFile, {
                        at: connectedAt,
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
                                content:
                                    "Use only the provided harmless tools inside the isolated testspace workspace.",
                                role: "system",
                            },
                            {
                                content:
                                    "Generate varied DevShell activity so a human can inspect TUI and Web behavior.",
                                role: "user",
                            },
                        ],
                        model: "testspace-gpt-simulator",
                    });
                    if (toolNames.has("workspace_goal")) {
                        goal = await readGoalState(client, ctxId);
                        if (goal === null || goal.status === "completed" || goal.status === "stopped") {
                            const result = await client.callTool({ name: "workspace_goal",
                                arguments: { ctxId, action: "start", objective: GOAL_OBJECTIVE } });
                            goal = goalFromResult(result);
                            if (goal === null) throw new Error("Testspace Goal start returned no Goal.");
                            await log(options.logFile, {
                                at: new Date().toISOString(),
                                event: "testspace.goal.seeded",
                                structuredContent: result.structuredContent,
                            });
                        }
                        nextGoalAt = Date.now() + GOAL_ACTIVITY_INTERVAL_MS;
                    }
                }

                iteration += 1;
                const available = SAFE_ACTIONS.filter((name) =>
                    toolNames.has(name) &&
                    (name !== "workspace_goal" || Date.now() >= nextGoalAt),
                );
                if (available.length === 0)
                    throw new Error(
                        "no safe tools are exposed by the endpoint",
                    );
                const selected =
                    available[Math.floor(random() * available.length)];
                const call = createSafeAction(selected, {
                    ctxId,
                    iteration,
                    goal,
                });
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
                if (selected === "workspace_goal") {
                    nextGoalAt = Date.now() + GOAL_ACTIVITY_INTERVAL_MS;
                    goal = result.isError === true ? undefined : goalFromResult(result);
                }
                const activityAt = new Date().toISOString();
                await log(options.logFile, {
                    at: activityAt,
                    event: "tool.result",
                    isError: result.isError === true,
                    structuredContent: result.structuredContent,
                    toolCallId,
                    toolName: call.name,
                });
                await updateHealth({
                    lastActivityAt: activityAt,
                    lastToolError: result.isError === true,
                    lastToolName: call.name,
                    status: result.isError === true ? "degraded" : "active",
                });
            } catch (error) {
                const errorAt = new Date().toISOString();
                const message =
                    error instanceof Error
                        ? (error.stack ?? error.message)
                        : String(error);
                await log(options.logFile, {
                    at: errorAt,
                    error: message,
                    event: "connector.error",
                });
                await updateHealth({
                    lastError: message,
                    lastErrorAt: errorAt,
                    status: "error",
                });
                await client?.close().catch(() => undefined);
                client = undefined;
                ctxId = undefined;
                toolNames = new Set();
                goal = undefined;
                nextGoalAt = 0;
            }

            if (
                options.maxIterations === undefined ||
                iteration < options.maxIterations
            ) {
                await delay(options.intervalMs);
            }
        }
    } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        await stop();
    }
}

export async function readTestspaceConnectorHealth(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        if (error?.code === "ENOENT") return undefined;
        return {
            lastError: error instanceof Error ? error.message : String(error),
            status: "unreadable",
        };
    }
}

async function connect(endpoint, workspace) {
    const client = new Client({
        name: "testspace-gpt-connector",
        version: "0.0.0",
    }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const listed = await client.listTools();
    const environment = await client.callTool({
        arguments: { workspace },
        name: "environ_info",
    });
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

async function readGoalState(client, ctxId) {
    return goalFromResult(await client.callTool({
        arguments: { ctxId, action: "get" },
        name: "workspace_goal",
    }));
}

function goalFromResult(result) {
    if (result.isError === true)
        throw new Error(`Testspace Goal call failed: ${JSON.stringify(result)}`);
    const goal = result.structuredContent?.goal;
    if (goal === null) return null;
    if (typeof goal?.goalId !== "string" || !Number.isSafeInteger(goal.revision) || goal.revision < 1)
        throw new Error("Testspace Goal returned no identity or revision.");
    return goal;
}

async function log(path, record) {
    await rotateLog(path);
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

async function writeConnectorHealth(path, health) {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(health, null, 2)}\n`, "utf8");
    await rename(temporary, path);
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
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
