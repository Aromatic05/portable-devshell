import { randomUUID } from "node:crypto";
import {
    Client,
    StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
    createTuiDomainSession,
    TuiControlSession,
    TuiRuntimeOperations,
} from "../../packages/tui/dist/testing.js";

export async function runTestspaceCommentSmoke({
    endpoint,
    instance,
    runtimeDirectory,
    workspace,
}) {
    const domains = createTuiDomainSession({ xdgRuntimeDir: runtimeDirectory });
    const session = new TuiControlSession({ domains });
    const clients = {
        artifact: domains.artifactTransport,
        config: domains.configTransport,
        instance: domains.instanceTransport,
        reverse: domains.reverse,
        server: domains.serverTransport,
        task: (target) => domains.taskTransport(target),
        tool: (target) => domains.toolTransport(target),
    };
    const operations = new TuiRuntimeOperations({
        clients,
        domains,
        operationTimeoutMs: 10_000,
        reconnect: () => session.reconnect(),
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
        await domains.messages.load([instance]);

        await mcp.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        const environment = await mcp.callTool({
            arguments: { workspace },
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
                domains.messages.state.instances[instance]?.messages.some(
                        (message) =>
                            message.ctxId === ctxId &&
                            message.text === marker &&
                            message.status === "sent",
                    ) === true,
            "TUI operation did not publish the queued Comment",
        );
        const queued = domains.messages.state.instances[instance]?.messages.find(
                (message) => message.ctxId === ctxId && message.text === marker,
            );
        if (queued === undefined) {
            throw new Error(
                "queued Comment disappeared from the TUI Message ViewModel",
            );
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
                domains.messages.state.instances[instance]?.messages.some(
                        (message) =>
                            message.id === queued.id &&
                            message.status === "delivered" &&
                            typeof message.callId === "string",
                    ) === true,
            () => {
                return [
                    "TUI Message ViewModel did not observe the delivered Comment",
                    `messages=${JSON.stringify(domains.messages.state.instances[instance]?.messages ?? [])}`,
                    `failures=${JSON.stringify(domains.messages.state.failures)}`,
                ].join("\n");
            },
        );
        const delivered = domains.messages.state.instances[instance]?.messages.find(
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
