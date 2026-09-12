import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";

import type { AgentModelToolDefinition } from "../../builtin/provider/AgentToolSession.js";
import type {
    OpenCodeChildMessage,
    OpenCodeParentMessage
} from "./OpenCodeProcessProtocol.js";

const ownerHeartbeatTimeoutMs = Number.parseInt(process.argv[2] ?? "10000", 10);
let lastOwnerHeartbeat = Date.now();
let runtime: OpenCodeRuntime | undefined;
let stopping = false;

process.on("message", (value: unknown) => {
    void onMessage(value as OpenCodeParentMessage).catch((error) => {
        process.stderr.write(`${toError(error).stack ?? toError(error).message}\n`);
    });
});
process.on("disconnect", () => { void shutdownAndExit(0); });
process.on("SIGTERM", () => { void shutdownAndExit(0); });
process.on("SIGINT", () => { void shutdownAndExit(0); });

const ownerWatchdog = setInterval(() => {
    if (Date.now() - lastOwnerHeartbeat > ownerHeartbeatTimeoutMs) void shutdownAndExit(0);
}, Math.max(50, Math.min(1_000, Math.floor(ownerHeartbeatTimeoutMs / 2))));
ownerWatchdog.unref();

async function onMessage(message: OpenCodeParentMessage): Promise<void> {
    if (message.type === "owner.heartbeat") {
        lastOwnerHeartbeat = Date.now();
        return;
    }
    if (message.type === "tool.result") {
        runtime?.acceptToolResult(message);
        return;
    }
    if (message.type === "init") {
        if (runtime !== undefined) {
            send({ id: message.id, ok: false, error: "OpenCode provider child is already initialized.", type: "ready" });
            return;
        }
        try {
            runtime = await OpenCodeRuntime.start(message);
            send({ id: message.id, ok: true, type: "ready" });
        } catch (error) {
            send({ id: message.id, ok: false, error: toError(error).message, type: "ready" });
        }
        return;
    }
    if (message.type === "command") {
        try {
            const active = requireRuntime();
            switch (message.command) {
                case "prompt":
                    active.prompt(message.message ?? "");
                    break;
                case "abort":
                    await active.abort();
                    break;
                case "wait":
                    await active.waitForIdle();
                    break;
                case "stop":
                    await active.stop();
                    break;
            }
            send({ id: message.id, ok: true, type: "result" });
        } catch (error) {
            send({ id: message.id, ok: false, error: toError(error).message, type: "result" });
        }
    }
}

class OpenCodeRuntime {
    readonly #connection: acp.ClientSideConnection;
    readonly #mcp: McpToolBridge;
    readonly #process: ChildProcessWithoutNullStreams;
    readonly #sessionId: string;
    readonly #toolCalls = new Map<string, { reject(error: Error): void; resolve(result: string): void }>();
    #activeTurn?: Promise<void>;
    #stopped = false;

    private constructor(
        connection: acp.ClientSideConnection,
        mcp: McpToolBridge,
        process: ChildProcessWithoutNullStreams,
        sessionId: string
    ) {
        this.#connection = connection;
        this.#mcp = mcp;
        this.#process = process;
        this.#sessionId = sessionId;
    }

    static async start(input: Extract<OpenCodeParentMessage, { type: "init" }>): Promise<OpenCodeRuntime> {
        const privateRoot = join(input.stateDirectory, "opencode");
        const home = join(privateRoot, "home");
        const config = join(privateRoot, "config");
        const data = join(privateRoot, "data");
        const cache = join(privateRoot, "cache");
        await Promise.all([
            mkdir(input.localCwd, { recursive: true }),
            mkdir(home, { recursive: true }),
            mkdir(config, { recursive: true }),
            mkdir(data, { recursive: true }),
            mkdir(cache, { recursive: true })
        ]);

        const mcp = await McpToolBridge.start(input.modelTools);
        const child = spawn(input.command, ["acp", "--cwd", input.localCwd], {
            cwd: input.localCwd,
            env: {
                ...process.env,
                HOME: home,
                XDG_CACHE_HOME: cache,
                XDG_CONFIG_HOME: config,
                XDG_DATA_HOME: data,
                OPENCODE_CONFIG_DIR: config,
                OPENCODE_CONFIG_CONTENT: JSON.stringify({
                    permission: {
                        "*": "deny",
                        "devshell_*": "allow"
                    }
                }),
                OPENCODE_DISABLE_AUTOUPDATE: "1",
                OPENCODE_DISABLE_PRUNE: "1"
            },
            stdio: ["pipe", "pipe", "pipe"]
        });
        child.stderr.on("data", (chunk) => process.stderr.write(chunk));
        await waitForSpawn(child);

        const stream = acp.ndJsonStream(
            Writable.toWeb(child.stdin),
            Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
        );
        const connection = new acp.ClientSideConnection(() => ({
            async requestPermission() {
                return { outcome: { outcome: "cancelled" as const } };
            },
            async sessionUpdate() {}
        }), stream);
        try {
            await connection.initialize({
                clientCapabilities: {},
                clientInfo: { name: "portable-devshell", version: "0.7.2" },
                protocolVersion: acp.PROTOCOL_VERSION
            });
            const session = await connection.newSession({
                cwd: input.localCwd,
                mcpServers: [{
                    headers: [],
                    name: "devshell",
                    type: "http",
                    url: mcp.url
                }]
            });
            const runtime = new OpenCodeRuntime(connection, mcp, child, session.sessionId);
            mcp.bind(runtime);
            return runtime;
        } catch (error) {
            child.kill("SIGTERM");
            await mcp.close().catch(() => undefined);
            throw error;
        }
    }

    prompt(message: string): void {
        if (this.#stopped) throw new Error("OpenCode Agent is already stopped.");
        if (this.#activeTurn !== undefined) throw new Error("OpenCode Agent already has an active turn.");
        const turn = this.#connection.prompt({
            prompt: [{ text: message, type: "text" }],
            sessionId: this.#sessionId
        }).then(() => undefined);
        const tracked = turn.finally(() => {
            if (this.#activeTurn === tracked) this.#activeTurn = undefined;
        });
        this.#activeTurn = tracked;
        void tracked.catch(() => undefined);
    }

    async abort(): Promise<void> {
        if (this.#stopped) return;
        await this.#connection.cancel({ sessionId: this.#sessionId });
    }

    async waitForIdle(): Promise<void> {
        await this.#activeTurn;
    }

    async stop(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        if (this.#activeTurn !== undefined) {
            await this.#connection.cancel({ sessionId: this.#sessionId }).catch(() => undefined);
            await this.#activeTurn.catch(() => undefined);
        }
        for (const pending of this.#toolCalls.values()) pending.reject(new Error("OpenCode Agent stopped."));
        this.#toolCalls.clear();
        await this.#mcp.close();
        this.#process.kill("SIGTERM");
        await waitForExit(this.#process, 2_000).catch(() => this.#process.kill("SIGKILL"));
    }

    async callTool(toolName: string, input: unknown): Promise<string> {
        if (this.#stopped) throw new Error("OpenCode Agent is already stopped.");
        const callId = randomUUID();
        const response = new Promise<string>((resolve, reject) => {
            this.#toolCalls.set(callId, { resolve, reject });
        });
        send({
            callId,
            input: input as never,
            operationId: randomUUID(),
            toolName,
            type: "tool.call"
        });
        return await response.finally(() => this.#toolCalls.delete(callId));
    }

    acceptToolResult(message: Extract<OpenCodeParentMessage, { type: "tool.result" }>): void {
        const pending = this.#toolCalls.get(message.callId);
        if (pending === undefined) return;
        if (message.ok) pending.resolve(message.result ?? "");
        else pending.reject(new Error(message.error ?? "DevShell tool call failed."));
    }
}

class McpToolBridge {
    readonly #http: HttpServer;
    readonly #mcp: McpServer;
    #runtime?: OpenCodeRuntime;
    readonly url: string;

    private constructor(http: HttpServer, mcp: McpServer, url: string) {
        this.#http = http;
        this.#mcp = mcp;
        this.url = url;
    }

    static async start(tools: readonly AgentModelToolDefinition[]): Promise<McpToolBridge> {
        const mcp = new McpServer({ name: "portable-devshell", version: "0.7.2" });
        const bridge: { current?: McpToolBridge } = {};
        for (const tool of tools) {
            mcp.registerTool(tool.name, {
                description: tool.description,
                inputSchema: fromJsonSchema(tool.inputSchema as Record<string, unknown>)
            }, async (input) => {
                if (bridge.current === undefined || bridge.current.#runtime === undefined) {
                    throw new Error("OpenCode DevShell tool bridge is not bound.");
                }
                const result = await bridge.current.#runtime.callTool(tool.name, input);
                return { content: [{ text: result, type: "text" }] };
            });
        }
        const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcp.connect(transport);
        const http = createServer((request, response) => {
            if (request.url !== "/mcp") {
                response.writeHead(404).end();
                return;
            }
            void transport.handleRequest(request, response).catch((error) => {
                if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
                response.end(toError(error).message);
            });
        });
        await listen(http);
        const address = http.address();
        if (address === null || typeof address === "string") {
            await mcp.close();
            throw new Error("OpenCode MCP bridge did not obtain a TCP address.");
        }
        bridge.current = new McpToolBridge(http, mcp, `http://127.0.0.1:${address.port}/mcp`);
        return bridge.current;
    }

    bind(runtime: OpenCodeRuntime): void {
        if (this.#runtime !== undefined) throw new Error("OpenCode MCP bridge is already bound.");
        this.#runtime = runtime;
    }

    async close(): Promise<void> {
        await this.#mcp.close();
        await closeServer(this.#http);
    }
}

function requireRuntime(): OpenCodeRuntime {
    if (runtime === undefined) throw new Error("OpenCode provider child is not initialized.");
    return runtime;
}

function send(message: OpenCodeChildMessage): void {
    if (!process.connected || process.send === undefined) return;
    process.send(message);
}

async function shutdownAndExit(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearInterval(ownerWatchdog);
    await runtime?.stop().catch(() => undefined);
    if (process.connected) process.disconnect();
    process.exitCode = code;
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.pid !== undefined) return;
    await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
    });
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("OpenCode ACP process did not exit after termination."));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timeout);
            child.off("exit", onExit);
            child.off("error", onError);
        };
        const onExit = () => { cleanup(); resolve(); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        child.once("exit", onExit);
        child.once("error", onError);
    });
}

async function listen(server: HttpServer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(0, "127.0.0.1");
    });
}

async function closeServer(server: HttpServer): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
    });
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
