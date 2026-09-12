import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const logPath = join(process.cwd(), "fake-opencode-child.log");
const pendingTools = new Map();
let nextToolCall = 0;

process.on("message", (message) => {
    if (message.type === "owner.heartbeat") return;
    if (message.type === "tool.result") {
        const pending = pendingTools.get(message.callId);
        if (pending === undefined) return;
        pendingTools.delete(message.callId);
        if (message.ok) pending.resolve(message.result ?? "");
        else pending.reject(new Error(message.error ?? "tool request failed"));
        return;
    }
    void handle(message).catch((error) => {
        const type = message.type === "init" ? "ready" : "result";
        process.send?.({ error: error.message, id: message.id, ok: false, type });
    });
});

async function handle(message) {
    if (message.type === "init") {
        await appendFile(logPath, `${JSON.stringify({ type: "init", command: message.command })}\n`, "utf8");
        process.send?.({ id: message.id, ok: true, type: "ready" });
        return;
    }
    if (message.type !== "command") return;
    if (message.command === "prompt" && message.message === "__file-edit__") {
        const result = await callTool("file_edit", { operations: [] }, "fake-file-edit-operation");
        await appendFile(logPath, `${JSON.stringify({ type: "tool.result", result })}\n`, "utf8");
    }
    process.send?.({ id: message.id, ok: true, type: "result" });
}

async function callTool(toolName, input, operationId) {
    const callId = `fake-opencode-tool-${++nextToolCall}`;
    const result = new Promise((resolve, reject) => pendingTools.set(callId, { reject, resolve }));
    process.send?.({ callId, input, operationId, toolName, type: "tool.call" });
    return await result;
}
