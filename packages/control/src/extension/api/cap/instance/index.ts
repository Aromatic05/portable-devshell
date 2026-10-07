import type {
    ExtensionInstanceCreateResult,
    ExtensionInstanceEvent,
    ExtensionInstanceEventPublishCapability,
    ExtensionInstanceEventWatch,
    ExtensionInstanceLogEntry,
    ExtensionInstanceLogQuery,
    ExtensionInstanceManageCapability,
    ExtensionInstanceObserveCapability,
    ExtensionInstanceRecord,
    ExtensionInstanceSnapshot,
} from "@portable-devshell/extension/instance";
import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    createRemoteError,
    type InstanceCreateResult,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type InstanceLogEntry,
    type InstanceRuntimeTransport,
    type JsonValue,
    type ProcessTransport,
    STREAM_GAP_CODE,
} from "@portable-devshell/shared";

export interface ExtensionInstanceCreatePort {
    createInstance(params?: JsonValue): Promise<InstanceCreateResult>;
    getSchema(): InstanceCreateSchema;
    validateDraft(params?: JsonValue): InstanceCreateSummary;
}

export interface ExtensionInstanceEditorPort {
    deleteInstance(params?: JsonValue): Promise<JsonValue>;
    disableInstance(params?: JsonValue): Promise<JsonValue>;
    enableInstance(params?: JsonValue): Promise<JsonValue>;
}

export interface ExtensionConfiguredInstance {
    enabled: boolean;
    mcpEnabled: boolean;
    name: string;
    provider: ExtensionInstanceRecord["provider"];
}

export interface ExtensionInstanceObserveCapabilityControlOptions {
    allowed: boolean;
    extensionId: string;
    listConfigured(): readonly ExtensionConfiguredInstance[];
    process(name: string): ProcessTransport;
    runtime(name: string): InstanceRuntimeTransport;
}

/** Read-only Instance observation backed by Control's authoritative registry. */
export class ExtensionInstanceObserveCapabilityControl implements ExtensionInstanceObserveCapability {
    readonly #allowed: boolean;
    readonly #extensionId: string;
    readonly #listConfigured: () => readonly ExtensionConfiguredInstance[];
    readonly #process: (name: string) => ProcessTransport;
    readonly #runtime: (name: string) => InstanceRuntimeTransport;

    constructor(options: ExtensionInstanceObserveCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#extensionId = options.extensionId;
        this.#listConfigured = options.listConfigured;
        this.#process = options.process;
        this.#runtime = options.runtime;
    }

    async snapshot(name: string): Promise<ExtensionInstanceSnapshot> {
        this.#assertAllowed();
        return toSnapshot((await this.#process(name).snapshot()).snapshot);
    }

    async refresh(name: string): Promise<ExtensionInstanceSnapshot> {
        this.#assertAllowed();
        return toSnapshot((await this.#process(name).refresh()).snapshot);
    }

    async readLogs(name: string, query?: ExtensionInstanceLogQuery): Promise<readonly ExtensionInstanceLogEntry[]> {
        this.#assertAllowed();
        return (await this.#process(name).readLogs(query)).map(toLogEntry);
    }

    async list(): Promise<readonly ExtensionInstanceRecord[]> {
        this.#assertAllowed();
        return await Promise.all(this.#listConfigured().map(async (configured) => {
            const snapshot = configured.enabled
                ? await this.#process(configured.name)
                      .snapshot()
                      .then((value) => toSnapshot(value.snapshot))
                      .catch(() => undefined)
                : undefined;
            return {
                enabled: configured.enabled,
                mcpEnabled: configured.mcpEnabled,
                name: configured.name,
                provider: configured.provider,
                ...(snapshot === undefined ? {} : { snapshot }),
            };
        }));
    }

    async watchEvents(name: string, watch: ExtensionInstanceEventWatch): Promise<void> {
        this.#assertAllowed();
        watch.signal.throwIfAborted();
        if (!Number.isSafeInteger(watch.fromSeq) || watch.fromSeq < 0)
            throw new TypeError("Instance event watch fromSeq must be a non-negative integer.");
        const runtime = this.#runtime(requireName(name));
        const types = watch.eventTypes === undefined ? undefined : new Set(watch.eventTypes);
        let fromSeq = watch.fromSeq;
        if (watch.onSeed !== undefined) {
            const seed = await runtime.readEvents(fromSeq);
            if (seed.kind === "gap") {
                throw createRemoteError({
                    code: STREAM_GAP_CODE,
                    message: "Requested event sequence is no longer available. Pull a fresh snapshot.",
                    retryable: true,
                    details: {
                        instance: name,
                        latestSeq: seed.lastSeq,
                        oldestAvailableSeq: seed.nextSeq,
                        requestedFromSeq: fromSeq,
                    },
                });
            }
            await watch.onSeed({
                events: seed.events.filter((event) => types === undefined || types.has(event.type)).map(toEvent),
                lastSeq: seed.lastSeq,
            });
            fromSeq = seed.lastSeq + 1;
        }
        if (watch.signal.aborted) return;
        const stream = await runtime.subscribeEvents(fromSeq);
        const abort = () => stream.close();
        watch.signal.addEventListener("abort", abort, { once: true });
        try {
            if (watch.signal.aborted) return;
            for (;;) {
                const message = await stream.next();
                if (message.kind === "closed") {
                    if (message.error !== undefined) throw message.error;
                    return;
                }
                if (message.kind === "gap") {
                    await watch.onGap?.({
                        lastSeq: message.gap.lastSeq,
                        nextSeq: message.gap.nextSeq,
                    });
                    continue;
                }
                if (types === undefined || types.has(message.event.type))
                    await watch.onEvent(toEvent(message.event));
            }
        } finally {
            watch.signal.removeEventListener("abort", abort);
            stream.close();
        }
    }

    #assertAllowed(): void {
        if (this.#allowed) return;
        throw new Error(
            `Extension ${this.#extensionId} did not declare the instance.observe capability.`,
        );
    }
}

export interface ExtensionInstanceManageCapabilityControlOptions {
    allowed: boolean;
    create: ExtensionInstanceCreatePort;
    editor: ExtensionInstanceEditorPort;
    extensionId: string;
    process(name: string): ProcessTransport;
}

/** Instance lifecycle/configuration authority, intentionally separate from observation. */
export class ExtensionInstanceManageCapabilityControl implements ExtensionInstanceManageCapability {
    readonly #allowed: boolean;
    readonly #create: ExtensionInstanceCreatePort;
    readonly #editor: ExtensionInstanceEditorPort;
    readonly #extensionId: string;
    readonly #process: (name: string) => ProcessTransport;

    constructor(options: ExtensionInstanceManageCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#create = options.create;
        this.#editor = options.editor;
        this.#extensionId = options.extensionId;
        this.#process = options.process;
    }

    async createSchema(): Promise<ExtensionJsonValue> {
        this.#assertAllowed();
        return toExtensionJson(this.#create.getSchema());
    }

    async validateCreate(
        draft: ExtensionJsonValue,
    ): Promise<ExtensionJsonValue> {
        this.#assertAllowed();
        return toExtensionJson(this.#create.validateDraft(draft as JsonValue));
    }

    async create(
        draft: ExtensionJsonValue,
    ): Promise<ExtensionInstanceCreateResult> {
        this.#assertAllowed();
        return toCreateResult(
            await this.#create.createInstance(draft as JsonValue),
        );
    }

    async enable(name: string): Promise<void> {
        this.#assertAllowed();
        await this.#editor.enableInstance({ instanceName: requireName(name) });
    }

    async start(name: string): Promise<ExtensionInstanceSnapshot> {
        this.#assertAllowed();
        const started = await this.#process(name).start();
        return toSnapshot(await started.snapshot);
    }

    async stop(name: string): Promise<ExtensionInstanceSnapshot> {
        this.#assertAllowed();
        return toSnapshot(await this.#process(name).stop());
    }

    async disable(name: string): Promise<void> {
        this.#assertAllowed();
        await this.#editor.disableInstance({ instanceName: requireName(name) });
    }

    async delete(name: string): Promise<void> {
        this.#assertAllowed();
        await this.#editor.deleteInstance({ instanceName: requireName(name) });
    }

    #assertAllowed(): void {
        if (this.#allowed) return;
        throw new Error(
            `Extension ${this.#extensionId} did not declare the instance.manage capability.`,
        );
    }
}

export class ExtensionInstanceEventPublishCapabilityControl implements ExtensionInstanceEventPublishCapability {
    constructor(private readonly options: {
        allowed: boolean;
        extensionId: string;
        runtime(name: string): InstanceRuntimeTransport;
    }) {}

    async appendEvent(name: string, type: string, data?: ExtensionJsonValue): Promise<void> {
        if (!this.options.allowed)
            throw new Error(`Extension ${this.options.extensionId} did not declare the instance.events.publish capability.`);
        await this.options.runtime(requireName(name)).appendEvent(
            requireEventType(type),
            data as JsonValue | undefined,
        );
    }
}

function toCreateResult(
    value: InstanceCreateResult,
): ExtensionInstanceCreateResult {
    return {
        enabled: value.enabled,
        ...(value.mcpPath === undefined ? {} : { mcpPath: value.mcpPath }),
        name: value.name,
        ...(value.snapshot === undefined
            ? {}
            : { snapshot: toSnapshot(value.snapshot) }),
    };
}

function toSnapshot(value: {
    connectionState: ExtensionInstanceSnapshot["connectionState"];
    daemonState: ExtensionInstanceSnapshot["daemonState"];
    effectiveSecurityMode?: ExtensionInstanceSnapshot["effectiveSecurityMode"];
    lastErrorCode?: string;
    lastErrorMessage?: string;
    lastSeq: number;
    name: string;
    pid?: number;
    ready: boolean;
    status: ExtensionInstanceSnapshot["status"];
}): ExtensionInstanceSnapshot {
    return {
        connectionState: value.connectionState,
        daemonState: value.daemonState,
        ...(value.effectiveSecurityMode === undefined
            ? {}
            : { effectiveSecurityMode: value.effectiveSecurityMode }),
        ...(value.lastErrorCode === undefined
            ? {}
            : { lastErrorCode: value.lastErrorCode }),
        ...(value.lastErrorMessage === undefined
            ? {}
            : { lastErrorMessage: value.lastErrorMessage }),
        lastSeq: value.lastSeq,
        name: value.name,
        ...(value.pid === undefined ? {} : { pid: value.pid }),
        ready: value.ready,
        status: value.status,
    };
}

function toLogEntry(value: InstanceLogEntry): ExtensionInstanceLogEntry {
    return {
        at: value.at,
        ...(value.callId === undefined ? {} : { callId: value.callId }),
        ...(value.ctxId === undefined ? {} : { ctxId: value.ctxId }),
        instanceName: value.instanceName,
        message: value.message,
        ...(value.requestId === undefined
            ? {}
            : { requestId: value.requestId }),
        seq: value.seq,
        ...(value.source === undefined ? {} : { source: value.source }),
        stream: value.stream,
        ...(value.toolName === undefined ? {} : { toolName: value.toolName }),
    };
}

function toEvent(value: {
    at: string;
    data?: JsonValue;
    instanceName: string;
    seq: number;
    type: string;
}): ExtensionInstanceEvent {
    return {
        at: value.at,
        ...(value.data === undefined
            ? {}
            : { data: value.data as ExtensionJsonValue }),
        instanceName: value.instanceName,
        seq: value.seq,
        type: value.type,
    };
}

function requireEventType(value: string): string {
    if (/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u.test(value))
        return value;
    throw new TypeError(`Extension instance event type is invalid: ${value}.`);
}

function requireName(value: string): string {
    if (value.trim().length > 0) return value;
    throw new TypeError("Extension instance name must be a non-empty string.");
}

function toExtensionJson(value: unknown): ExtensionJsonValue {
    return JSON.parse(JSON.stringify(value)) as ExtensionJsonValue;
}
