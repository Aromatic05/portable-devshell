import { randomUUID } from "node:crypto";

import {
    createProcessTransport,
    type CodeDescribeRequest,
    type CodeDescribeResult,
    type CodeEvalRequest,
    type CodeEvalResult,
    type Endpoint,
    type JsonValue,
} from "@portable-devshell/shared";

import type { ContextApi } from "../context/Api.js";
import type { InstanceRegistry } from "../instance/Api.js";
import type {
    CodeEvalOptions,
    CodeExecutionPrincipal,
    CodeMethodInvocationContext,
    CodeObjectDescriptor,
    CodeObjectProvider,
    CodeRuntime,
} from "./Api.js";
import { buildBootstrapCatalog } from "./model/Bridge.js";
import {
    QuickJsEngine,
    type QuickJsEngineLimits,
    type QuickJsHostBridge,
} from "./runtime/Engine.js";
import { emitObjectDts, emitOverviewDts } from "./schema/DtsEmitter.js";
import { validateMethodInput } from "./schema/Validate.js";

export interface CodeServiceOptions {
    readonly contexts?: ContextApi;
    readonly endpoint?: Endpoint;
    readonly instances?: InstanceRegistry;
    readonly limits?: Partial<QuickJsEngineLimits>;
    readonly providers?: readonly CodeObjectProvider[];
}

export class CodeService implements CodeRuntime {
    readonly #contexts?: ContextApi;
    readonly #endpoint?: Endpoint;
    readonly #engine: QuickJsEngine;
    readonly #instances?: InstanceRegistry;
    readonly #providers = new Set<CodeObjectProvider>();

    constructor(options: CodeServiceOptions = {}) {
        this.#contexts = options.contexts;
        this.#endpoint = options.endpoint;
        this.#instances = options.instances;
        this.#engine = new QuickJsEngine(options.limits);
        for (const provider of options.providers ?? []) {
            this.#providers.add(provider);
        }
    }

    registerProvider(provider: CodeObjectProvider): () => void {
        this.#providers.add(provider);
        return () => {
            this.#providers.delete(provider);
        };
    }

    describe(
        request: CodeDescribeRequest,
        principal: CodeExecutionPrincipal,
    ): CodeDescribeResult {
        const instance = request.instance ?? principal.instance;
        const objects = this.#collectDescriptors(principal, instance);
        const namespaces = objects.map((obj) => obj.id);
        const dts = this.#renderDts(objects, request.target, request.filter);
        return { dts, namespaces };
    }

    async eval(
        request: CodeEvalRequest,
        options: CodeEvalOptions,
    ): Promise<CodeEvalResult> {
        const callId = `code_${randomUUID()}`;
        const principal = options.principal;
        const activeInstance =
            principal.audience === "model"
                ? principal.instance
                : (request.instance ?? principal.instance);
        const activeWorkspace =
            principal.audience === "model"
                ? principal.workspace
                : (request.workspace ?? principal.workspace);

        const descriptors = this.#collectDescriptors(principal, activeInstance);
        const openedHandles: Array<{
            handleId: string;
            objectId: string;
            provider: CodeObjectProvider;
        }> = [];

        const resolveTargetInstance = async (
            requested: string | undefined,
        ): Promise<string | undefined> => {
            if (requested === undefined) return activeInstance;
            if (principal.audience === "native") return requested;
            if (requested === principal.instance) return requested;
            if (principal.ctxId === undefined || this.#contexts === undefined) {
                throw new Error(
                    "Model Code Mode cannot resolve remote instances without an active Context.",
                );
            }
            return await this.#contexts.registry.resolveRemoteInstanceHandle(
                principal.ctxId,
                requested,
            );
        };

        const bridge: QuickJsHostBridge = {
            catalog: buildBootstrapCatalog({
                ...(activeInstance === undefined ? {} : { activeInstance }),
                ...(activeWorkspace === undefined ? {} : { activeWorkspace }),
                audience: principal.audience,
                objects: descriptors,
            }),
            help: (target, filter) =>
                this.#renderDts(
                    this.#collectDescriptors(principal, activeInstance),
                    target,
                    filter,
                ),
            invoke: async (call) => {
                const resolvedInstance = await resolveTargetInstance(call.instance);
                const resolvedObjects = this.#collectDescriptors(
                    principal,
                    resolvedInstance,
                );
                const descriptor = resolvedObjects.find((obj) => obj.id === call.objectId);
                if (descriptor === undefined) {
                    throw new TypeError(
                        `Namespace devshell.${call.objectId} is not available in this session.`,
                    );
                }
                const method = descriptor.methods.find((m) => m.name === call.method);
                if (method === undefined) {
                    throw new TypeError(
                        `Unknown method devshell.${call.objectId}.${call.method}.`,
                    );
                }
                const validatedInput = validateMethodInput(
                    call.objectId,
                    method,
                    call.input,
                );
                const provider = this.#findProvider(
                    call.objectId,
                    principal,
                    resolvedInstance,
                );
                const invocationContext = buildInvocationContext({
                    instance: resolvedInstance,
                    parentCallId: callId,
                    principal,
                    signal: call.signal,
                    workingDirectory:
                        request.workingDirectory ?? principal.workingDirectory,
                    workspace: call.workspace ?? activeWorkspace,
                });
                return await provider.invoke(
                    call.objectId,
                    call.method,
                    validatedInput,
                    invocationContext,
                );
            },
            openHandle: async (call) => {
                const resolvedInstance = await resolveTargetInstance(call.instance);
                const provider = this.#findProvider(
                    call.objectId,
                    principal,
                    resolvedInstance,
                );
                if (provider.openHandle === undefined) {
                    throw new TypeError(
                        `devshell.${call.objectId} does not support opening handles.`,
                    );
                }
                const invocationContext = buildInvocationContext({
                    instance: resolvedInstance,
                    parentCallId: callId,
                    principal,
                    signal: call.signal,
                    workingDirectory:
                        request.workingDirectory ?? principal.workingDirectory,
                    workspace: call.workspace ?? activeWorkspace,
                });
                const handleId = await provider.openHandle(
                    call.objectId,
                    call.target,
                    invocationContext,
                );
                openedHandles.push({
                    handleId,
                    objectId: call.objectId,
                    provider,
                });
                return handleId;
            },
            invokeHandle: async (call) => {
                const entry = openedHandles.find(
                    (candidate) =>
                        candidate.objectId === call.objectId &&
                        candidate.handleId === call.handleId,
                );
                if (entry === undefined || entry.provider.invokeHandle === undefined) {
                    throw new Error(
                        `Handle ${call.handleId} on devshell.${call.objectId} is not active.`,
                    );
                }
                const invocationContext = buildInvocationContext({
                    instance: activeInstance,
                    parentCallId: callId,
                    principal,
                    signal: call.signal,
                    workingDirectory:
                        request.workingDirectory ?? principal.workingDirectory,
                    workspace: activeWorkspace,
                });
                return await entry.provider.invokeHandle(
                    call.objectId,
                    call.handleId,
                    call.method,
                    call.input,
                    invocationContext,
                );
            },
            ready: async (call) => {
                const resolvedInstance = await resolveTargetInstance(call.instance);
                const workspace = call.workspace ?? activeWorkspace;
                if (resolvedInstance === undefined || workspace === undefined) {
                    throw new Error(
                        "ready() requires a bound instance and workspace.",
                    );
                }
                if (this.#instances !== undefined) {
                    const found = this.#instances.get(resolvedInstance);
                    if (found === undefined) {
                        throw new Error(`Instance ${resolvedInstance} is unavailable.`);
                    }
                }
                if (this.#endpoint !== undefined) {
                    const envelope = await createProcessTransport(
                        this.#endpoint,
                        resolvedInstance,
                    ).snapshot(call.signal);
                    return {
                        instance: resolvedInstance,
                        state: envelope.snapshot.daemonState,
                        workspace,
                    };
                }
                return {
                    instance: resolvedInstance,
                    state: "ready",
                    workspace,
                };
            },
        };

        try {
            const output = await this.#engine.evaluate({
                bridge,
                ...(request.filename === undefined ? {} : { filename: request.filename }),
                ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
                ...(options.signal === undefined ? {} : { signal: options.signal }),
                source: request.source,
                ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
            });
            return {
                hasValue: output.hasValue,
                logs: output.logs,
                meta: {
                    callId,
                    durationMs: output.durationMs,
                    toolCalls: output.toolCalls,
                    truncatedLogs: output.truncatedLogs,
                    truncatedValue: output.truncatedValue,
                },
                ...(output.hasValue ? { value: output.value } : {}),
            };
        } finally {
            await Promise.allSettled(
                openedHandles.map(async (entry) => {
                    await entry.provider.closeHandle?.(entry.objectId, entry.handleId);
                }),
            );
        }
    }

    #collectDescriptors(
        principal: CodeExecutionPrincipal,
        instance?: string,
    ): CodeObjectDescriptor[] {
        const merged = new Map<string, CodeObjectDescriptor>();
        for (const provider of this.#providers) {
            for (const descriptor of provider.describe(principal, instance)) {
                if (
                    principal.audience === "model" &&
                    descriptor.extensionId !== undefined &&
                    principal.allowedExtensions !== undefined &&
                    !principal.allowedExtensions.includes(descriptor.extensionId)
                ) {
                    continue;
                }
                const filteredMethods = descriptor.methods.filter((method) =>
                    method.audiences.includes(principal.audience),
                );
                if (filteredMethods.length === 0 && descriptor.callable !== true)
                    continue;
                if (!merged.has(descriptor.id)) {
                    merged.set(descriptor.id, {
                        ...descriptor,
                        methods: filteredMethods,
                    });
                }
            }
        }
        return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
    }

    #findProvider(
        objectId: string,
        principal: CodeExecutionPrincipal,
        instance?: string,
    ): CodeObjectProvider {
        for (const provider of this.#providers) {
            if (provider.owns(objectId, principal, instance)) return provider;
        }
        throw new TypeError(`Unknown namespace: devshell.${objectId}`);
    }

    #renderDts(
        objects: readonly CodeObjectDescriptor[],
        target?: string,
        filter?: string,
    ): string {
        if (target === undefined || target.trim().length === 0) {
            return emitOverviewDts(objects, filter);
        }
        const normalized = target.trim().replace(/^devshell\./u, "");
        const exact = objects.find((obj) => obj.id === normalized);
        if (exact !== undefined) {
            return emitObjectDts(exact, filter);
        }
        const dotIndex = normalized.indexOf(".");
        if (dotIndex > 0) {
            const ns = normalized.slice(0, dotIndex);
            const methodFilter = normalized.slice(dotIndex + 1);
            const parent = objects.find((obj) => obj.id === ns);
            if (parent !== undefined) {
                return emitObjectDts(parent, filter ?? methodFilter);
            }
        }
        return [
            `// Unknown namespace "${target}".`,
            `// Available namespaces: ${objects.map((obj) => obj.id).join(", ")}`,
        ].join("\n");
    }
}

function buildInvocationContext(options: {
    instance?: string;
    parentCallId: string;
    principal: CodeExecutionPrincipal;
    signal: AbortSignal;
    workingDirectory?: string;
    workspace?: string;
}): CodeMethodInvocationContext {
    return Object.freeze({
        audience: options.principal.audience,
        ...(options.principal.ctxId === undefined
            ? {}
            : { ctxId: options.principal.ctxId }),
        ...(options.instance === undefined ? {} : { instance: options.instance }),
        localOwner: options.principal.localOwner,
        parentCallId: options.parentCallId,
        requestId: options.principal.requestId,
        signal: options.signal,
        ...(options.workingDirectory === undefined
            ? {}
            : { workingDirectory: options.workingDirectory }),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    });
}
