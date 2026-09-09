import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const logPath = join(process.cwd(), "fake-pi-child.log");
const agents = new Set();
const pendingTools = new Map();
let nextToolCall = 0;

process.on("message", (message) => {
    if (message.type === "owner.heartbeat") return;
    if (message.type === "tool.result") {
        const pending = pendingTools.get(message.callId);
        if (pending === undefined) return;
        pendingTools.delete(message.callId);
        if (message.ok) pending.resolve(message.result ?? null);
        else pending.reject(new Error(message.error ?? "tool request failed"));
        return;
    }
    void handle(message).catch((error) => {
        if (message.type === "init") {
            process.send?.({ error: error.message, ok: false, type: "ready" });
        } else {
            process.send?.({ error: error.message, id: message.id, ok: false, type: "result" });
        }
    });
});

async function handle(message) {
    await appendFile(
        logPath,
        `${process.pid}\t${process.env.PI_CODING_AGENT_DIR ?? ""}\t${message.type}\t${message.agentId ?? ""}\t${message.command ?? ""}\t${JSON.stringify(process.execArgv)}\n`,
        "utf8"
    );
    if (message.type === "init") {
        process.send?.({ ok: true, type: "ready", webUpstream: "http://127.0.0.1:43199/" });
        return;
    }
    if (message.type === "agent.start") {
        agents.add(message.agentId);
        process.send?.({ id: message.id, ok: true, type: "result" });
        return;
    }
    if (message.type === "agent.command") {
        if (!agents.has(message.agentId)) throw new Error(`unknown ${message.agentId}`);
        if (message.command === "prompt" && message.message === "__crash__") {
            process.exit(23);
        }
        if (message.command === "prompt" && message.message === "__disconnect__") {
            setInterval(() => undefined, 1000);
            process.disconnect();
            return;
        }
        if (message.command === "prompt" && message.message === "__tool__") {
            await callTool(message.agentId, "echo_tool", { value: "from-child" }, "fake-operation");
        }
        if (message.command === "prompt" && message.message === "__tool-cancel__") {
            const request = beginToolCall(
                message.agentId,
                "slow_tool",
                { value: "cancel-me" },
                "fake-cancel-operation"
            );
            process.send?.({ agentId: message.agentId, callId: request.callId, type: "tool.cancel" });
            await request.result.catch(() => undefined);
        }
        if (message.command === "stop") {
            await closeTools(message.agentId);
            agents.delete(message.agentId);
        }
        process.send?.({ id: message.id, ok: true, type: "result" });
        return;
    }
    if (message.type === "shutdown") {
        process.send?.({ id: message.id, ok: true, type: "result" });
        setImmediate(() => process.exit(0));
    }
}

async function callTool(agentId, toolName, input, operationId) {
    return await beginToolCall(agentId, toolName, input, operationId).result;
}

function beginToolCall(agentId, toolName, input, operationId) {
    const callId = `fake-tool-${++nextToolCall}`;
    const result = new Promise((resolve, reject) => {
        pendingTools.set(callId, { reject, resolve });
    });
    process.send?.({ agentId, callId, input, operationId, toolName, type: "tool.call" });
    return { callId, result };
}

async function closeTools(agentId) {
    const callId = `fake-tool-close-${++nextToolCall}`;
    const result = new Promise((resolve, reject) => {
        pendingTools.set(callId, { reject, resolve });
    });
    process.send?.({ agentId, callId, type: "tool.close" });
    await result;
}
