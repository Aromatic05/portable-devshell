import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { JsonValue, ToolDefinition } from "@portable-devshell/shared";

import type { AgentProviderHandle } from "../AgentProvider.js";
import type {
    PiChildCommandMessage,
    PiChildMessage,
    PiChildToolCallMessage,
    PiParentMessage
} from "./PiProcessProtocol.js";

export interface PiAgentProcessStartOptions {
    callTool(
        toolName: string,
        input: JsonValue,
        options: { operationId: string; signal?: AbortSignal }
    ): Promise<JsonValue>;
    entrypoint: string;
    localCwd: string;
    remoteWorkspace: string;
    tools: readonly ToolDefinition[];
}

export interface PiAgentRuntimeFactory {
    start(options: PiAgentProcessStartOptions): Promise<AgentProviderHandle>;
}

export class PiAgentProcessFactory implements PiAgentRuntimeFactory {
    readonly #childModulePath: string;

    constructor(options: { childModulePath?: string } = {}) {
        this.#childModulePath = options.childModulePath ?? resolveChildModulePath();
    }

    async start(options: PiAgentProcessStartOptions): Promise<AgentProviderHandle> {
        const child = fork(this.#childModulePath, [], {
            execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
            serialization: "json",
            stdio: ["ignore", "ignore", "pipe", "ipc"]
        });
        const runtime = new PiAgentProcessHandle(child, options);
        try {
            await runtime.initialize();
            return runtime;
        } catch (error) {
            runtime.terminate();
            throw error;
        }
    }
}

class PiAgentProcessHandle implements AgentProviderHandle {
    readonly #child: ChildProcess;
    readonly #options: PiAgentProcessStartOptions;
    readonly #commands = new Map<string, {
        reject(error: Error): void;
        resolve(): void;
    }>();
    readonly #toolCalls = new Map<string, AbortController>();
    #stderr = "";
    #readyReject?: (error: Error) => void;
    #readyResolve?: () => void;
    #stopped = false;
    #web?: { upstream: URL };

    constructor(child: ChildProcess, options: PiAgentProcessStartOptions) {
        this.#child = child;
        this.#options = options;
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            this.#stderr = `${this.#stderr}${chunk}`.slice(-16_384);
        });
        child.on("message", (message) => this.#onMessage(message));
        child.once("error", (error) => this.#fail(error));
        child.once("exit", (code, signal) => {
            if (!this.#stopped) {
                const detail = this.#stderr.trim();
                this.#fail(new Error(
                    `Pi Agent child exited unexpectedly (${code ?? signal ?? "unknown"}).${detail.length === 0 ? "" : `\n${detail}`}`
                ));
            }
        });
    }

    async initialize(): Promise<void> {
        const ready = new Promise<void>((resolve, reject) => {
            this.#readyResolve = resolve;
            this.#readyReject = reject;
        });
        await this.#send({
            entrypoint: this.#options.entrypoint,
            localCwd: this.#options.localCwd,
            remoteWorkspace: this.#options.remoteWorkspace,
            tools: this.#options.tools,
            type: "init"
        });
        await ready;
    }

    get web(): { upstream: URL } | undefined {
        return this.#web;
    }

    async prompt(message: string): Promise<void> {
        await this.#command("prompt", message);
    }

    async steer(message: string): Promise<void> {
        await this.#command("steer", message);
    }

    async followUp(message: string): Promise<void> {
        await this.#command("followUp", message);
    }

    async abort(): Promise<void> {
        await this.#command("abort");
    }

    async stop(): Promise<void> {
        if (this.#stopped) return;
        try {
            await this.#command("stop");
        } finally {
            this.terminate();
        }
    }

    terminate(): void {
        this.#stopped = true;
        for (const controller of this.#toolCalls.values()) controller.abort();
        this.#toolCalls.clear();
        if (this.#child.connected) this.#child.disconnect();
        if (this.#child.exitCode === null && this.#child.signalCode === null) {
            this.#child.kill("SIGTERM");
        }
    }

    async #command(command: PiChildCommandMessage["command"], message?: string): Promise<void> {
        if (this.#stopped) throw new Error("Pi Agent child is already stopped.");
        const id = randomUUID();
        const response = new Promise<void>((resolve, reject) => {
            this.#commands.set(id, { resolve, reject });
        });
        try {
            await this.#send({
                command,
                id,
                ...(message === undefined ? {} : { message }),
                type: "command"
            });
            await response;
        } catch (error) {
            this.#commands.delete(id);
            throw error;
        }
    }

    #onMessage(value: unknown): void {
        const message = value as PiChildMessage;
        if (message?.type === "ready") {
            if (!message.ok) {
                this.#readyReject?.(new Error(message.error ?? "Pi Agent child initialization failed."));
                this.#readyResolve = undefined;
                this.#readyReject = undefined;
                return;
            }
            if (message.webUpstream !== undefined) {
                this.#web = { upstream: new URL(message.webUpstream) };
            }
            this.#readyResolve?.();
            this.#readyResolve = undefined;
            this.#readyReject = undefined;
            return;
        }
        if (message?.type === "command.result") {
            const pending = this.#commands.get(message.id);
            if (pending === undefined) return;
            this.#commands.delete(message.id);
            if (message.ok) pending.resolve();
            else pending.reject(new Error(message.error ?? "Pi Agent command failed."));
            return;
        }
        if (message?.type === "tool.call") {
            void this.#runToolCall(message);
            return;
        }
        if (message?.type === "tool.cancel") {
            this.#toolCalls.get(message.requestId)?.abort();
        }
    }

    async #runToolCall(message: PiChildToolCallMessage): Promise<void> {
        const controller = new AbortController();
        this.#toolCalls.set(message.requestId, controller);
        try {
            const result = await this.#options.callTool(message.toolName, message.input, {
                operationId: message.toolCallId,
                signal: controller.signal
            });
            await this.#send({ ok: true, requestId: message.requestId, result, type: "tool.result" });
        } catch (error) {
            await this.#send({
                error: error instanceof Error ? error.message : String(error),
                ok: false,
                requestId: message.requestId,
                type: "tool.result"
            }).catch(() => undefined);
        } finally {
            this.#toolCalls.delete(message.requestId);
        }
    }

    async #send(message: PiParentMessage): Promise<void> {
        if (!this.#child.connected || this.#child.send === undefined) {
            throw new Error("Pi Agent child IPC is unavailable.");
        }
        await new Promise<void>((resolve, reject) => {
            this.#child.send!(message, (error) => error === null ? resolve() : reject(error));
        });
    }

    #fail(error: Error): void {
        this.#readyReject?.(error);
        this.#readyReject = undefined;
        this.#readyResolve = undefined;
        for (const pending of this.#commands.values()) pending.reject(error);
        this.#commands.clear();
        for (const controller of this.#toolCalls.values()) controller.abort();
        this.#toolCalls.clear();
    }
}

function resolveChildModulePath(): string {
    const source = fileURLToPath(import.meta.url);
    return fileURLToPath(new URL(source.endsWith(".ts") ? "./PiAgentChild.ts" : "./PiAgentChild.js", import.meta.url));
}
