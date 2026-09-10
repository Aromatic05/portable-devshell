import { randomUUID } from "node:crypto";
import {
    MessageChannel,
    Worker,
    type MessagePort,
    type ResourceLimits,
    type WorkerOptions
} from "node:worker_threads";

import type {
    ExtensionAssetCapability,
    ExtensionCapability,
    ExtensionJsonValue,
    ExtensionLogger,
    ExtensionManagedProcess,
    ExtensionProcessCapability,
    ExtensionWorkerCapability,
    ExtensionWorkerSession
} from "@portable-devshell/extension";
import type { ExtensionArtifactCapability } from "@portable-devshell/extension/artifact";
import type { ExtensionInstanceCapability } from "@portable-devshell/extension/instance";

import type {
    ExtensionPointSandboxBridge,
    ExtensionPointSandboxInterfacePort,
    ExtensionPointSandboxInvokeOptions
} from "../ExtensionPointRegistry.js";

import {
    assertExtensionSandboxMessage,
    deserializeSandboxError,
    serializeSandboxError,
    type ExtensionHostToSandboxMessage,
    type ExtensionSandboxReadyDescriptor,
    type ExtensionSandboxCapabilityOperation,
    type ExtensionSandboxContextData,
    type ExtensionSandboxInvokeOperation,
    type ExtensionSandboxProcessDescriptor,
    type ExtensionSandboxToHostMessage,
    type ExtensionSandboxWorkerData,
    type ExtensionSandboxWorkerSessionDescriptor,
    type SandboxArtifactShareInput,
    type SandboxArtifactTransferInput,
    type SandboxAssetProjectInput,
    type SandboxInstanceCreateInput,
    type SandboxInstanceNameInput,
    type SandboxInstanceReadLogsInput,
    type SandboxInstanceWatchInput,
    type SandboxProcessSendInput,
    type SandboxProcessStartInput,
    type SandboxProcessTerminateInput,
    type SandboxWorkerCallInput,
    type SandboxWorkerCloseInput,
    type SandboxWorkerOpenInput
} from "./ExtensionSandboxProtocol.js";

interface PendingInvocation {
    abort?: () => void;
    abortError?: Error;
    cleanup?: () => void;
    graceTimer?: NodeJS.Timeout;
    reject(error: Error): void;
    resolve(value: unknown): void;
}

interface SandboxManagedProcess {
    process: ExtensionManagedProcess;
    removeMessageListener: () => void;
    removeStderrListener: () => void;
}

export interface ExtensionSandboxHostOptions {
    artifacts: ExtensionArtifactCapability;
    assets: ExtensionAssetCapability;
    capabilities: readonly ExtensionCapability[];
    codeDirectory: string;
    context: ExtensionSandboxContextData;
    delegatedWorker: ExtensionWorkerCapability;
    entryUrl: string;
    externalMemoryLimitMb?: number;
    healthCheckIntervalMs?: number;
    healthCheckTimeoutMs?: number;
    hostDependencies?: readonly string[];
    hostCallbackTimeoutMs?: number;
    initializationTimeoutMs?: number;
    invocationAbortGraceMs?: number;
    instances: ExtensionInstanceCapability;
    logger: ExtensionLogger;
    memoryWatchIntervalMs?: number;
    onFault?(error: Error): void;
    processes: ExtensionProcessCapability;
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

export const DEFAULT_EXTENSION_SANDBOX_EXTERNAL_MEMORY_LIMIT_MB = 128;

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 30_000;
const DEFAULT_INVOCATION_ABORT_GRACE_MS = 1_000;
const DEFAULT_HOST_CALLBACK_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 1_000;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 3_000;
const DEFAULT_MEMORY_WATCH_INTERVAL_MS = 25;
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;
const WORKER_TERMINATE_WAIT_MS = 1_000;

export class ExtensionSandboxHost implements ExtensionPointSandboxBridge {
    readonly #artifactCapability: ExtensionArtifactCapability;
    readonly #assets: ExtensionAssetCapability;
    readonly #externalMemoryLimitBytes: number;
    readonly #healthCheckIntervalMs: number;
    readonly #healthCheckTimeoutMs: number;
    readonly #hostCallbackTimeoutMs: number;
    readonly #initializationTimeoutMs: number;
    readonly #instanceCapability: ExtensionInstanceCapability;
    readonly #invocationAbortGraceMs: number;
    readonly #invocationInterfaces = new Map<string, ExtensionPointSandboxInterfacePort>();
    readonly #logger: ExtensionLogger;
    readonly #memoryWatchIntervalMs: number;
    readonly #onFault?: (error: Error) => void;
    readonly #pending = new Map<string, PendingInvocation>();
    readonly #port: MessagePort;
    readonly #processCapability: ExtensionProcessCapability;
    readonly #processes = new Map<string, SandboxManagedProcess>();
    readonly #capabilityControllers = new Map<string, AbortController>();
    readonly #delegatedWorkerCapability: ExtensionWorkerCapability;
    readonly #ready: Promise<ExtensionSandboxReadyDescriptor>;
    readonly #sessions = new Map<string, ExtensionWorkerSession>();
    readonly #worker: Worker;
    readonly #workerCapability: ExtensionWorkerCapability;
    #closing = false;
    #faulted?: Error;
    #healthDeadlineTimer?: NodeJS.Timeout;
    #healthProbeId?: string;
    #healthTimer?: NodeJS.Timeout;
    #memoryWatchTimer?: NodeJS.Timeout;
    #readyReject?: (error: Error) => void;
    #readySettled = false;
    #readyTimer?: NodeJS.Timeout;
    #sessionCleanup?: Promise<void>;

    get faultError(): Error | undefined {
        return this.#faulted;
    }

    constructor(options: ExtensionSandboxHostOptions) {
        this.#artifactCapability = options.artifacts;
        this.#assets = options.assets;
        this.#delegatedWorkerCapability = options.delegatedWorker;
        this.#externalMemoryLimitBytes = positiveMegabytes(
            options.externalMemoryLimitMb ?? DEFAULT_EXTENSION_SANDBOX_EXTERNAL_MEMORY_LIMIT_MB,
            "Extension sandbox external memory limit"
        ) * 1024 * 1024;
        this.#healthCheckIntervalMs = positiveMilliseconds(
            options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS,
            "Extension sandbox health check interval"
        );
        this.#healthCheckTimeoutMs = positiveMilliseconds(
            options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
            "Extension sandbox health check timeout"
        );
        this.#hostCallbackTimeoutMs = options.hostCallbackTimeoutMs ?? DEFAULT_HOST_CALLBACK_TIMEOUT_MS;
        this.#initializationTimeoutMs = options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
        this.#instanceCapability = options.instances;
        this.#invocationAbortGraceMs = options.invocationAbortGraceMs ?? DEFAULT_INVOCATION_ABORT_GRACE_MS;
        this.#logger = options.logger;
        this.#memoryWatchIntervalMs = positiveMilliseconds(
            options.memoryWatchIntervalMs ?? DEFAULT_MEMORY_WATCH_INTERVAL_MS,
            "Extension sandbox memory watch interval"
        );
        this.#onFault = options.onFault;
        this.#processCapability = options.processes;
        this.#workerCapability = options.worker;
        const workerData: ExtensionSandboxWorkerData = {
            capabilities: [...options.capabilities],
            codeDirectory: options.codeDirectory,
            context: options.context,
            entryUrl: options.entryUrl,
            hostDependencies: [...(options.hostDependencies ?? [])]
        };
        const factory = options.workerFactory ?? ((filename, workerOptions) => new Worker(filename, workerOptions));
        const channel = new MessageChannel();
        this.#port = channel.port1;
        this.#worker = factory(sandboxWorkerModuleUrl(), {
            env: { ...process.env, ESBUILD_WORKER_THREADS: "0" },
            execArgv: extensionSandboxExecArgv(),
            resourceLimits: options.resourceLimits ?? DEFAULT_EXTENSION_SANDBOX_RESOURCE_LIMITS,
            workerData
        });
        this.#ready = new Promise<ExtensionSandboxReadyDescriptor>((resolve, reject) => {
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
                    this.#port.off("message", ready);
                    this.#readySettled = true;
                    this.#readyReject = undefined;
                    this.#scheduleHealthCheck();
                    resolve(message.descriptor);
                    return;
                }
                if (message.type === "initError") {
                    if (this.#readyTimer !== undefined) clearTimeout(this.#readyTimer);
                    this.#readyTimer = undefined;
                    this.#port.off("message", ready);
                    this.#readySettled = true;
                    const error = deserializeSandboxError(message.error);
                    this.#readyReject = undefined;
                    reject(error);
                    this.#fault(error);
                }
            };
            this.#port.on("message", ready);
        });
        this.#port.on("message", (message: ExtensionSandboxToHostMessage) => {
            void this.#accept(message).catch((error: unknown) => this.#fault(toError(error)));
        });
        this.#port.start();
        this.#worker.on("error", (error) => this.#fault(error));
        this.#worker.once("online", () => this.#scheduleMemoryWatch());
        this.#worker.on("exit", (code) => {
            if (!this.#closing && this.#faulted === undefined) {
                this.#fault(new Error(`Extension sandbox worker exited unexpectedly with code ${code}.`));
            }
        });
        try {
            this.#worker.postMessage(
                { port: channel.port2, type: "extensionSandboxBootstrap" },
                [channel.port2]
            );
        } catch (error) {
            this.#port.close();
            void this.#worker.terminate();
            throw error;
        }
    }

    async start(): Promise<ExtensionSandboxReadyDescriptor> {
        return await this.#ready;
    }

    async invokeBinding(
        pointId: string,
        id: string,
        input?: ExtensionJsonValue,
        options: ExtensionPointSandboxInvokeOptions = {}
    ): Promise<unknown> {
        const operation: ExtensionSandboxInvokeOperation = {
            id,
            ...(input === undefined ? {} : { input }),
            kind: "binding",
            pointId
        };
        if (options.timeoutLabel !== undefined) {
            return await this.#invokeHostCallback(operation, options.timeoutLabel);
        }
        return await this.#invoke(operation, options);
    }

    async dispose(): Promise<void> {
        if (this.#closing) return;
        if (this.#faulted !== undefined) {
            const cleanupFailure = await this.#closeSessions().then(
                () => undefined,
                (error: unknown) => toError(error)
            );
            this.#releaseProcessSubscriptions();
            this.#closing = true;
            await this.#terminate();
            if (cleanupFailure !== undefined) throw cleanupFailure;
            return;
        }
        let timer: NodeJS.Timeout | undefined;
        let failure: Error | undefined;
        try {
            await Promise.race([
                this.#invoke({ kind: "deactivate" }),
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
        this.#releaseProcessSubscriptions();
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
            case "runtimeFault":
                this.#fault(deserializeSandboxError(message.error));
                return;
            case "invokeResult": {
                const pending = this.#takePending(message.id);
                if (pending?.abortError !== undefined) pending.reject(pending.abortError);
                else pending?.resolve(message.value);
                return;
            }
            case "invokeError": {
                const pending = this.#takePending(message.id);
                if (pending?.abortError !== undefined) pending.reject(pending.abortError);
                else pending?.reject(deserializeSandboxError(message.error));
                return;
            }
            case "healthPong":
                if (message.id !== this.#healthProbeId) return;
                this.#clearHealthProbe();
                this.#scheduleHealthCheck();
                return;
            case "capabilityRequest":
                if (this.#faulted !== undefined || this.#closing || this.#sessionCleanup !== undefined) return;
                await this.#executeCapability(message.id, message.operation, message.input);
                return;
            case "capabilityCancel":
                this.#capabilityControllers.get(message.id)?.abort(
                    deserializeSandboxError(message.error)
                );
                return;
            case "interfaceRequest": {
                const interfacePort = this.#invocationInterfaces.get(message.invocationId);
                if (interfacePort === undefined) {
                    this.#send({
                        error: serializeSandboxError(new Error("Extension sandbox interface invocation is unavailable.")),
                        id: message.id,
                        type: "interfaceError"
                    });
                    return;
                }
                try {
                    const value = await interfacePort.request(message.operation, message.input);
                    this.#send({
                        id: message.id,
                        type: "interfaceResult",
                        ...(value === undefined ? {} : { value })
                    });
                } catch (error) {
                    this.#send({
                        error: serializeSandboxError(error),
                        id: message.id,
                        type: "interfaceError"
                    });
                }
                return;
            }
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
            case "artifacts.cancelTransfer":
                return await this.#artifactCapability.cancelTransfer(readStringField(input, "transferId"));
            case "artifacts.createShare":
                return await this.#artifactCapability.createShare(input as SandboxArtifactShareInput);
            case "artifacts.getTransfer":
                return await this.#artifactCapability.getTransfer(readStringField(input, "transferId"));
            case "artifacts.listShares":
                return await this.#artifactCapability.listShares();
            case "artifacts.listTransfers":
                return await this.#artifactCapability.listTransfers();
            case "artifacts.revokeShare":
                return await this.#artifactCapability.revokeShare(readStringField(input, "shareId"));
            case "artifacts.startTransfer":
                return await this.#artifactCapability.startTransfer(input as SandboxArtifactTransferInput);
            case "artifacts.waitForTransfer":
                return await this.#artifactCapability.waitForTransfer(readStringField(input, "transferId"));
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
            case "instances.create":
                return await this.#instanceCapability.create((input as SandboxInstanceCreateInput).draft);
            case "instances.createSchema":
                return await this.#instanceCapability.createSchema();
            case "instances.delete":
                return await this.#instanceCapability.delete((input as SandboxInstanceNameInput).name);
            case "instances.disable":
                return await this.#instanceCapability.disable((input as SandboxInstanceNameInput).name);
            case "instances.enable":
                return await this.#instanceCapability.enable((input as SandboxInstanceNameInput).name);
            case "instances.list":
                return await this.#instanceCapability.list();
            case "instances.readLogs": {
                const value = input as SandboxInstanceReadLogsInput;
                return await this.#instanceCapability.readLogs(value.name, value.query);
            }
            case "instances.refresh":
                return await this.#instanceCapability.refresh((input as SandboxInstanceNameInput).name);
            case "instances.snapshot":
                return await this.#instanceCapability.snapshot((input as SandboxInstanceNameInput).name);
            case "instances.start":
                return await this.#instanceCapability.start((input as SandboxInstanceNameInput).name);
            case "instances.stop":
                return await this.#instanceCapability.stop((input as SandboxInstanceNameInput).name);
            case "instances.validateCreate":
                return await this.#instanceCapability.validateCreate((input as SandboxInstanceCreateInput).draft);
            case "instances.watchEvents": {
                const value = input as SandboxInstanceWatchInput;
                await this.#instanceCapability.watchEvents(value.name, {
                    ...(value.eventTypes === undefined ? {} : { eventTypes: [...value.eventTypes] }),
                    fromSeq: value.fromSeq,
                    onEvent: async (event) => this.#send({
                        id,
                        type: "capabilityProgress",
                        value: { event: { ...event }, kind: "event" } as ExtensionJsonValue
                    }),
                    onGap: async (gap) => this.#send({
                        id,
                        type: "capabilityProgress",
                        value: { gap: { ...gap }, kind: "gap" } as ExtensionJsonValue
                    }),
                    signal
                });
                return undefined;
            }
            case "processes.start": {
                const started = await this.#processCapability.start(input as SandboxProcessStartInput);
                if (this.#faulted !== undefined || this.#closing) {
                    await started.terminate();
                    throw this.#faulted ?? new Error("Extension sandbox stopped accepting processes.");
                }
                const processId = randomUUID();
                const registration: SandboxManagedProcess = {
                    process: started,
                    removeMessageListener: started.onMessage((message) => {
                        this.#send({ message, processId, type: "processMessage" });
                    }),
                    removeStderrListener: started.onStderr((chunk) => {
                        this.#send({ chunk, processId, type: "processStderr" });
                    })
                };
                this.#processes.set(processId, registration);
                void started.closed.then((exit) => {
                    if (this.#processes.get(processId) !== registration) return;
                    this.#processes.delete(processId);
                    registration.removeMessageListener();
                    registration.removeStderrListener();
                    this.#send({ exit, processId, type: "processClosed" });
                }).catch(() => undefined);
                return { processId } satisfies ExtensionSandboxProcessDescriptor;
            }
            case "processes.send": {
                const value = input as SandboxProcessSendInput;
                await this.#requireProcess(value.processId).send(value.message);
                return undefined;
            }
            case "processes.terminate": {
                const value = input as SandboxProcessTerminateInput;
                await this.#requireProcess(value.processId).terminate(value.signal);
                return undefined;
            }
            case "workers.openSession": {
                const opened = await this.#workerCapability.openSession(input as SandboxWorkerOpenInput);
                return await this.#registerWorkerSession(opened);
            }
            case "delegatedWorkers.openSession": {
                const opened = await this.#delegatedWorkerCapability.openSession(input as SandboxWorkerOpenInput);
                return await this.#registerWorkerSession(opened);
            }
            case "delegatedWorkers.callTool":
            case "workers.callTool": {
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
            case "delegatedWorkers.closeSession":
            case "workers.closeSession": {
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
        options: ExtensionPointSandboxInvokeOptions = {}
    ): Promise<unknown> {
        const signal = options.signal;
        await this.#ready;
        if (this.#faulted !== undefined) throw this.#faulted;
        if (this.#closing) throw new Error("Extension sandbox is closing.");
        signal?.throwIfAborted();
        const id = randomUUID();
        return await new Promise<unknown>((resolve, reject) => {
            const pending: PendingInvocation = { reject, resolve };
            const abort = () => {
                if (!this.#pending.has(id)) return;
                pending.abortError = abortError(signal);
                this.#send({
                    error: serializeSandboxError(pending.abortError),
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
            if (options.interfacePort !== undefined) {
                this.#invocationInterfaces.set(id, options.interfacePort);
            }
            try {
                this.#send({ id, operation, type: "invoke" });
            } catch (error) {
                this.#takePending(id);
                reject(toError(error));
            }
        });
    }

    async #invokeHostCallback(
        operation: ExtensionSandboxInvokeOperation,
        label: string
    ): Promise<unknown> {
        let timer: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                this.#invoke(operation),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => {
                        const error = new Error(
                            `Extension sandbox ${label} timed out after ${this.#hostCallbackTimeoutMs}ms.`
                        );
                        this.#fault(error);
                        reject(error);
                    }, this.#hostCallbackTimeoutMs);
                })
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }

    #takePending(id: string): PendingInvocation | undefined {
        const pending = this.#pending.get(id);
        if (pending === undefined) return undefined;
        this.#pending.delete(id);
        this.#invocationInterfaces.delete(id);
        if (pending.graceTimer !== undefined) clearTimeout(pending.graceTimer);
        pending.cleanup?.();
        return pending;
    }

    async #registerWorkerSession(opened: ExtensionWorkerSession): Promise<ExtensionSandboxWorkerSessionDescriptor> {
        if (this.#faulted !== undefined || this.#closing || this.#sessionCleanup !== undefined) {
            await opened.close();
            throw this.#faulted ?? new Error("Extension sandbox stopped accepting Worker sessions.");
        }
        const sessionId = randomUUID();
        this.#sessions.set(sessionId, opened);
        void opened.closed.then(() => {
            this.#sessions.delete(sessionId);
            this.#send({ sessionId, type: "workerSessionClosed" });
        }).catch(() => undefined);
        return {
            environment: opened.environment,
            instance: opened.instance,
            sessionId,
            tools: opened.listTools(),
            workspace: opened.workspace
        };
    }

    #requireSession(id: string): ExtensionWorkerSession {
        const session = this.#sessions.get(id);
        if (session !== undefined) return session;
        throw new Error(`Extension sandbox Worker session is unavailable: ${id}.`);
    }

    #requireProcess(id: string): ExtensionManagedProcess {
        const process = this.#processes.get(id)?.process;
        if (process !== undefined) return process;
        throw new Error(`Extension sandbox managed process is unavailable: ${id}.`);
    }

    #send(message: ExtensionHostToSandboxMessage): void {
        if (this.#closing || this.#faulted !== undefined) return;
        assertExtensionSandboxMessage(message, "Extension sandbox inbound message");
        this.#port.postMessage(message);
    }

    #fault(error: Error): void {
        if (this.#faulted !== undefined || this.#closing) return;
        this.#faulted = error;
        this.#clearHealthCheck();
        this.#clearMemoryWatch();
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
        this.#invocationInterfaces.clear();
        this.#releaseProcessSubscriptions();
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

    #releaseProcessSubscriptions(): void {
        for (const registration of this.#processes.values()) {
            registration.removeMessageListener();
            registration.removeStderrListener();
        }
        this.#processes.clear();
    }

    async #terminate(): Promise<void> {
        this.#clearHealthCheck();
        this.#clearMemoryWatch();
        this.#port.close();
        this.#worker.unref();
        const termination = this.#worker.terminate().then(() => undefined, () => undefined);
        await Promise.race([termination, delay(WORKER_TERMINATE_WAIT_MS)]);
    }

    #scheduleMemoryWatch(): void {
        if (this.#closing || this.#faulted !== undefined || this.#memoryWatchTimer !== undefined) return;
        this.#memoryWatchTimer = setTimeout(() => {
            this.#memoryWatchTimer = undefined;
            void this.#checkExternalMemory();
        }, this.#memoryWatchIntervalMs);
        this.#memoryWatchTimer.unref();
    }

    async #checkExternalMemory(): Promise<void> {
        if (this.#closing || this.#faulted !== undefined) return;
        try {
            const statistics = await this.#worker.getHeapStatistics();
            if (this.#closing || this.#faulted !== undefined) return;
            if (statistics.external_memory > this.#externalMemoryLimitBytes) {
                const observedMiB = Math.ceil(statistics.external_memory / (1024 * 1024));
                const limitMiB = Math.floor(this.#externalMemoryLimitBytes / (1024 * 1024));
                this.#fault(new Error(
                    `Extension sandbox external memory exceeded ${limitMiB} MiB (observed ${observedMiB} MiB).`
                ));
                return;
            }
        } catch (error) {
            if (!this.#closing && this.#faulted === undefined) this.#fault(toError(error));
            return;
        }
        this.#scheduleMemoryWatch();
    }

    #clearMemoryWatch(): void {
        if (this.#memoryWatchTimer === undefined) return;
        clearTimeout(this.#memoryWatchTimer);
        this.#memoryWatchTimer = undefined;
    }

    #scheduleHealthCheck(): void {
        if (
            this.#closing
            || this.#faulted !== undefined
            || !this.#readySettled
            || this.#healthTimer !== undefined
            || this.#healthProbeId !== undefined
        ) return;
        this.#healthTimer = setTimeout(() => {
            this.#healthTimer = undefined;
            this.#checkHealth();
        }, this.#healthCheckIntervalMs);
        this.#healthTimer.unref();
    }

    #checkHealth(): void {
        if (this.#closing || this.#faulted !== undefined) return;
        if (this.#pending.size > 0) {
            this.#scheduleHealthCheck();
            return;
        }
        const id = randomUUID();
        this.#healthProbeId = id;
        this.#send({ id, type: "healthPing" });
        this.#healthDeadlineTimer = setTimeout(() => {
            if (this.#healthProbeId !== id || this.#closing || this.#faulted !== undefined) return;
            this.#fault(new Error(
                `Extension sandbox did not respond to an idle health check within ${this.#healthCheckTimeoutMs}ms.`
            ));
        }, this.#healthCheckTimeoutMs);
        this.#healthDeadlineTimer.unref();
    }

    #clearHealthProbe(): void {
        this.#healthProbeId = undefined;
        if (this.#healthDeadlineTimer !== undefined) clearTimeout(this.#healthDeadlineTimer);
        this.#healthDeadlineTimer = undefined;
    }

    #clearHealthCheck(): void {
        if (this.#healthTimer !== undefined) clearTimeout(this.#healthTimer);
        this.#healthTimer = undefined;
        this.#clearHealthProbe();
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

function extensionSandboxExecArgv(): string[] {
    return [
        ...(import.meta.url.endsWith(".ts")
            ? sourceSandboxExecArgv()
            : sandboxInheritedExecArgv(process.execArgv)),
        "--permission",
        "--allow-fs-read=*",
        "--allow-fs-write=*",
        "--disable-warning=SecurityWarning"
    ];
}

function sourceSandboxExecArgv(): string[] {
    return [
        "--enable-source-maps",
        "--disable-warning=ExperimentalWarning",
        `--import=${new URL("./ExtensionSandboxSourceLoader.mjs", import.meta.url).href}`
    ];
}

function sandboxInheritedExecArgv(arguments_: readonly string[]): string[] {
    const inherited: string[] = [];
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index]!;
        if (
            argument === "--enable-source-maps"
            || argument.startsWith("--import=")
            || argument.startsWith("--loader=")
            || argument.startsWith("--experimental-loader=")
            || argument.startsWith("--require=")
        ) {
            inherited.push(argument);
            continue;
        }
        if (["--import", "--loader", "--experimental-loader", "--require", "-r"].includes(argument)) {
            const value = arguments_[++index];
            if (value !== undefined) inherited.push(argument, value);
        }
    }
    return inherited;
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

function positiveMegabytes(value: number, label: string): number {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be greater than zero.`);
    return value;
}

function positiveMilliseconds(value: number, label: string): number {
    if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
        throw new RangeError(`${label} must be a positive integer.`);
    }
    return value;
}

function abortError(signal: AbortSignal | undefined): Error {
    return signal?.reason instanceof Error
        ? signal.reason
        : new Error("Extension sandbox invocation was aborted.");
}

async function delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
