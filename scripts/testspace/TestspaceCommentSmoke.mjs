import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
    createTuiClients,
    TuiControlSession,
    TuiRuntimeOperations,
} from "../../packages/tui/dist/testing.js";

export async function runTestspaceCommentSmoke({
    endpoint,
    instance,
    runtimeDirectory,
}) {
    const clients = createTuiClients({ xdgRuntimeDir: runtimeDirectory });
    const session = new TuiControlSession({
        clients,
        overviewRefreshIntervalMs: 0,
        readTimeoutMs: 10_000,
    });
    const operations = new TuiRuntimeOperations({
        clients,
        operationTimeoutMs: 10_000,
        session,
        store: session.store,
    });
    const mcp = new Client({
        name: "portable-devshell-testspace-comment-smoke",
        version: "0.0.0",
    });
    try {
        await session.start();
        await waitFor(
            () => session.store.getState().connection.status === "connected",
            "TUI ControlSession did not connect",
        );
        session.store.setSelectedInstance(instance);
        session.store.setSelectedPage("audit");

        await mcp.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        const environment = await mcp.callTool({
            arguments: {},
            name: "environ_info",
        });
        const ctxId = environment.structuredContent?.ctxId;
        if (typeof ctxId !== "string" || ctxId.length === 0) {
            throw new Error("environ_info did not return a ctxId");
        }

        const marker = `testspace-comment-${randomUUID()}`;
        await operations.queueContextMessage(instance, ctxId, marker);
        await waitFor(
            () =>
                session.store.getState().contextMessagesByInstance[instance]?.some(
                    (message) =>
                        message.ctxId === ctxId &&
                        message.text === marker &&
                        message.status === "sent",
                ) === true,
            "TUI operation did not publish the queued Comment",
        );
        const queued = session.store.getState().contextMessagesByInstance[instance]?.find(
            (message) => message.ctxId === ctxId && message.text === marker,
        );
        if (queued === undefined) {
            throw new Error("queued Comment disappeared from the TUI read model");
        }

        const result = await mcp.callTool({
            arguments: {
                command: printCommand("testspace-comment-tool-ran"),
                ctxId,
                timeoutMs: 30_000,
            },
            name: "bash_run",
        });
        const comments = result.structuredContent?.comment;
        if (!Array.isArray(comments) || !comments.includes(marker)) {
            throw new Error(
                `MCP tool result did not contain the queued Comment: ${JSON.stringify(result.structuredContent)}`,
            );
        }

        await waitFor(
            () =>
                session.store.getState().contextMessagesByInstance[instance]?.some(
                    (message) =>
                        message.id === queued.id &&
                        message.status === "delivered" &&
                        typeof message.callId === "string",
                ) === true,
            () => {
                const state = session.store.getState();
                return [
                    "TUI Comment state did not automatically become delivered",
                    `messages=${JSON.stringify(state.contextMessagesByInstance[instance] ?? [])}`,
                    `events=${JSON.stringify(state.rawEvents.slice(-20).map((event) => ({ event: event.event, payload: event.payload, seq: event.seq })))}`,
                    `panelErrors=${JSON.stringify(state.panelErrors)}`,
                ].join("\n");
            },
        );
        const delivered = session.store.getState().contextMessagesByInstance[instance]?.find(
            (message) => message.id === queued.id,
        );
        return {
            callId: delivered?.callId,
            ctxId,
            instance,
            messageId: queued.id,
            status: delivered?.status,
        };
    } finally {
        await mcp.close().catch(() => undefined);
        await session.stop().catch(() => undefined);
    }
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(typeof message === "function" ? message() : message);
}

function printCommand(marker) {
    const escaped = marker.replaceAll("'", "");
    return process.platform === "win32"
        ? `powershell.exe -NoLogo -NoProfile -NonInteractive -Command "[Console]::WriteLine('${escaped}')"`
        : `printf '%s\\n' '${escaped}'`;
}
