import { randomUUID } from "node:crypto";
import { Worker, type ResourceLimits, type WorkerOptions } from "node:worker_threads";

import type {
    ExtensionAssetCapability,
    ExtensionCommandResult,
    ExtensionInstanceRetireEvent,
    ExtensionInvocationContext,
    ExtensionJsonValue,
    ExtensionLogger,
    ExtensionWorkerCapability,
    ExtensionWorkerSession
} from "@portable-devshell/extension";

import {
    deserializeSandboxError,
    invocationContextData,
    serializeSandboxError,
    type ExtensionHostToSandboxMessage,
    type ExtensionSandboxActivationDescriptor,
    type ExtensionSandboxCapabilityOperation,
    type ExtensionSandboxContextData,
    type ExtensionSandboxInvokeOperation,
    type ExtensionSandboxToHostMessage,
    type ExtensionSandboxWorkerData,
    type ExtensionSandboxWorkerSessionDescriptor,
    type SandboxAssetProjectInput,
    type SandboxCommandResult,
    type SandboxWorkerCallInput,
    type SandboxWorkerCloseInput,
    type SandboxWorkerOpenInput
} from "./ExtensionSandboxProtocol.js";

interface PendingInvocation {
    abort?: () => void;
    cleanup?: () => void;
    graceTimer?: NodeJS.Timeout;
    reject(error: Error): void;
    resolve(value: unknown): void;
}

export interface ExtensionSandboxHostOptions {
    assets: ExtensionAssetCapability;
    codeDirectory: string;
    context: ExtensionSandboxContextData;
    entryUrl: string;
    initializationTimeoutMs?: number;
    invocationAbortGraceMs?: number;
    logger: ExtensionLogger;
    onFault?(error: Error): void;
    resourceLimits?: ResourceLimits;
    worker: ExtensionWorkerCapability;
    workerFactory?: ExtensionSandboxWorkerFactory;
}

export type ExtensionSandboxWorkerFactory = (
    filename: URL,
    options: WorkerOptions
) => Worker;

export const DEFAULT_EXTENSION_SANDBOX_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
    maxOldGenerationSizeMb: 128,
    maxYoungGenerationSizeMb: 32,
    stackSizeMb: 4
});

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30_000;
const DEFAULT_INVOCATION_ABORT_GRACE_MS = 1_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;
const WORKER_TERMINATE_WAIT_MS = 1_000;

export class ExtensionSandboxHost {
    readonly #assets: ExtensionAssetCapability;
    readonly #initializationTimeoutMs: number;
    readonly #invocationAbortGraceMs: number;
    readonly #logger: ExtensionLogger;
    readonly #onFault?: (error: Error) => void;
    readonly #pending = new Map<string, PendingInvocation>();
    readonly #capabilityControllers = new Map<string, AbortController>();
    readonly #ready: Promise<ExtensionSandboxActivationDescriptor>;
    readonly #sessions = new Map<string, ExtensionWorkerSession>();
    readonly #worker: Worker;
    readonly #workerCapability: ExtensionWorkerCapability;
    #closing = false;
    #faulted?: Error;
    #readyReject?: (error: Error) => void;
    #readySettled = false;
    #readyTimer?: NodeJS.Timeout;
    #sessionCleanup?: Promise<void>;

    get faultError(): Error | undefined {
        return this.#faulted;
    }

    constructor(options: ExtensionSandboxHostOptions) {
        this.#assets = options.assets;
        this.#initializationTimeoutMs = options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
        this.#invocationAbortGraceMs = options.invocationAbortGraceMs ?? DEFAULT_INVOCATION_ABORT_GRACE_MS;
        this.#logger = options.logger;
        this.#onFault = options.onFault;
        this.#workerCapability = options.worker;
        const workerData: ExtensionSandboxWorkerData = {
            codeDirectory: options.codeDirectory,
            context: options.context,
            entryUrl: options.entryUrl
        };
        const factory = options.workerFactory ?? ((filename, workerOptions) => new Worker(filename, workerOptions));
        this.#worker = factory(sandboxWorkerModuleUrl(), {
            resourceLimits: options.resourceLimits ?? DEFAULT_EXTENSION_SANDBOX_RESOURCE_LIMITS,
            workerData
        });
        this.#ready = new Promise<ExtensionSandboxActivationDescriptor>((resolve, reject) => {
            this.#readyReject = reject;
            this.#readyTimer = setTimeout(() => {
                if (this.#readySettled) return;
                const error = new Error(
                    `Extension sandbox initialization timed out after ${this.#initializationTimeoutMs}ms.`
                );
                this.#readySettled = true;
                this.#readyReject = undefined;
                reject(error);
                this.#fault(error);
            }, this.#initializationTimeoutMs);
            const ready = (message: ExtensionSandboxToHostMessage) => {
                if (message.type === "ready") {
                    if (this.#readyTimer !== undefined) clearTimeout(this.#readyTimer);
                    this.#readyTimer = undefined;
                    this.#worker.off("message", ready);
                    this.#readySettled = true;
                    this.#readyReject = undefined;
                    resolve(message.activation);
                    return;
                }
                if (message.type === "initError") {
                    if (this.#readyTimer !== undefined) clearTimeout(this.#readyTimer);
                    this.#readyTimer = undefined;
                    this.#worker.off("message", ready);
                    this.#readySettled = true;
                    const error = deserializeSandboxError(message.error);
                    this.#readyReject = undefined;
                    reject(error);
                    this.#fault(error);
                }
            };
            this.#worker.on("message", ready);
        });
        this.#worker.on("message", (message: ExtensionSandboxToHostMessage) => {
            void this.#accept(message);
        });
        this.#worker.on("error", (error) => this.#fault(error));
        this.#worker.on("exit", (code) => {
            if (!this.#closing && this.#faulted === undefined) {
                this.#fault(new Error(`Extension sandbox worker exited unexpectedly with code ${code}.`));
            }
        });
    }

    async start(): Promise<ExtensionSandboxActivationDescriptor> {
        return await this.#ready;
    }

    async command(
        argv: readonly string[],
        context: ExtensionInvocationContext
    ): Promise<ExtensionCommandResult> {
        return await this.#invoke({
            argv: [...argv],
            context: invocationContextData(context),
            kind: "command"
        }, context.signal) as SandboxCommandResult;
    }

    async rpc(
        operation: string,
        input: ExtensionJsonValue | undefined,
        context: ExtensionInvocationContext
    ): Promise<ExtensionJsonValue> {
        return await this.#invoke({
            context: invocationContextData(context),
            ...(input === undefined ? {} : { input }),
            kind: "rpc",
            operation
        }, context.signal) as ExtensionJsonValue;
    }

    async retireInstance(event: ExtensionInstanceRetireEvent): Promise<void> {
        await this.#invoke({ event: { ...event }, kind: "instanceRetire" });
    }

    async resolveUpstream(): Promise<URL | undefined> {
        const value = await this.#invoke({ kind: "resolveUpstream" });
        if (value === undefined) return undefined;
        if (typeof value !== "string") {
            throw new TypeError("Extension sandbox Web proxy returned a non-string URL.");
        }
        return new URL(value);
    }

    async dispose(): Promise<void> {
        if (this.#closing) return;
        if (this.#faulted !== undefined) {
            const cleanupFailure = await this.#closeSessions().then(
                () => undefined,
                (error: unknown) => toError(error)
            );
            this.#closing = true;
            await this.#terminate();
            if (cleanupFailure !== undefined) throw cleanupFailure;
            return;
        }
        let timer: NodeJS.Timeout | undefined;
        let failure: Error | undefined;
        try {
            await Promise.race([
                this.#invoke({ kind: "dispose" }),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => {
                        reject(new Error(
                            `Extension sandbox disposal timed out after ${DEFAULT_DISPOSE_TIMEOUT_MS}ms.`
                        ));
                    }, DEFAULT_DISPOSE_TIMEOUT_MS);
                })
            ]);
        } catch (error) {
            failure = toError(error);
            this.#fault(failure);
        }
        if (timer !== undefined) clearTimeout(timer);
        const cleanupFailure = await this.#closeSessions().then(
            () => undefined,
            (error: unknown) => toError(error)
        );
        this.#closing = true;
        await this.#terminate();
        if (failure !== undefined && cleanupFailure !== undefined) {
            throw new AggregateError(
                [failure, cleanupFailure],
                "Extension sandbox disposal and Worker session cleanup both failed."
            );
        }
        if (failure !== undefined) throw failure;
        if (cleanupFailure !== undefined) throw cleanupFailure;
    }

    async #accept(message: ExtensionSandboxToHostMessage): Promise<void> {
        switch (message.type) {
            case "ready":
            case "initError":
                return;
            case "invokeResult": {
                const pending = this.#takePending(message.id);
                pending?.resolve(message.value);
                return;
            }
            case "invokeError": {
                const pending = this.#takePending(message.id);
                pending?.reject(deserializeSandboxError(message.error));
                return;
            }
            case "capabilityRequest":
                await this.#executeCapability(message.id, message.operation, message.input);
                return;
            case "capabilityCancel":
                this.#capabilityControllers.get(message.id)?.abort(
                    deserializeSandboxError(message.error)
                );
                return;
            case "log":
                this.#logger[message.level](message.message, message.details);
                return;
        }
    }

    async #executeCapability(
        id: string,
        operation: ExtensionSandboxCapabilityOperation,
        input: unknown
    ): Promise<void> {
        const controller = new AbortController();
        this.#capabilityControllers.set(id, controller);
        try {
            const value = await this.#dispatchCapability(id, operation, input, controller.signal);
            this.#send({ id, type: "capabilityResult", ...(value === undefined ? {} : { value }) });
        } catch (error) {
            this.#send({
                error: serializeSandboxError(error),
                id,
                type: "capabilityError"
            });
        } finally {
            this.#capabilityControllers.delete(id);
        }
    }

    async #dispatchCapability(
        id: string,
        operation: ExtensionSandboxCapabilityOperation,
        input: unknown,
        signal: AbortSignal
    ): Promise<unknown> {
        switch (operation) {
            case "assets.installBundle":
                return await this.#assets.installBundle(readStringField(input, "sourcePath"));
            case "assets.installDirectory":
                return await this.#assets.installDirectory(readStringField(input, "sourcePath"));
            case "assets.listBundles":
                return await this.#assets.listBundles();
            case "assets.resolveBundle":
                return await this.#assets.resolveBundle(readStringField(input, "generation"));
            case "assets.removeBundle":
                await this.#assets.removeBundle(readStringField(input, "generation"));
                return undefined;
            case "assets.projectBundle": {
                const value = input as SandboxAssetProjectInput;
                return await this.#assets.projectBundle({
                    generation: value.generation,
                    ...(value.overwrite === undefined ? {} : { overwrite: value.overwrite }),
                    signal,
                    target: { ...value.target }
                });
            }
            case "worker.openSession": {
                const opened = await this.#workerCapability.openSession(input as SandboxWorkerOpenInput);
                const sessionId = randomUUID();
                this.#sessions.set(sessionId, opened);
                return {
                    environment: opened.environment,
                    instance: opened.instance,
                    sessionId,
                    tools: opened.listTools(),
                    workspace: opened.workspace
                } satisfies ExtensionSandboxWorkerSessionDescriptor;
            }
            case "worker.callTool": {
                const value = input as SandboxWorkerCallInput;
                const session = this.#requireSession(value.sessionId);
                return await session.callTool(value.toolName, value.input, {
                    ...(value.operationId === undefined ? {} : { operationId: value.operationId }),
                    onProgress: (progress) => this.#send({
                        id,
                        type: "capabilityProgress",
                        value: progress
                    }),
                    signal
                });
            }
            case "worker.closeSession": {
                const value = input as SandboxWorkerCloseInput;
                const session = this.#sessions.get(value.sessionId);
                if (session === undefined) return undefined;
                this.#sessions.delete(value.sessionId);
                await session.close();
                return undefined;
            }
        }
    }

    async #invoke(
        operation: ExtensionSandboxInvokeOperation,
        signal?: AbortSignal
    ): Promise<unknown> {
        await this.#ready;
        if (this.#faulted !== undefined) throw this.#faulted;
        if (this.#closing) throw new Error("Extension sandbox is closing.");
        signal?.throwIfAborted();
        const id = randomUUID();
        return await new Promise<unknown>((resolve, reject) => {
            const pending: PendingInvocation = { reject, resolve };
            const abort = () => {
                if (!this.#pending.has(id)) return;
                this.#send({
                    error: serializeSandboxError(abortError(signal)),
                    id,
                    type: "invokeCancel"
                });
                pending.graceTimer = setTimeout(() => {
                    if (!this.#pending.has(id)) return;
                    this.#fault(new Error(
                        `Extension sandbox invocation ${id} did not stop after cancellation.`
                    ));
                }, this.#invocationAbortGraceMs);
            };
            if (signal !== undefined) {
                pending.abort = abort;
                pending.cleanup = () => signal.removeEventListener("abort", abort);
                signal.addEventListener("abort", abort, { once: true });
            }
            this.#pending.set(id, pending);
            try {
                this.#send({ id, operation, type: "invoke" });
            } catch (error) {
                this.#takePending(id);
                reject(toError(error));
            }
        });
    }

    #takePending(id: string): PendingInvocation | undefined {
        const pending = this.#pending.get(id);
        if (pending === undefined) return undefined;
        this.#pending.delete(id);
        if (pending.graceTimer !== undefined) clearTimeout(pending.graceTimer);
        pending.cleanup?.();
        return pending;
    }

    #requireSession(id: string): ExtensionWorkerSession {
        const session = this.#sessions.get(id);
        if (session !== undefined) return session;
        throw new Error(`Extension sandbox Worker session is unavailable: ${id}.`);
    }

    #send(message: ExtensionHostToSandboxMessage): void {
        if (this.#closing || this.#faulted !== undefined) return;
        this.#worker.postMessage(message);
    }

    #fault(error: Error): void {
        if (this.#faulted !== undefined || this.#closing) return;
        this.#faulted = error;
        if (!this.#readySettled) {
            this.#readySettled = true;
            if (this.#readyTimer !== undefined) clearTimeout(this.#readyTimer);
            this.#readyTimer = undefined;
            this.#readyReject?.(error);
            this.#readyReject = undefined;
        }
        for (const [id, pending] of this.#pending) {
            this.#pending.delete(id);
            if (pending.graceTimer !== undefined) clearTimeout(pending.graceTimer);
            pending.cleanup?.();
            pending.reject(error);
        }
        for (const controller of this.#capabilityControllers.values()) controller.abort(error);
        this.#capabilityControllers.clear();
        void this.#closeSessions().catch((cleanupError: unknown) => {
            this.#logger.warn("Extension sandbox Worker sessions did not close cleanly after a fault.", {
                error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            });
        });
        this.#onFault?.(error);
        void this.#terminate();
    }

    async #closeSessions(): Promise<void> {
        this.#sessionCleanup ??= this.#closeSessionsOnce();
        await this.#sessionCleanup;
    }

    async #closeSessionsOnce(): Promise<void> {
        const sessions = [...this.#sessions.values()];
        this.#sessions.clear();
        const settled = await Promise.allSettled(sessions.map(async (session) => await session.close()));
        const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(failures, "Extension sandbox Worker sessions failed to close.");
        }
    }

    async #terminate(): Promise<void> {
        this.#worker.unref();
        const termination = this.#worker.terminate().then(() => undefined, () => undefined);
        await Promise.race([termination, delay(WORKER_TERMINATE_WAIT_MS)]);
    }
}

function sandboxWorkerModuleUrl(): URL {
    return new URL(
        import.meta.url.endsWith(".ts")
            ? "./ExtensionSandboxWorker.ts"
            : "./ExtensionSandboxWorker.js",
        import.meta.url
    );
}

function readStringField(input: unknown, field: string): string {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new TypeError(`Extension sandbox capability ${field} input must be an object.`);
    }
    const value = (input as Record<string, unknown>)[field];
    if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`Extension sandbox capability ${field} must be a non-empty string.`);
    }
    return value;
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function abortError(signal: AbortSignal | undefined): Error {
    return signal?.reason instanceof Error
        ? signal.reason
        : new Error("Extension sandbox invocation was aborted.");
}

async function delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
