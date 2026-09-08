import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";

import type {
    ExtensionActivation,
    ExtensionAssetBundle,
    ExtensionAssetCapability,
    ExtensionAssetProjectionInput,
    ExtensionAssetTransferResult,
    ExtensionContext,
    ExtensionInvocationContext,
    ExtensionJsonValue,
    ExtensionLogger,
    ExtensionModule,
    ExtensionWorkerCapability,
    ExtensionWorkerSession
} from "@portable-devshell/extension";

import { ExtensionHostModuleResolver } from "../ExtensionHostModuleResolver.js";
import {
    deserializeSandboxError,
    serializeSandboxError,
    type ExtensionHostToSandboxMessage,
    type ExtensionSandboxActivationDescriptor,
    type ExtensionSandboxCapabilityOperation,
    type ExtensionSandboxInvokeOperation,
    type ExtensionSandboxToHostMessage,
    type ExtensionSandboxWorkerData,
    type ExtensionSandboxWorkerSessionDescriptor,
    type SandboxAssetProjectInput,
    type SandboxWorkerCallInput,
    type SandboxWorkerCloseInput,
    type SandboxWorkerOpenInput
} from "./ExtensionSandboxProtocol.js";

interface PendingCapabilityRequest {
    onProgress?: (progress: ExtensionJsonValue) => void;
    reject(error: Error): void;
    resolve(value: unknown): void;
}

const port = requireParentPort();
const data = workerData as ExtensionSandboxWorkerData;
const capabilityRequests = new Map<string, PendingCapabilityRequest>();
const invocationControllers = new Map<string, AbortController>();
const hostModules = new ExtensionHostModuleResolver(import.meta.url);
const hostModulesLease = hostModules.register(data.codeDirectory);
let activation: ExtensionActivation | undefined;

port.on("message", (message: ExtensionHostToSandboxMessage) => {
    void acceptHostMessage(message);
});

void initialize();

async function initialize(): Promise<void> {
    try {
        const module = readExtensionModule(await import(data.entryUrl));
        activation = await module.activate(createContext());
        send({ activation: describeActivation(activation), type: "ready" });
    } catch (error) {
        send({ error: serializeSandboxError(error), type: "initError" });
    }
}

async function acceptHostMessage(message: ExtensionHostToSandboxMessage): Promise<void> {
    switch (message.type) {
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
    }
}

async function invoke(id: string, operation: ExtensionSandboxInvokeOperation): Promise<void> {
    if (activation === undefined) {
        send({
            error: serializeSandboxError(new Error("Extension sandbox activation is unavailable.")),
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
            case "command": {
                if (activation.command === undefined) throw new Error("Extension command handler is unavailable.");
                value = await activation.command(
                    operation.argv,
                    createInvocationContext(operation.context, controller.signal)
                );
                break;
            }
            case "rpc": {
                const handler = activation.rpc?.[operation.operation];
                if (handler === undefined) throw new Error(`Extension RPC handler ${operation.operation} is unavailable.`);
                value = await handler(
                    operation.input,
                    createInvocationContext(operation.context, controller.signal)
                );
                break;
            }
            case "instanceRetire":
                await activation.lifecycle?.onInstanceRetire?.(operation.event);
                value = undefined;
                break;
            case "resolveUpstream": {
                if (activation.web?.kind !== "proxy") {
                    throw new Error("Extension Web proxy contribution is unavailable.");
                }
                const upstream = await activation.web.resolveUpstream();
                if (upstream !== undefined && !(upstream instanceof URL)) {
                    throw new TypeError("Extension Web proxy resolveUpstream() must return a URL or undefined.");
                }
                value = upstream?.href;
                break;
            }
            case "dispose":
                await activation.dispose();
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
    return Object.freeze({
        assets: createAssets(),
        generation: data.context.generation,
        id: data.context.id,
        logger: createLogger(),
        paths: Object.freeze({ ...data.context.paths }),
        version: data.context.version,
        worker: createWorkerCapability()
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

function createWorkerCapability(): ExtensionWorkerCapability {
    return Object.freeze({
        openSession: async (input: SandboxWorkerOpenInput): Promise<ExtensionWorkerSession> => {
            const opened = await requestCapability(
                "worker.openSession",
                { ...input }
            ) as ExtensionSandboxWorkerSessionDescriptor;
            const tools = opened.tools.map((tool) => Object.freeze({ ...tool }));
            let closed = false;
            const session: ExtensionWorkerSession = {
                environment: Object.freeze({
                    ...opened.environment,
                    platform: Object.freeze({ ...opened.environment.platform })
                }),
                instance: opened.instance,
                workspace: opened.workspace,
                callTool: async (toolName, toolInput, options = {}) => await requestCapability(
                    "worker.callTool",
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
                    await requestCapability(
                        "worker.closeSession",
                        { sessionId: opened.sessionId } satisfies SandboxWorkerCloseInput
                    );
                },
                listTools: () => tools.map((tool) => ({ ...tool }))
            };
            return Object.freeze(session);
        }
    });
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

function createInvocationContext(
    value: {
        localOwner: boolean;
        requestId: string;
        workingDirectory?: string;
    },
    signal: AbortSignal
): ExtensionInvocationContext {
    return Object.freeze({
        localOwner: value.localOwner,
        requestId: value.requestId,
        signal,
        ...(value.workingDirectory === undefined ? {} : { workingDirectory: value.workingDirectory })
    });
}

function describeActivation(value: unknown): ExtensionSandboxActivationDescriptor {
    if (!isRecord(value)) throw new TypeError(`Extension ${data.context.id} activation must be an object.`);
    const allowed = new Set(["command", "dispose", "lifecycle", "rpc", "web"]);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown !== undefined) {
        throw new TypeError(`Extension ${data.context.id} activation has unknown field ${unknown}.`);
    }
    if (typeof value.dispose !== "function") {
        throw new TypeError(`Extension ${data.context.id} activation must provide dispose().`);
    }
    const descriptor: ExtensionSandboxActivationDescriptor = {};
    if (value.command !== undefined) {
        if (typeof value.command !== "function") {
            throw new TypeError(`Extension ${data.context.id} command must be a function.`);
        }
        descriptor.command = true;
    }
    if (value.rpc !== undefined) {
        if (!isRecord(value.rpc)) throw new TypeError(`Extension ${data.context.id} rpc must be an object.`);
        const operations: string[] = [];
        for (const [operation, handler] of Object.entries(value.rpc)) {
            if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(operation)) {
                throw new TypeError(`Extension ${data.context.id} RPC operation is invalid: ${operation}.`);
            }
            if (typeof handler !== "function") {
                throw new TypeError(`Extension ${data.context.id} RPC operation ${operation} must be a function.`);
            }
            operations.push(operation);
        }
        descriptor.rpc = Object.freeze(operations.sort());
    }
    if (value.lifecycle !== undefined) {
        if (!isRecord(value.lifecycle)) {
            throw new TypeError(`Extension ${data.context.id} lifecycle must be an object.`);
        }
        const unknownLifecycle = Object.keys(value.lifecycle).find((key) => key !== "onInstanceRetire");
        if (unknownLifecycle !== undefined) {
            throw new TypeError(`Extension ${data.context.id} lifecycle has unknown field ${unknownLifecycle}.`);
        }
        if (
            value.lifecycle.onInstanceRetire !== undefined
            && typeof value.lifecycle.onInstanceRetire !== "function"
        ) {
            throw new TypeError(`Extension ${data.context.id} onInstanceRetire must be a function.`);
        }
        if (value.lifecycle.onInstanceRetire !== undefined) {
            descriptor.lifecycle = Object.freeze({ onInstanceRetire: true });
        }
    }
    if (value.web !== undefined) descriptor.web = describeWeb(value.web);
    return Object.freeze(descriptor);
}

function describeWeb(value: unknown): NonNullable<ExtensionSandboxActivationDescriptor["web"]> {
    if (!isRecord(value) || (value.kind !== "static" && value.kind !== "proxy")) {
        throw new TypeError(`Extension ${data.context.id} web contribution must be static or proxy.`);
    }
    if (value.kind === "static") {
        if (Object.keys(value).some((key) => key !== "directory" && key !== "kind")) {
            throw new TypeError(`Extension ${data.context.id} static web contribution has unknown fields.`);
        }
        if (typeof value.directory !== "string" || value.directory.length === 0) {
            throw new TypeError(`Extension ${data.context.id} static web directory must be a non-empty relative path.`);
        }
        return Object.freeze({ directory: value.directory, kind: "static" });
    }
    if (Object.keys(value).some((key) => key !== "kind" && key !== "resolveUpstream")) {
        throw new TypeError(`Extension ${data.context.id} proxy web contribution has unknown fields.`);
    }
    if (typeof value.resolveUpstream !== "function") {
        throw new TypeError(`Extension ${data.context.id} proxy web contribution must provide resolveUpstream().`);
    }
    return Object.freeze({ kind: "proxy" });
}

function readExtensionModule(value: unknown): ExtensionModule {
    if (!isRecord(value) || typeof value.activate !== "function") {
        throw new TypeError(`Extension ${data.context.id} entry must export an activate(context) function.`);
    }
    return { activate: value.activate as ExtensionModule["activate"] };
}

function send(message: ExtensionSandboxToHostMessage): void {
    port.postMessage(message);
}

function requireParentPort(): NonNullable<typeof parentPort> {
    if (parentPort === null) {
        throw new Error("Extension sandbox worker requires a parent MessagePort.");
    }
    return parentPort;
}

function abortError(signal: AbortSignal | undefined): Error {
    return signal?.reason instanceof Error
        ? signal.reason
        : new Error("Extension sandbox capability call was aborted.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
