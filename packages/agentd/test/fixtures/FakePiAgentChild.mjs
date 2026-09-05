import { appendFile } from "node:fs/promises";
import { join } from "node:path";

const logPath = join(process.cwd(), "fake-pi-child.log");
const agents = new Set();

process.on("message", (message) => {
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
        `${process.pid}\t${process.env.PI_CODING_AGENT_DIR ?? ""}\t${message.type}\t${message.agentId ?? ""}\t${message.command ?? ""}\n`,
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
        if (message.command === "stop") agents.delete(message.agentId);
        process.send?.({ id: message.id, ok: true, type: "result" });
        return;
    }
    if (message.type === "shutdown") {
        process.send?.({ id: message.id, ok: true, type: "result" });
        setImmediate(() => process.exit(0));
    }
}
