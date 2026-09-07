import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { AgentProviderHandle } from "../AgentProvider.js";
import type { AgentWorkerTarget } from "../../target/AgentWorkerTarget.js";
import type {
    PiChildAgentCommandMessage,
    PiChildMessage,
    PiParentMessage
} from "./PiProcessProtocol.js";

export interface PiAgentProcessStartOptions {
    agentId: string;
    entrypoint: string;
    localCwd: string;
    runtimeDirectory: string;
    target: AgentWorkerTarget;
    webBasePath: string;
}

export interface PiAgentRuntimeFactory {
    start(options: PiAgentProcessStartOptions): Promise<AgentProviderHandle>;
}

export class PiAgentProcessFactory implements PiAgentRuntimeFactory {
    readonly #childModulePath: string;
    #runtime?: PiSharedProcess;
    #lifecycleTail: Promise<void> = Promise.resolve();

    constructor(options: { childModulePath?: string } = {}) {
        this.#childModulePath = options.childModulePath ?? resolveChildModulePath();
    }

    async start(options: PiAgentProcessStartOptions): Promise<AgentProviderHandle> {
        return await this.#exclusive(async () => {
            let runtime = this.#runtime;
            if (runtime === undefined) {
                await mkdir(options.runtimeDirectory, { recursive: true });
                runtime = new PiSharedProcess(this.#childModulePath, options);
                try {
                    await runtime.initialize();
                } catch (error) {
                    runtime.terminate();
                    throw error;
                }
                this.#runtime = runtime;
                void runtime.closed.then(() => {
                    if (this.#runtime === runtime) this.#runtime = undefined;
                });
            } else {
                runtime.assertCompatible(options);
            }

            try {
                await runtime.startAgent(options);
            } catch (error) {
                if (runtime.agentCount === 0 && this.#runtime === runtime) {
                    this.#runtime = undefined;
                    await runtime.shutdown().catch(() => runtime.terminate());
                }
                throw error;
            }

            return new PiAgentSessionHandle(
                runtime,
                options.agentId,
                async () => await this.#stopAgent(runtime, options.agentId)
            );
        });
    }

    async #stopAgent(runtime: PiSharedProcess, agentId: string): Promise<void> {
        await this.#exclusive(async () => {
            if (this.#runtime !== runtime) return;
            let failure: unknown;
            try {
                await runtime.stopAgent(agentId);
            } catch (error) {
                failure = error;
            }
            if (runtime.agentCount === 0) {
                this.#runtime = undefined;
                await runtime.shutdown().catch((error) => {
                    runtime.terminate();
                    if (failure === undefined) failure = error;
                });
            }
            if (failure !== undefined) throw failure;
        });
    }

    async #exclusive<T>(action: () => Promise<T>): Promise<T> {
        const previous = this.#lifecycleTail;
        let release!: () => void;
        this.#lifecycleTail = new Promise<void>((resolve) => {
            release = resolve;
        });
        await previous;
        try {
            return await action();
        } finally {
            release();
        }
    }
}

class PiAgentSessionHandle implements AgentProviderHandle {
    readonly #agentId: string;
    readonly #close: () => void;
    readonly #runtime: PiSharedProcess;
    readonly #stopAgent: () => Promise<void>;
    readonly closed: Promise<void>;
    #stopped = false;

    constructor(runtime: PiSharedProcess, agentId: string, stopAgent: () => Promise<void>) {
        this.#runtime = runtime;
        this.#agentId = agentId;
        this.#stopAgent = stopAgent;
        let close!: () => void;
        const localClosed = new Promise<void>((resolve) => {
            close = resolve;
        });
        this.#close = close;
        this.closed = Promise.race([localClosed, runtime.closed]);
    }

    get web(): { upstream: URL } {
        return { upstream: new URL(this.#runtime.web.upstream) };
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

    async reload(): Promise<void> {
        await this.#command("reload");
    }

    async stop(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        try {
            await this.#stopAgent();
        } finally {
            this.#close();
        }
    }

    async #command(command: PiChildAgentCommandMessage["command"], message?: string): Promise<void> {
        if (this.#stopped) throw new Error(`Pi Agent ${this.#agentId} is already stopped.`);
        await this.#runtime.command(this.#agentId, command, message);
    }
}

class PiSharedProcess {
    readonly #child: ChildProcess;
    readonly #close: () => void;
    readonly #commands = new Map<string, {
        reject(error: Error): void;
        resolve(): void;
    }>();
    readonly #identity: Pick<PiAgentProcessStartOptions, "entrypoint" | "runtimeDirectory" | "webBasePath">;
    readonly #agents = new Set<string>();
    #stderr = "";
    #readyReject?: (error: Error) => void;
    #readyResolve?: () => void;
    #stopped = false;
    #web?: { upstream: URL };
    readonly closed: Promise<void>;

    constructor(childModulePath: string, options: PiAgentProcessStartOptions) {
        let close!: () => void;
        this.closed = new Promise<void>((resolve) => {
            close = resolve;
        });
        this.#close = close;
        this.#identity = {
            entrypoint: options.entrypoint,
            runtimeDirectory: options.runtimeDirectory,
            webBasePath: options.webBasePath
        };
        this.#child = fork(childModulePath, [], {
            cwd: options.runtimeDirectory,
            env: process.env,
            execArgv: childExecArgv(childModulePath),
            serialization: "json",
            stdio: ["ignore", "ignore", "pipe", "ipc"]
        });
        this.#child.stderr?.setEncoding("utf8");
        this.#child.stderr?.on("data", (chunk: string) => {
            this.#stderr = `${this.#stderr}${chunk}`.slice(-16_384);
        });
        this.#child.on("message", (message) => this.#onMessage(message));
        this.#child.once("disconnect", () => {
            if (!this.#stopped) {
                this.#fail(new Error("Pi provider child IPC disconnected unexpectedly."));
            }
        });
        this.#child.once("error", (error) => this.#fail(error));
        this.#child.once("exit", (code, signal) => {
            if (!this.#stopped) {
                const detail = this.#stderr.trim();
                this.#fail(new Error(
                    `Pi provider child exited unexpectedly (${code ?? signal ?? "unknown"}).${detail.length === 0 ? "" : `\n${detail}`}`
                ));
            }
        });
    }

    get agentCount(): number {
        return this.#agents.size;
    }

    get web(): { upstream: URL } {
        if (this.#web === undefined) throw new Error("Pi provider WebUI is not initialized.");
        return this.#web;
    }

    assertCompatible(options: PiAgentProcessStartOptions): void {
        for (const field of ["runtimeDirectory", "entrypoint", "webBasePath"] as const) {
            if (options[field] !== this.#identity[field]) {
                throw new Error(`Pi provider shared process cannot change ${field} while Agents are running.`);
            }
        }
    }

    async initialize(): Promise<void> {
        const ready = new Promise<void>((resolve, reject) => {
            this.#readyResolve = resolve;
            this.#readyReject = reject;
        });
        await this.#send({
            entrypoint: this.#identity.entrypoint,
            type: "init",
            webBasePath: this.#identity.webBasePath
        });
        await ready;
    }

    async startAgent(options: PiAgentProcessStartOptions): Promise<void> {
        if (this.#agents.has(options.agentId)) throw new Error(`Pi Agent already exists: ${options.agentId}`);
        this.assertCompatible(options);
        await this.#request({
            agentId: options.agentId,
            id: randomUUID(),
            localCwd: options.localCwd,
            target: options.target,
            type: "agent.start"
        });
        this.#agents.add(options.agentId);
    }

    async command(
        agentId: string,
        command: PiChildAgentCommandMessage["command"],
        message?: string
    ): Promise<void> {
        if (!this.#agents.has(agentId)) throw new Error(`Unknown Pi Agent: ${agentId}`);
        await this.#request({
            agentId,
            command,
            id: randomUUID(),
            ...(message === undefined ? {} : { message }),
            type: "agent.command"
        });
    }

    async stopAgent(agentId: string): Promise<void> {
        if (!this.#agents.has(agentId)) return;
        try {
            await this.command(agentId, "stop");
        } finally {
            this.#agents.delete(agentId);
        }
    }

    async shutdown(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        try {
            await this.#request({ id: randomUUID(), type: "shutdown" }, true);
        } finally {
            this.terminate();
        }
    }

    terminate(): void {
        this.#stopped = true;
        this.#rejectPending(new Error("Pi provider child was terminated."));
        this.#agents.clear();
        this.#close();
        if (this.#child.connected) this.#child.disconnect();
        if (this.#child.exitCode === null && this.#child.signalCode === null) {
            this.#child.kill("SIGTERM");
        }
    }

    async #request(message: Exclude<PiParentMessage, { type: "init" }>, allowStopped = false): Promise<void> {
        if (this.#stopped && !allowStopped) throw new Error("Pi provider child is already stopped.");
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

    #onMessage(value: unknown): void {
        const message = value as PiChildMessage;
        if (message?.type === "ready") {
            if (!message.ok) {
                this.#readyReject?.(new Error(message.error ?? "Pi provider child initialization failed."));
                this.#readyResolve = undefined;
                this.#readyReject = undefined;
                return;
            }
            if (message.webUpstream === undefined) {
                this.#readyReject?.(new Error("Pi provider child did not expose its WebUI."));
            } else {
                this.#web = { upstream: new URL(message.webUpstream) };
                this.#readyResolve?.();
            }
            this.#readyResolve = undefined;
            this.#readyReject = undefined;
            return;
        }
        if (message?.type === "result") {
            const pending = this.#commands.get(message.id);
            if (pending === undefined) return;
            this.#commands.delete(message.id);
            if (message.ok) pending.resolve();
            else pending.reject(new Error(message.error ?? "Pi provider command failed."));
        }
    }

    async #send(message: PiParentMessage): Promise<void> {
        if (!this.#child.connected || this.#child.send === undefined) {
            throw new Error("Pi provider child IPC is unavailable.");
        }
        await new Promise<void>((resolve, reject) => {
            this.#child.send!(message, (error) => error === null ? resolve() : reject(error));
        });
    }

    #fail(error: Error): void {
        this.#stopped = true;
        this.#rejectPending(error);
        this.#agents.clear();
        this.#close();
        if (this.#child.exitCode === null && this.#child.signalCode === null) {
            this.#child.kill("SIGTERM");
        }
    }

    #rejectPending(error: Error): void {
        this.#readyReject?.(error);
        this.#readyReject = undefined;
        this.#readyResolve = undefined;
        for (const pending of this.#commands.values()) pending.reject(error);
        this.#commands.clear();
    }
}

function resolveChildModulePath(): string {
    const source = fileURLToPath(import.meta.url);
    return fileURLToPath(new URL(source.endsWith(".ts") ? "./PiAgentChild.ts" : "./PiAgentChild.js", import.meta.url));
}

function childExecArgv(childModulePath: string): string[] {
    const sourceMode = childModulePath.endsWith(".ts");
    const result: string[] = [];
    for (let index = 0; index < process.execArgv.length; index += 1) {
        const argument = process.execArgv[index]!;
        if (argument.startsWith("--input-type")) continue;
        if (argument === "--import" || argument === "--loader") {
            const specifier = process.execArgv[++index];
            if (specifier === undefined || !sourceMode) continue;
            result.push(argument, resolveExecModule(specifier));
            continue;
        }
        if (argument.startsWith("--import=") || argument.startsWith("--loader=")) {
            if (!sourceMode) continue;
            const delimiter = argument.indexOf("=");
            result.push(`${argument.slice(0, delimiter + 1)}${resolveExecModule(argument.slice(delimiter + 1))}`);
            continue;
        }
        result.push(argument);
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
