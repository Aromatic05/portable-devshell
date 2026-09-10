import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import type {
    ExtensionAssetBundle,
    ExtensionAssetCapability,
    ExtensionAssetProjectionInput,
    ExtensionAssetProjectionResult,
    ExtensionCapabilities,
    ExtensionContext,
    ExtensionJsonValue,
    ExtensionLogger,
    ExtensionManagedProcess,
    ExtensionModule,
    ExtensionProcessCapability,
    ExtensionProcessExit,
    ExtensionProcessStartInput,
    ExtensionWorkerCapability,
    ExtensionWorkerSession
} from "@portable-devshell/extension";
import type {
    ExtensionArtifactCapability,
    ExtensionArtifactShareInput,
    ExtensionArtifactTransferInput
} from "@portable-devshell/extension/artifact";
import type {
    ExtensionInstanceCapability,
    ExtensionInstanceEventWatch,
    ExtensionInstanceLogQuery
} from "@portable-devshell/extension/instance";

import { createControlExtensionSandboxPointRegistry } from "../../../../../composition/ControlExtensionSandboxPointRegistry.js";
import type {
    ExtensionPointSandboxInvocationContext,
    ExtensionPointValidationContext
} from "../ExtensionPointRegistry.js";
import { ExtensionHostModuleResolver } from "../ExtensionHostModuleResolver.js";
import {
    assertExtensionSandboxMessage,
    deserializeSandboxError,
    serializeSandboxError,
    type ExtensionHostToSandboxMessage,
    type ExtensionSandboxCapabilityOperation,
    type ExtensionSandboxInterfaceOperation,
    type ExtensionSandboxInvokeOperation,
    type ExtensionSandboxProcessDescriptor,
    type ExtensionSandboxReadyDescriptor,
    type ExtensionSandboxRegistrationDescriptor,
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

interface PendingCapabilityRequest {
    onProgress?: (progress: ExtensionJsonValue) => void;
    reject(error: Error): void;
    resolve(value: unknown): void;
}

interface PendingInterfaceRequest {
    invocationId: string;
    reject(error: Error): void;
    resolve(value: ExtensionJsonValue | undefined): void;
}

interface SandboxProcessRuntime {
    closed: Promise<ExtensionProcessExit>;
    messageListeners: Set<(message: ExtensionJsonValue) => void>;
    resolveClosed(exit: ExtensionProcessExit): void;
    stderrListeners: Set<(chunk: string) => void>;
}

interface PendingProcessEvents {
    exit?: ExtensionProcessExit;
    messages: ExtensionJsonValue[];
    stderr: string[];
}

const data = workerData as ExtensionSandboxWorkerData;
const capabilityRequests = new Map<string, PendingCapabilityRequest>();
const interfaceRequests = new Map<string, PendingInterfaceRequest>();
const invocationControllers = new Map<string, AbortController>();
const registrations = new Map<string, {
    binding: unknown;
    descriptor: ExtensionJsonValue;
    id: string;
    pointId: string;
}>();
const sandboxPoints = createControlExtensionSandboxPointRegistry();
const workerSessionClosures = new Map<string, () => void>();
const processes = new Map<string, SandboxProcessRuntime>();
const pendingProcessEvents = new Map<string, PendingProcessEvents>();
const hostModules = new ExtensionHostModuleResolver(import.meta.url, {
    deniedSpecifiers: ["node:vm", "vm"]
});
const hostModulesLease = hostModules.register(data.codeDirectory, data.hostDependencies);
const scheduleFatal = process.nextTick.bind(process);
const signalProcess = process.kill.bind(process);
const getBuiltinModule = process.getBuiltinModule?.bind(process);
let port!: MessagePort;
let postToHost: ((message: ExtensionSandboxToHostMessage) => void) | undefined;
let extensionModule: ExtensionModule | undefined;

void bootstrap().catch((error: unknown) => fatal(error));

async function bootstrap(): Promise<void> {
    const parent = requireParentPort();
    port = await new Promise<MessagePort>((resolve, reject) => {
        parent.once("message", (message: unknown) => {
            if (!isBootstrapMessage(message)) {
                reject(new TypeError("Extension sandbox bootstrap message is invalid."));
                return;
            }
            resolve(message.port);
        });
    });
    parent.close();
    hardenProcessSignals();
    hardenSharedMemory();
    postToHost = port.postMessage.bind(port);
    port.on("message", (message: ExtensionHostToSandboxMessage) => {
        void acceptHostMessage(message).catch((error: unknown) => fatal(error));
    });
    port.start();
    await initialize();
}

async function initialize(): Promise<void> {
    try {
        extensionModule = readExtensionModule(await import(data.entryUrl));
        await extensionModule.activate(createContext());
        send({ descriptor: describeRegistrations(), type: "ready" });
    } catch (error) {
        send({ error: serializeSandboxError(error), type: "initError" });
    }
}

async function acceptHostMessage(message: ExtensionHostToSandboxMessage): Promise<void> {
    switch (message.type) {
        case "healthPing":
            send({ id: message.id, type: "healthPong" });
            return;
        case "invoke":
            await invoke(message.id, message.operation);
            return;
        case "invokeCancel":
            invocationControllers.get(message.id)?.abort(deserializeSandboxError(message.error));
            return;
        case "capabilityResult": {
            const pending = capabilityRequests.get(message.id);
            if (pending === undefined) return;
            capabilityRequests.delete(message.id);
            pending.resolve(message.value);
            return;
        }
        case "capabilityError": {
            const pending = capabilityRequests.get(message.id);
            if (pending === undefined) return;
            capabilityRequests.delete(message.id);
            pending.reject(deserializeSandboxError(message.error));
            return;
        }
        case "capabilityProgress":
            capabilityRequests.get(message.id)?.onProgress?.(message.value);
            return;
        case "interfaceResult": {
            const pending = interfaceRequests.get(message.id);
            if (pending === undefined) return;
            interfaceRequests.delete(message.id);
            pending.resolve(message.value);
            return;
        }
        case "interfaceError": {
            const pending = interfaceRequests.get(message.id);
            if (pending === undefined) return;
            interfaceRequests.delete(message.id);
            pending.reject(deserializeSandboxError(message.error));
            return;
        }
        case "workerSessionClosed": {
            const close = workerSessionClosures.get(message.sessionId);
            if (close === undefined) return;
            workerSessionClosures.delete(message.sessionId);
            close();
            return;
        }
        case "processMessage": {
            const runtime = processes.get(message.processId);
            if (runtime === undefined) {
                pendingProcessEvent(message.processId).messages.push(message.message);
                return;
            }
            for (const listener of runtime.messageListeners) listener(message.message);
            return;
        }
        case "processStderr": {
            const runtime = processes.get(message.processId);
            if (runtime === undefined) {
                pendingProcessEvent(message.processId).stderr.push(message.chunk);
                return;
            }
            for (const listener of runtime.stderrListeners) listener(message.chunk);
            return;
        }
        case "processClosed": {
            const runtime = processes.get(message.processId);
            if (runtime === undefined) {
                pendingProcessEvent(message.processId).exit = message.exit;
                return;
            }
            closeProcessRuntime(message.processId, runtime, message.exit);
            return;
        }
    }
}

async function invoke(id: string, operation: ExtensionSandboxInvokeOperation): Promise<void> {
    if (extensionModule === undefined) {
        send({
            error: serializeSandboxError(new Error("Extension sandbox module is unavailable.")),
            id,
            type: "invokeError"
        });
        return;
    }
    const controller = new AbortController();
    invocationControllers.set(id, controller);
    try {
        let value: unknown;
        switch (operation.kind) {
            case "binding": {
                const binding = requireRegistration(operation.pointId, operation.id);
                value = await sandboxPoints.invokeBinding(
                    operation.pointId,
                    binding,
                    operation.input,
                    controller.signal,
                    pointInvocationContext(operation.id, id, controller.signal)
                );
                break;
            }
            case "deactivate":
                await extensionModule.deactivate?.();
                value = undefined;
                hostModulesLease.release();
                hostModules.dispose();
                break;
        }
        send({ id, type: "invokeResult", ...(value === undefined ? {} : { value }) });
    } catch (error) {
        send({ error: serializeSandboxError(error), id, type: "invokeError" });
    } finally {
        invocationControllers.delete(id);
        rejectInvocationInterfaceRequests(id, new Error("Extension sandbox invocation ended."));
    }
}

function createContext(): ExtensionContext {
    const capabilities: ExtensionCapabilities = Object.freeze({
        ...(data.capabilities.includes("artifacts") ? { artifacts: createArtifactCapability() } : {}),
        ...(data.capabilities.includes("assets") ? { assets: createAssets() } : {}),
        ...(data.capabilities.includes("delegatedWorkers") ? { delegatedWorkers: createWorkerCapability("delegatedWorkers") } : {}),
        ...(data.capabilities.includes("instances") ? { instances: createInstanceCapability() } : {}),
        ...(data.capabilities.includes("processes") ? { processes: createProcessCapability() } : {}),
        ...(data.capabilities.includes("workers") ? { workers: createWorkerCapability("workers") } : {})
    });
    const register: ExtensionContext["register"] = (point, id, binding) => {
        registerBinding(point.id, id, binding);
    };
    return Object.freeze({
        capabilities,
        generation: data.context.generation,
        id: data.context.id,
        logger: createLogger(),
        paths: Object.freeze({ ...data.context.paths }),
        register,
        version: data.context.version,
    });
}

function createLogger(): ExtensionLogger {
    const write = (
        level: "debug" | "error" | "info" | "warn",
        message: string,
        details?: ExtensionJsonValue
    ) => {
        send({
            ...(details === undefined ? {} : { details }),
            level,
            message,
            type: "log"
        });
    };
    const logger: ExtensionLogger = {
        debug: (message, details) => write("debug", message, details),
        error: (message, details) => write("error", message, details),
        info: (message, details) => write("info", message, details),
        warn: (message, details) => write("warn", message, details)
    };
    return Object.freeze(logger);
}

function createArtifactCapability(): ExtensionArtifactCapability {
    return Object.freeze({
        cancelTransfer: async (transferId: string) => await requestCapability(
            "artifacts.cancelTransfer",
            { transferId }
        ) as Awaited<ReturnType<ExtensionArtifactCapability["cancelTransfer"]>>,
        createShare: async (input: ExtensionArtifactShareInput) => await requestCapability(
            "artifacts.createShare",
            { ...input, source: { ...input.source } } satisfies SandboxArtifactShareInput
        ) as Awaited<ReturnType<ExtensionArtifactCapability["createShare"]>>,
        getTransfer: async (transferId: string) => await requestCapability(
            "artifacts.getTransfer",
            { transferId }
        ) as Awaited<ReturnType<ExtensionArtifactCapability["getTransfer"]>>,
        listShares: async () => await requestCapability(
            "artifacts.listShares"
        ) as Awaited<ReturnType<ExtensionArtifactCapability["listShares"]>>,
        listTransfers: async () => await requestCapability(
            "artifacts.listTransfers"
        ) as Awaited<ReturnType<ExtensionArtifactCapability["listTransfers"]>>,
        revokeShare: async (shareId: string) => await requestCapability(
            "artifacts.revokeShare",
            { shareId }
        ) as Awaited<ReturnType<ExtensionArtifactCapability["revokeShare"]>>,
        startTransfer: async (input: ExtensionArtifactTransferInput) => await requestCapability(
            "artifacts.startTransfer",
            {
                ...input,
                source: { ...input.source },
                target: { ...input.target }
            } satisfies SandboxArtifactTransferInput
        ) as Awaited<ReturnType<ExtensionArtifactCapability["startTransfer"]>>,
        waitForTransfer: async (transferId: string) => await requestCapability(
            "artifacts.waitForTransfer",
            { transferId }
        ) as Awaited<ReturnType<ExtensionArtifactCapability["waitForTransfer"]>>
    });
}

function createInstanceCapability(): ExtensionInstanceCapability {
    const nameInput = (name: string): SandboxInstanceNameInput => ({ name });
    return Object.freeze({
        create: async (draft: ExtensionJsonValue) => await requestCapability(
            "instances.create",
            { draft } satisfies SandboxInstanceCreateInput
        ) as Awaited<ReturnType<ExtensionInstanceCapability["create"]>>,
        createSchema: async () => await requestCapability(
            "instances.createSchema"
        ) as Awaited<ReturnType<ExtensionInstanceCapability["createSchema"]>>,
        delete: async (name: string) => {
            await requestCapability("instances.delete", nameInput(name));
        },
        disable: async (name: string) => {
            await requestCapability("instances.disable", nameInput(name));
        },
        enable: async (name: string) => {
            await requestCapability("instances.enable", nameInput(name));
        },
        list: async () => await requestCapability(
            "instances.list"
        ) as Awaited<ReturnType<ExtensionInstanceCapability["list"]>>,
        readLogs: async (name: string, query?: ExtensionInstanceLogQuery) => await requestCapability(
            "instances.readLogs",
            { name, ...(query === undefined ? {} : { query: { ...query } }) } satisfies SandboxInstanceReadLogsInput
        ) as Awaited<ReturnType<ExtensionInstanceCapability["readLogs"]>>,
        refresh: async (name: string) => await requestCapability(
            "instances.refresh",
            nameInput(name)
        ) as Awaited<ReturnType<ExtensionInstanceCapability["refresh"]>>,
        snapshot: async (name: string) => await requestCapability(
            "instances.snapshot",
            nameInput(name)
        ) as Awaited<ReturnType<ExtensionInstanceCapability["snapshot"]>>,
        start: async (name: string) => await requestCapability(
            "instances.start",
            nameInput(name)
        ) as Awaited<ReturnType<ExtensionInstanceCapability["start"]>>,
        stop: async (name: string) => await requestCapability(
            "instances.stop",
            nameInput(name)
        ) as Awaited<ReturnType<ExtensionInstanceCapability["stop"]>>,
        validateCreate: async (draft: ExtensionJsonValue) => await requestCapability(
            "instances.validateCreate",
            { draft } satisfies SandboxInstanceCreateInput
        ) as Awaited<ReturnType<ExtensionInstanceCapability["validateCreate"]>>,
        watchEvents: async (name: string, watch: ExtensionInstanceEventWatch) => {
            const deliveryAbort = new AbortController();
            const signal = AbortSignal.any([watch.signal, deliveryAbort.signal]);
            let delivery = Promise.resolve();
            let deliveryFailure: Error | undefined;
            try {
                await requestCapability(
                    "instances.watchEvents",
                    {
                        ...(watch.eventTypes === undefined ? {} : { eventTypes: [...watch.eventTypes] }),
                        fromSeq: watch.fromSeq,
                        name
                    } satisfies SandboxInstanceWatchInput,
                    {
                        onProgress: (progress) => {
                            delivery = delivery.then(async () => {
                                await deliverInstanceWatchProgress(watch, progress);
                            }).catch((error: unknown) => {
                                deliveryFailure ??= error instanceof Error ? error : new Error(String(error));
                                deliveryAbort.abort(deliveryFailure);
                            });
                        },
                        signal
                    }
                );
            } catch (error) {
                await delivery;
                if (deliveryFailure !== undefined) throw deliveryFailure;
                throw error;
            }
            await delivery;
            if (deliveryFailure !== undefined) throw deliveryFailure;
        }
    });
}

function createAssets(): ExtensionAssetCapability {
    return Object.freeze({
        installBundle: async (sourcePath: string) => await requestCapability(
            "assets.installBundle",
            { sourcePath }
        ) as ExtensionAssetBundle,
        installDirectory: async (sourcePath: string) => await requestCapability(
            "assets.installDirectory",
            { sourcePath }
        ) as ExtensionAssetBundle,
        listBundles: async () => await requestCapability("assets.listBundles") as readonly ExtensionAssetBundle[],
        projectBundle: async (input: ExtensionAssetProjectionInput) => await requestCapability(
            "assets.projectBundle",
            {
                generation: input.generation,
                ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
                target: { ...input.target }
            } satisfies SandboxAssetProjectInput,
            { signal: input.signal }
        ) as ExtensionAssetProjectionResult,
        removeBundle: async (generation: string) => {
            await requestCapability("assets.removeBundle", { generation });
        },
        resolveBundle: async (generation: string) => await requestCapability(
            "assets.resolveBundle",
            { generation }
        ) as ExtensionAssetBundle | undefined
    });
}

function createProcessCapability(): ExtensionProcessCapability {
    return Object.freeze({
        start: async (input: ExtensionProcessStartInput): Promise<ExtensionManagedProcess> => {
            const request: SandboxProcessStartInput = {
                command: input.command,
                ...(input.args === undefined ? {} : { args: [...input.args] }),
                ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
                ...(input.environment === undefined ? {} : { environment: { ...input.environment } }),
                ...(input.messages === undefined ? {} : { messages: input.messages })
            };
            const opened = await requestCapability(
                "processes.start",
                request
            ) as ExtensionSandboxProcessDescriptor;
            let resolveClosed!: (exit: ExtensionProcessExit) => void;
            const closed = new Promise<ExtensionProcessExit>((resolve) => { resolveClosed = resolve; });
            const runtime: SandboxProcessRuntime = {
                closed,
                messageListeners: new Set(),
                resolveClosed,
                stderrListeners: new Set()
            };
            processes.set(opened.processId, runtime);
            const pending = pendingProcessEvents.get(opened.processId);
            if (pending !== undefined) pendingProcessEvents.delete(opened.processId);
            const managed: ExtensionManagedProcess = {
                closed,
                onMessage: (listener) => {
                    runtime.messageListeners.add(listener);
                    return () => runtime.messageListeners.delete(listener);
                },
                onStderr: (listener) => {
                    runtime.stderrListeners.add(listener);
                    return () => runtime.stderrListeners.delete(listener);
                },
                send: async (message) => {
                    await requestCapability(
                        "processes.send",
                        { message, processId: opened.processId } satisfies SandboxProcessSendInput
                    );
                },
                terminate: async (signal) => {
                    if (!processes.has(opened.processId)) return;
                    await requestCapability(
                        "processes.terminate",
                        {
                            processId: opened.processId,
                            ...(signal === undefined ? {} : { signal })
                        } satisfies SandboxProcessTerminateInput
                    );
                }
            };
            if (pending?.exit !== undefined) {
                closeProcessRuntime(opened.processId, runtime, pending.exit);
            } else if (pending !== undefined) {
                queueMicrotask(() => {
                    if (processes.get(opened.processId) !== runtime) return;
                    for (const message of pending.messages) {
                        for (const listener of runtime.messageListeners) listener(message);
                    }
                    for (const chunk of pending.stderr) {
                        for (const listener of runtime.stderrListeners) listener(chunk);
                    }
                });
            }
            return Object.freeze(managed);
        }
    });
}

function createWorkerCapability(capability: "delegatedWorkers" | "workers"): ExtensionWorkerCapability {
    return Object.freeze({
        openSession: async (input: SandboxWorkerOpenInput): Promise<ExtensionWorkerSession> => {
            const opened = await requestCapability(
                `${capability}.openSession`,
                { ...input }
            ) as ExtensionSandboxWorkerSessionDescriptor;
            const tools = opened.tools.map((tool) => Object.freeze({ ...tool }));
            let closed = false;
            let resolveClosed!: () => void;
            const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
            workerSessionClosures.set(opened.sessionId, resolveClosed);
            const session: ExtensionWorkerSession = {
                closed: closedPromise,
                environment: Object.freeze({
                    ...opened.environment,
                    platform: Object.freeze({ ...opened.environment.platform })
                }),
                instance: opened.instance,
                workspace: opened.workspace,
                callTool: async (toolName, toolInput, options = {}) => await requestCapability(
                    `${capability}.callTool`,
                    {
                        input: toolInput,
                        ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
                        sessionId: opened.sessionId,
                        toolName
                    } satisfies SandboxWorkerCallInput,
                    { onProgress: options.onProgress, signal: options.signal }
                ) as ExtensionJsonValue,
                close: async () => {
                    if (closed) return;
                    closed = true;
                    try {
                        await requestCapability(
                            `${capability}.closeSession`,
                            { sessionId: opened.sessionId } satisfies SandboxWorkerCloseInput
                        );
                    } finally {
                        workerSessionClosures.delete(opened.sessionId);
                        resolveClosed();
                    }
                },
                listTools: () => tools.map((tool) => ({ ...tool }))
            };
            return Object.freeze(session);
        }
    });
}

function pendingProcessEvent(processId: string): PendingProcessEvents {
    let pending = pendingProcessEvents.get(processId);
    if (pending === undefined) {
        pending = { messages: [], stderr: [] };
        pendingProcessEvents.set(processId, pending);
    }
    return pending;
}

function closeProcessRuntime(
    processId: string,
    runtime: SandboxProcessRuntime,
    exit: ExtensionProcessExit
): void {
    if (processes.get(processId) !== runtime) return;
    processes.delete(processId);
    runtime.messageListeners.clear();
    runtime.stderrListeners.clear();
    runtime.resolveClosed(Object.freeze({ ...exit }));
}

async function deliverInstanceWatchProgress(
    watch: ExtensionInstanceEventWatch,
    progress: ExtensionJsonValue
): Promise<void> {
    if (!isRecord(progress)) throw new TypeError("Extension sandbox Instance watch progress must be an object.");
    if (progress.kind === "event") {
        const event = progress.event;
        if (
            !isRecord(event)
            || typeof event.at !== "string"
            || typeof event.instanceName !== "string"
            || !Number.isSafeInteger(event.seq)
            || typeof event.type !== "string"
        ) {
            throw new TypeError("Extension sandbox Instance watch event is invalid.");
        }
        await watch.onEvent({
            at: event.at,
            ...(event.data === undefined ? {} : { data: event.data as ExtensionJsonValue }),
            instanceName: event.instanceName,
            seq: event.seq as number,
            type: event.type
        });
        return;
    }
    if (progress.kind === "gap") {
        const gap = progress.gap;
        if (
            !isRecord(gap)
            || !Number.isSafeInteger(gap.lastSeq)
            || !Number.isSafeInteger(gap.nextSeq)
        ) {
            throw new TypeError("Extension sandbox Instance watch gap is invalid.");
        }
        await watch.onGap?.({ lastSeq: gap.lastSeq as number, nextSeq: gap.nextSeq as number });
        return;
    }
    throw new TypeError("Extension sandbox Instance watch progress kind is invalid.");
}

async function requestCapability(
    operation: ExtensionSandboxCapabilityOperation,
    input?: unknown,
    options: {
        onProgress?: (progress: ExtensionJsonValue) => void;
        signal?: AbortSignal;
    } = {}
): Promise<unknown> {
    options.signal?.throwIfAborted();
    const id = randomUUID();
    return await new Promise<unknown>((resolve, reject) => {
        const cleanup = () => options.signal?.removeEventListener("abort", abort);
        const abort = () => {
            if (!capabilityRequests.delete(id)) return;
            cleanup();
            const error = abortError(options.signal);
            send({ error: serializeSandboxError(error), id, type: "capabilityCancel" });
            reject(error);
        };
        capabilityRequests.set(id, {
            ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
            reject: (error) => {
                cleanup();
                reject(error);
            },
            resolve: (value) => {
                cleanup();
                resolve(value);
            }
        });
        options.signal?.addEventListener("abort", abort, { once: true });
        try {
            send({
                id,
                ...(input === undefined ? {} : { input }),
                operation,
                type: "capabilityRequest"
            });
        } catch (error) {
            capabilityRequests.delete(id);
            options.signal?.removeEventListener("abort", abort);
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

async function requestInterface(
    invocationId: string,
    operation: ExtensionSandboxInterfaceOperation,
    input: ExtensionJsonValue | undefined,
    signal: AbortSignal
): Promise<ExtensionJsonValue | undefined> {
    signal.throwIfAborted();
    const id = randomUUID();
    return await new Promise<ExtensionJsonValue | undefined>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener("abort", abort);
        const abort = () => {
            if (!interfaceRequests.delete(id)) return;
            cleanup();
            reject(abortError(signal));
        };
        interfaceRequests.set(id, {
            invocationId,
            reject: (error) => {
                cleanup();
                reject(error);
            },
            resolve: (value) => {
                cleanup();
                resolve(value);
            }
        });
        signal.addEventListener("abort", abort, { once: true });
        try {
            send({
                id,
                ...(input === undefined ? {} : { input }),
                invocationId,
                operation,
                type: "interfaceRequest"
            });
        } catch (error) {
            interfaceRequests.delete(id);
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
        }
    });
}

function rejectInvocationInterfaceRequests(invocationId: string, error: Error): void {
    for (const [id, pending] of interfaceRequests) {
        if (pending.invocationId !== invocationId) continue;
        interfaceRequests.delete(id);
        pending.reject(error);
    }
}

function registerBinding(pointId: string, id: string, binding: unknown): void {
    if (!/^[a-z][a-z0-9-]*$/u.test(id)) {
        throw new TypeError(`Extension registration id is invalid: ${id}.`);
    }
    const key = registrationKey(pointId, id);
    if (registrations.has(key)) {
        throw new TypeError(`Extension ${data.context.id} registered ${pointId}/${id} more than once.`);
    }
    const descriptor = sandboxPoints.describeBinding(pointId, binding, pointContext(id));
    registrations.set(key, { binding, descriptor, id, pointId });
}

function describeRegistrations(): ExtensionSandboxReadyDescriptor {
    const descriptors: ExtensionSandboxRegistrationDescriptor[] = [];
    for (const registration of registrations.values()) {
        descriptors.push(Object.freeze({
            descriptor: registration.descriptor,
            id: registration.id,
            pointId: registration.pointId
        }));
    }
    return Object.freeze({ registrations: Object.freeze(descriptors) });
}

function pointContext(id: string): ExtensionPointValidationContext {
    return Object.freeze({
        codeDirectory: data.codeDirectory,
        extensionId: data.context.id,
        id
    });
}

function pointInvocationContext(
    id: string,
    invocationId: string,
    signal: AbortSignal
): ExtensionPointSandboxInvocationContext {
    return Object.freeze({
        ...pointContext(id),
        requestInterface: async (operation: string, input?: ExtensionJsonValue) => await requestInterface(
            invocationId,
            operation as ExtensionSandboxInterfaceOperation,
            input,
            signal
        )
    });
}

function requireRegistration(pointId: string, id: string): unknown {
    const binding = registrations.get(registrationKey(pointId, id))?.binding;
    if (binding !== undefined) return binding;
    throw new Error(`Extension registration is unavailable: ${pointId}/${id}.`);
}

function registrationKey(pointId: string, id: string): string {
    return `${pointId}\u0000${id}`;
}

function readExtensionModule(value: unknown): ExtensionModule {
    if (!isRecord(value) || typeof value.activate !== "function") {
        throw new TypeError(`Extension ${data.context.id} entry must export an activate(context) function.`);
    }
    if (value.deactivate !== undefined && typeof value.deactivate !== "function") {
        throw new TypeError(`Extension ${data.context.id} deactivate export must be a function.`);
    }
    return {
        activate: value.activate as ExtensionModule["activate"],
        ...(value.deactivate === undefined ? {} : { deactivate: value.deactivate as NonNullable<ExtensionModule["deactivate"]> })
    };
}

function send(message: ExtensionSandboxToHostMessage): void {
    assertExtensionSandboxMessage(message, "Extension sandbox outbound message");
    if (postToHost === undefined) throw new Error("Extension sandbox private channel is unavailable.");
    postToHost(message);
}

function fatal(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (postToHost !== undefined) {
        try {
            send({ error: serializeSandboxError(failure), type: "runtimeFault" });
        } catch {
            // Worker error/exit remains the bootstrap fallback when the private channel is unavailable.
        }
    }
    scheduleFatal(() => { throw failure; });
}

function hardenProcessSignals(): void {
    const sandboxKill = (pid: number, signal?: NodeJS.Signals | number): true => {
        if (signal !== 0 && (pid === process.pid || pid <= 0)) {
            throw new Error("Extension sandbox cannot signal the Control process or its process group.");
        }
        return signal === undefined
            ? signalProcess(pid)
            : signalProcess(pid, signal);
    };
    Object.defineProperty(process, "kill", {
        configurable: false,
        enumerable: true,
        value: sandboxKill,
        writable: false
    });
    syncBuiltinESMExports();
}

function hardenSharedMemory(): void {
    Object.defineProperty(globalThis, "SharedArrayBuffer", {
        configurable: false,
        enumerable: false,
        value: undefined,
        writable: false
    });
    const memory = WebAssembly.Memory;
    const guardedMemory: typeof WebAssembly.Memory = new Proxy(memory, {
        construct(target, argumentsList, newTarget): WebAssembly.Memory {
            const descriptor = argumentsList[0] as WebAssembly.MemoryDescriptor | undefined;
            if (descriptor?.shared === true) {
                throw new Error("Extension sandbox does not allow shared WebAssembly memory.");
            }
            return Reflect.construct(
                target,
                argumentsList,
                newTarget === guardedMemory ? target : newTarget
            ) as WebAssembly.Memory;
        }
    });
    Object.defineProperty(WebAssembly, "Memory", {
        configurable: false,
        enumerable: true,
        value: guardedMemory,
        writable: false
    });
    if (getBuiltinModule !== undefined) {
        Object.defineProperty(process, "getBuiltinModule", {
            configurable: false,
            enumerable: true,
            value: (id: string) => {
                if (id === "vm" || id === "node:vm") {
                    throw new Error(`Extension sandbox does not allow builtin module ${id}.`);
                }
                return getBuiltinModule(id);
            },
            writable: false
        });
        syncBuiltinESMExports();
    }
}

function requireParentPort(): NonNullable<typeof parentPort> {
    if (parentPort === null) {
        throw new Error("Extension sandbox worker requires a parent MessagePort.");
    }
    return parentPort;
}

function isBootstrapMessage(value: unknown): value is {
    port: MessagePort;
    type: "extensionSandboxBootstrap";
} {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as { port?: unknown; type?: unknown };
    return candidate.type === "extensionSandboxBootstrap"
        && typeof candidate.port === "object"
        && candidate.port !== null
        && "postMessage" in candidate.port
        && typeof (candidate.port as { postMessage?: unknown }).postMessage === "function";
}

function abortError(signal: AbortSignal | undefined): Error {
    return signal?.reason instanceof Error
        ? signal.reason
        : new Error("Extension sandbox capability call was aborted.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
