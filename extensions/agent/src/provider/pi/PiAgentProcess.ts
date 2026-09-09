import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
    ExtensionJsonValue,
    ExtensionManagedProcess,
    ExtensionProcessCapability
} from "@portable-devshell/extension";

import type { AgentProviderHandle } from "../../builtin/provider/AgentProvider.js";
import type { AgentToolSession } from "../../builtin/provider/AgentToolSession.js";
import type { AgentWorkerTarget } from "../../builtin/worker/AgentWorkerTarget.js";
import type {
    PiChildAgentCommandMessage,
    PiChildMessage,
    PiParentMessage
} from "./PiProcessProtocol.js";

const PI_OWNER_HEARTBEAT_INTERVAL_MS = 2_000;
const PI_OWNER_HEARTBEAT_TIMEOUT_MS = 10_000;

export interface PiAgentProcessStartOptions {
    agentId: string;
    entrypoint: string;
    localCwd: string;
    processes: ExtensionProcessCapability;
    runtimeDirectory: string;
    target: AgentWorkerTarget;
    tools: AgentToolSession;
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
                const managedProcess = await options.processes.start({
                    args: [
                        ...childExecArgv(this.#childModulePath),
                        this.#childModulePath,
                        String(PI_OWNER_HEARTBEAT_TIMEOUT_MS)
                    ],
                    command: process.execPath,
                    cwd: options.runtimeDirectory,
                    messages: true
                });
                runtime = new PiSharedProcess(managedProcess, options);
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
    readonly #child: ExtensionManagedProcess;
    readonly #close: () => void;
    readonly #commands = new Map<string, {
        reject(error: Error): void;
        resolve(): void;
    }>();
    readonly #identity: Pick<PiAgentProcessStartOptions, "entrypoint" | "runtimeDirectory" | "webBasePath">;
    readonly #ownerHeartbeat: NodeJS.Timeout;
    readonly #agents = new Set<string>();
    readonly #toolCalls = new Map<string, AbortController>();
    readonly #toolSessions = new Map<string, AgentToolSession>();
    #stderr = "";
    #readyReject?: (error: Error) => void;
    #readyResolve?: () => void;
    #stopped = false;
    #web?: { upstream: URL };
    readonly closed: Promise<void>;

    constructor(child: ExtensionManagedProcess, options: PiAgentProcessStartOptions) {
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
        this.#child = child;
        this.#child.onStderr((chunk) => {
            this.#stderr = `${this.#stderr}${chunk}`.slice(-16_384);
        });
        this.#child.onMessage((message) => {
            void this.#onMessage(message).catch((error) => this.#fail(
                error instanceof Error ? error : new Error(String(error))
            ));
        });
        void this.#child.closed.then((exit) => {
            if (!this.#stopped) {
                const detail = this.#stderr.trim();
                this.#fail(new Error(
                    `Pi provider child exited unexpectedly (${exit.code ?? exit.signal ?? "unknown"}).${detail.length === 0 ? "" : `\n${detail}`}`
                ));
            }
        }).catch(() => undefined);
        this.#ownerHeartbeat = setInterval(() => {
            if (this.#stopped) return;
            void this.#send({ type: "owner.heartbeat" }).catch((error: unknown) => {
                this.#fail(error instanceof Error ? error : new Error(String(error)));
            });
        }, PI_OWNER_HEARTBEAT_INTERVAL_MS);
        this.#ownerHeartbeat.unref();
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
        assertToolTarget(options.target, options.tools);
        this.#toolSessions.set(options.agentId, options.tools);
        try {
            await this.#request({
                agentId: options.agentId,
                id: randomUUID(),
                localCwd: options.localCwd,
                target: options.target,
                tools: options.tools.tools.map((tool) => ({ ...tool })),
                type: "agent.start"
            });
        } catch (error) {
            this.#toolSessions.delete(options.agentId);
            throw error;
        }
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
            this.#toolSessions.delete(agentId);
        }
    }

    async shutdown(): Promise<void> {
        if (this.#stopped) return;
        this.#stopped = true;
        clearInterval(this.#ownerHeartbeat);
        try {
            await this.#request({ id: randomUUID(), type: "shutdown" }, true);
        } finally {
            this.terminate();
        }
    }

    terminate(): void {
        this.#stopped = true;
        clearInterval(this.#ownerHeartbeat);
        for (const controller of this.#toolCalls.values()) {
            controller.abort(new Error("Pi provider child was terminated."));
        }
        this.#toolCalls.clear();
        this.#rejectPending(new Error("Pi provider child was terminated."));
        this.#agents.clear();
        this.#toolSessions.clear();
        this.#close();
        void this.#child.terminate("SIGTERM").catch(() => undefined);
    }

    async #request(
        message: Exclude<
            PiParentMessage,
            { type: "init" } | { type: "owner.heartbeat" } | { type: "tool.progress" } | { type: "tool.result" }
        >,
        allowStopped = false
    ): Promise<void> {
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

    async #onMessage(value: unknown): Promise<void> {
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
            return;
        }
        if (message?.type === "tool.cancel") {
            this.#toolCalls.get(message.callId)?.abort(new Error(`Pi tool call ${message.callId} was cancelled.`));
            return;
        }
        if (message?.type === "tool.close") {
            await this.#handleToolClose(message.agentId, message.callId);
            return;
        }
        if (message?.type === "tool.call") {
            await this.#handleToolCall(message);
        }
    }

    async #handleToolCall(message: Extract<PiChildMessage, { type: "tool.call" }>): Promise<void> {
        const session = this.#toolSessions.get(message.agentId);
        if (session === undefined) {
            await this.#send({
                agentId: message.agentId,
                callId: message.callId,
                error: `Unknown Pi Agent tool session: ${message.agentId}`,
                ok: false,
                type: "tool.result"
            });
            return;
        }
        const controller = new AbortController();
        this.#toolCalls.set(message.callId, controller);
        try {
            const result = await session.callTool(
                message.toolName,
                message.input,
                message.operationId,
                controller.signal,
                (progress) => {
                    void this.#send({
                        agentId: message.agentId,
                        callId: message.callId,
                        progress,
                        type: "tool.progress"
                    }).catch(() => undefined);
                }
            );
            await this.#send({
                agentId: message.agentId,
                callId: message.callId,
                ok: true,
                result,
                type: "tool.result"
            });
        } catch (error) {
            await this.#send({
                agentId: message.agentId,
                callId: message.callId,
                error: error instanceof Error ? error.message : String(error),
                ok: false,
                type: "tool.result"
            });
        } finally {
            this.#toolCalls.delete(message.callId);
        }
    }

    async #handleToolClose(agentId: string, callId: string): Promise<void> {
        const session = this.#toolSessions.get(agentId);
        try {
            await session?.close();
            await this.#send({ agentId, callId, ok: true, result: null, type: "tool.result" });
        } catch (error) {
            await this.#send({
                agentId,
                callId,
                error: error instanceof Error ? error.message : String(error),
                ok: false,
                type: "tool.result"
            });
        }
    }

    async #send(message: PiParentMessage): Promise<void> {
        await this.#child.send(message as unknown as ExtensionJsonValue);
    }

    #fail(error: Error): void {
        if (this.#stopped) return;
        this.#stopped = true;
        clearInterval(this.#ownerHeartbeat);
        for (const controller of this.#toolCalls.values()) controller.abort(error);
        this.#toolCalls.clear();
        this.#rejectPending(error);
        this.#agents.clear();
        this.#toolSessions.clear();
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
        throw new Error("Pi Agent tool session target does not match the Agent target.");
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
