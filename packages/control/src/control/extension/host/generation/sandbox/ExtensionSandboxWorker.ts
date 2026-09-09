import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import type {
    ExtensionAssetBundle,
    ExtensionAssetCapability,
    ExtensionAssetProjectionInput,
    ExtensionAssetTransferResult,
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

import { createControlExtensionSandboxPointRegistry } from "../../../../../composition/ControlExtensionSandboxPointRegistry.js";
import type { ExtensionPointValidationContext } from "../ExtensionPointRegistry.js";
import { ExtensionHostModuleResolver } from "../ExtensionHostModuleResolver.js";
import {
    assertExtensionSandboxMessage,
    deserializeSandboxError,
    serializeSandboxError,
    type ExtensionHostToSandboxMessage,
    type ExtensionSandboxCapabilityOperation,
    type ExtensionSandboxInvokeOperation,
    type ExtensionSandboxProcessDescriptor,
    type ExtensionSandboxReadyDescriptor,
    type ExtensionSandboxRegistrationDescriptor,
    type ExtensionSandboxToHostMessage,
    type ExtensionSandboxWorkerData,
    type ExtensionSandboxWorkerSessionDescriptor,
    type SandboxAssetProjectInput,
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
                    pointContext(operation.id)
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
    }
}

function createContext(): ExtensionContext {
    const capabilities: ExtensionCapabilities = Object.freeze({
        ...(data.capabilities.includes("assets") ? { assets: createAssets() } : {}),
        ...(data.capabilities.includes("processes") ? { processes: createProcessCapability() } : {}),
        ...(data.capabilities.includes("workers") ? { workers: createWorkerCapability() } : {})
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
        ) as ExtensionAssetTransferResult,
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

function createWorkerCapability(): ExtensionWorkerCapability {
    return Object.freeze({
        openSession: async (input: SandboxWorkerOpenInput): Promise<ExtensionWorkerSession> => {
            const opened = await requestCapability(
                "workers.openSession",
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
                    "workers.callTool",
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
                            "workers.closeSession",
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
    let guardedMemory!: typeof WebAssembly.Memory;
    guardedMemory = new Proxy(memory, {
        construct(target, argumentsList, newTarget) {
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
