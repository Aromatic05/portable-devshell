import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
    ExtensionJsonValue,
    ExtensionManagedProcess,
    ExtensionProcessCapability
} from "@portable-devshell/extension";

import type { AgentProviderHandle } from "../../builtin/provider/AgentProvider.js";
import {
    prepareAgentModelToolInput,
    projectAgentModelToolResult
} from "../../builtin/provider/AgentToolProjection.js";
import type { AgentToolSession } from "../../builtin/provider/AgentToolSession.js";
import type { AgentWorkerTarget } from "../../builtin/worker/AgentWorkerTarget.js";
import type {
    OpenCodeChildMessage,
    OpenCodeParentMessage
} from "./OpenCodeProcessProtocol.js";

const OWNER_HEARTBEAT_INTERVAL_MS = 2_000;
const OWNER_HEARTBEAT_TIMEOUT_MS = 10_000;

export interface OpenCodeAgentProcessStartOptions {
    agentId: string;
    command: string;
    localCwd: string;
    processes: ExtensionProcessCapability;
    stateDirectory: string;
    target: AgentWorkerTarget;
    tools: AgentToolSession;
}

export interface OpenCodeAgentRuntimeFactory {
    start(options: OpenCodeAgentProcessStartOptions): Promise<AgentProviderHandle>;
}

export class OpenCodeAgentProcessFactory implements OpenCodeAgentRuntimeFactory {
    readonly #childModulePath: string;

    constructor(options: { childModulePath?: string } = {}) {
        this.#childModulePath = options.childModulePath ?? resolveChildModulePath();
    }

    async start(options: OpenCodeAgentProcessStartOptions): Promise<AgentProviderHandle> {
        assertToolTarget(options.target, options.tools);
        await Promise.all([
            mkdir(options.localCwd, { recursive: true }),
            mkdir(options.stateDirectory, { recursive: true })
        ]);
        const child = await options.processes.start({
            args: [
                ...childExecArgv(this.#childModulePath),
                this.#childModulePath,
                String(OWNER_HEARTBEAT_TIMEOUT_MS)
            ],
            command: process.execPath,
            cwd: options.stateDirectory,
            messages: true
        });
        const runtime = new OpenCodeManagedProcess(child, options);
        try {
            await runtime.initialize();
            return new OpenCodeAgentHandle(runtime);
        } catch (error) {
            runtime.terminate();
            throw error;
        }
    }
}

class OpenCodeAgentHandle implements AgentProviderHandle {
    readonly #runtime: OpenCodeManagedProcess;
    readonly closed: Promise<void>;
    #stopped = false;

    constructor(runtime: OpenCodeManagedProcess) {
        this.#runtime = runtime;
        this.closed = runtime.closed;
    }

    async abort(): Promise<void> {
        if (this.#stopped) return;
        await this.#runtime.command("abort");
    }

    async prompt(message: string): Promise<void> {
        if (this.#stopped) throw new Error("OpenCode Agent is already stopped.");
        await this.#runtime.command("prompt", message);
    }

    async waitForIdle(): Promise<void> {
        if (this.#stopped) return;
        await this.#runtime.command("wait");
    }

    async stop(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        try {
            await this.#runtime.command("stop");
        } finally {
            this.#runtime.terminate();
        }
    }
}

class OpenCodeManagedProcess {
    readonly #child: ExtensionManagedProcess;
    readonly #commands = new Map<string, { reject(error: Error): void; resolve(): void }>();
    readonly #controller = new AbortController();
    readonly #ownerHeartbeat: NodeJS.Timeout;
    readonly #options: OpenCodeAgentProcessStartOptions;
    readonly #close: () => void;
    #readyReject?: (error: Error) => void;
    #readyResolve?: () => void;
    #stderr = "";
    #stopped = false;
    readonly closed: Promise<void>;

    constructor(child: ExtensionManagedProcess, options: OpenCodeAgentProcessStartOptions) {
        this.#child = child;
        this.#options = options;
        let close!: () => void;
        this.closed = new Promise<void>((resolve) => { close = resolve; });
        this.#close = close;
        child.onStderr((chunk) => {
            this.#stderr = `${this.#stderr}${chunk}`.slice(-16_384);
        });
        child.onMessage((message) => {
            void this.#onMessage(message).catch((error) => this.#fail(toError(error)));
        });
        void child.closed.then((exit) => {
            if (!this.#stopped) {
                const detail = this.#stderr.trim();
                this.#fail(new Error(
                    `OpenCode provider child exited unexpectedly (${exit.code ?? exit.signal ?? "unknown"}).`
                    + (detail.length === 0 ? "" : `\n${detail}`)
                ));
            }
            this.#close();
        }).catch((error) => this.#fail(toError(error)));
        this.#ownerHeartbeat = setInterval(() => {
            if (this.#stopped) return;
            void this.#send({ type: "owner.heartbeat" }).catch((error) => this.#fail(toError(error)));
        }, OWNER_HEARTBEAT_INTERVAL_MS);
        this.#ownerHeartbeat.unref();
    }

    async initialize(): Promise<void> {
        const ready = new Promise<void>((resolve, reject) => {
            this.#readyResolve = resolve;
            this.#readyReject = reject;
        });
        await this.#send({
            command: this.#options.command,
            id: randomUUID(),
            localCwd: this.#options.localCwd,
            modelTools: this.#options.tools.modelTools.map((tool) => ({ ...tool })),
            stateDirectory: this.#options.stateDirectory,
            type: "init"
        });
        await ready;
    }

    async command(command: "abort" | "prompt" | "stop" | "wait", message?: string): Promise<void> {
        if (this.#stopped && command !== "stop") throw new Error("OpenCode provider child is already stopped.");
        await this.#request({
            command,
            id: randomUUID(),
            ...(message === undefined ? {} : { message }),
            type: "command"
        });
    }

    terminate(): void {
        if (this.#stopped) return;
        this.#stopped = true;
        clearInterval(this.#ownerHeartbeat);
        this.#controller.abort(new Error("OpenCode provider child was terminated."));
        this.#rejectPending(new Error("OpenCode provider child was terminated."));
        this.#close();
        void this.#child.terminate("SIGTERM").catch(() => undefined);
    }

    async #request(message: Extract<OpenCodeParentMessage, { type: "command" }>): Promise<void> {
        const response = new Promise<void>((resolve, reject) => {
            this.#commands.set(message.id, { resolve, reject });
        });
        try {
            await this.#send(message);
            await response;
        } catch (error) {
            this.#commands.delete(message.id);
            throw error;
        }
    }

    async #onMessage(value: unknown): Promise<void> {
        const message = value as OpenCodeChildMessage;
        if (message?.type === "ready") {
            if (message.ok) this.#readyResolve?.();
            else this.#readyReject?.(new Error(message.error ?? "OpenCode provider child initialization failed."));
            this.#readyResolve = undefined;
            this.#readyReject = undefined;
            return;
        }
        if (message?.type === "result") {
            const pending = this.#commands.get(message.id);
            if (pending === undefined) return;
            this.#commands.delete(message.id);
            if (message.ok) pending.resolve();
            else pending.reject(new Error(message.error ?? "OpenCode provider command failed."));
            return;
        }
        if (message?.type === "tool.call") {
            await this.#handleToolCall(message);
        }
    }

    async #handleToolCall(message: Extract<OpenCodeChildMessage, { type: "tool.call" }>): Promise<void> {
        try {
            const input = prepareAgentModelToolInput(message.toolName, message.input);
            const result = await this.#options.tools.callTool(
                message.toolName,
                input,
                message.operationId,
                this.#controller.signal
            );
            await this.#send({
                callId: message.callId,
                ok: true,
                result: projectAgentModelToolResult(message.toolName, result),
                type: "tool.result"
            });
        } catch (error) {
            await this.#send({
                callId: message.callId,
                error: toError(error).message,
                ok: false,
                type: "tool.result"
            });
        }
    }

    async #send(message: OpenCodeParentMessage): Promise<void> {
        await this.#child.send(message as unknown as ExtensionJsonValue);
    }

    #fail(error: Error): void {
        if (this.#stopped) return;
        this.#stopped = true;
        clearInterval(this.#ownerHeartbeat);
        this.#controller.abort(error);
        this.#rejectPending(error);
        this.#close();
        void this.#child.terminate("SIGTERM").catch(() => undefined);
    }

    #rejectPending(error: Error): void {
        this.#readyReject?.(error);
        this.#readyReject = undefined;
        this.#readyResolve = undefined;
        for (const pending of this.#commands.values()) pending.reject(error);
        this.#commands.clear();
    }
}

function assertToolTarget(target: AgentWorkerTarget, session: AgentToolSession): void {
    if (session.target.instance !== target.instance || session.target.workspace !== target.workspace) {
        throw new Error("OpenCode Agent tool session target does not match the Agent target.");
    }
}

function resolveChildModulePath(): string {
    const source = fileURLToPath(import.meta.url);
    return fileURLToPath(new URL(source.endsWith(".ts") ? "./OpenCodeAgentChild.ts" : "./OpenCodeAgentChild.js", import.meta.url));
}

function childExecArgv(childModulePath: string): string[] {
    const sourceMode = childModulePath.endsWith(".ts");
    const result: string[] = [];
    for (let index = 0; index < process.execArgv.length; index += 1) {
        const argument = process.execArgv[index]!;
        if (argument === "--enable-source-maps") {
            result.push(argument);
            continue;
        }
        if (["--import", "--loader", "--experimental-loader", "--require", "-r"].includes(argument)) {
            const specifier = process.execArgv[++index];
            if (specifier === undefined || !sourceMode) continue;
            result.push(argument, resolveExecModule(specifier));
            continue;
        }
        if (
            argument.startsWith("--import=")
            || argument.startsWith("--loader=")
            || argument.startsWith("--experimental-loader=")
            || argument.startsWith("--require=")
        ) {
            if (!sourceMode) continue;
            const delimiter = argument.indexOf("=");
            result.push(`${argument.slice(0, delimiter + 1)}${resolveExecModule(argument.slice(delimiter + 1))}`);
        }
    }
    return result;
}

function resolveExecModule(specifier: string): string {
    if (specifier.startsWith("file:") || specifier.startsWith("/") || specifier.startsWith(".")) return specifier;
    try {
        return import.meta.resolve(specifier);
    } catch {
        return specifier;
    }
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
