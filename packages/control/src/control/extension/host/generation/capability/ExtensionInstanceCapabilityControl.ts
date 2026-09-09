import type {
    ExtensionInstanceCapability,
    ExtensionInstanceCreateResult,
    ExtensionInstanceEvent,
    ExtensionInstanceEventWatch,
    ExtensionInstanceLogEntry,
    ExtensionInstanceLogQuery,
    ExtensionInstanceRecord,
    ExtensionInstanceSnapshot
} from "@portable-devshell/extension/instance";
import type { ExtensionJsonValue } from "@portable-devshell/extension";
import {
    createError,
    errorCodes,
    type InstanceCreateResult,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type InstanceLogEntry,
    type JsonValue
} from "@portable-devshell/shared";

import type { InstanceRegistry } from "../../../../instance/registry/InstanceRegistry.js";
import type { RuntimeSubscriptionManager } from "../../../../../instance/runtime/RuntimeSubscriptionManager.js";

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

export interface ExtensionInstanceCapabilityControlOptions {
    allowed: boolean;
    create: ExtensionInstanceCreatePort;
    editor: ExtensionInstanceEditorPort;
    extensionId: string;
    instances: InstanceRegistry;
    listConfigured(): readonly ExtensionConfiguredInstance[];
    subscriptions: RuntimeSubscriptionManager;
}

/** Public Instance management capability backed by Control's authoritative registry/config coordinators. */
export class ExtensionInstanceCapabilityControl implements ExtensionInstanceCapability {
    readonly #allowed: boolean;
    readonly #create: ExtensionInstanceCreatePort;
    readonly #editor: ExtensionInstanceEditorPort;
    readonly #extensionId: string;
    readonly #instances: InstanceRegistry;
    readonly #listConfigured: () => readonly ExtensionConfiguredInstance[];
    readonly #subscriptions: RuntimeSubscriptionManager;

    constructor(options: ExtensionInstanceCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#create = options.create;
        this.#editor = options.editor;
        this.#extensionId = options.extensionId;
        this.#instances = options.instances;
        this.#listConfigured = options.listConfigured;
        this.#subscriptions = options.subscriptions;
    }

    async createSchema(): Promise<ExtensionJsonValue> {
        this.#assertAllowed();
        return toExtensionJson(this.#create.getSchema());
    }

    async validateCreate(draft: ExtensionJsonValue): Promise<ExtensionJsonValue> {
        this.#assertAllowed();
        return toExtensionJson(this.#create.validateDraft(draft as JsonValue));
    }

    async create(draft: ExtensionJsonValue): Promise<ExtensionInstanceCreateResult> {
        this.#assertAllowed();
        return toCreateResult(await this.#create.createInstance(draft as JsonValue));
    }

    async enable(name: string): Promise<void> {
        this.#assertAllowed();
        await this.#editor.enableInstance({ instanceName: requireName(name) });
    }

    async disable(name: string): Promise<void> {
        this.#assertAllowed();
        await this.#editor.disableInstance({ instanceName: requireName(name) });
    }

    async delete(name: string): Promise<void> {
        this.#assertAllowed();
        await this.#editor.deleteInstance({ instanceName: requireName(name) });
    }

    async list(): Promise<readonly ExtensionInstanceRecord[]> {
        this.#assertAllowed();
        return this.#listConfigured().map((configured) => {
            const descriptor = this.#instances.get(configured.name);
            return {
                enabled: configured.enabled,
                mcpEnabled: configured.mcpEnabled,
                name: configured.name,
                provider: configured.provider,
                ...(descriptor === undefined ? {} : { snapshot: toSnapshot(descriptor.worker.snapshot()) })
            };
        });
    }

    async snapshot(name: string): Promise<ExtensionInstanceSnapshot> {
        this.#assertAllowed();
        return toSnapshot(this.#require(name).worker.snapshot());
    }

    async refresh(name: string): Promise<ExtensionInstanceSnapshot> {
        this.#assertAllowed();
        return toSnapshot(await this.#require(name).worker.refreshStatus());
    }

    async start(name: string): Promise<ExtensionInstanceSnapshot> {
        this.#assertAllowed();
        const descriptor = this.#require(name);
        if (!descriptor.enabled) {
            throw createError({
                code: errorCodes.instanceConflict,
                details: { instance: descriptor.name, operation: "start" },
                message: `Instance ${descriptor.name} is disabled.`,
                retryable: false
            });
        }
        const snapshot = await descriptor.worker.start();
        this.#instances.markOwned(descriptor.name);
        return toSnapshot(snapshot);
    }

    async stop(name: string): Promise<ExtensionInstanceSnapshot> {
        this.#assertAllowed();
        const descriptor = this.#require(name);
        const snapshot = await descriptor.worker.stop();
        this.#instances.clearOwned(descriptor.name);
        if (!descriptor.enabled) this.#instances.delete(descriptor.name);
        return toSnapshot(snapshot);
    }

    async readLogs(name: string, query?: ExtensionInstanceLogQuery): Promise<readonly ExtensionInstanceLogEntry[]> {
        this.#assertAllowed();
        return (await this.#require(name).worker.readLogs(query)).map(toLogEntry);
    }

    async watchEvents(name: string, watch: ExtensionInstanceEventWatch): Promise<void> {
        this.#assertAllowed();
        if (!Number.isSafeInteger(watch.fromSeq) || watch.fromSeq < 1) {
            throw new TypeError("Extension instances watchEvents fromSeq must be a positive safe integer.");
        }
        const eventTypes = watch.eventTypes === undefined
            ? undefined
            : new Set(watch.eventTypes.map(requireEventType));
        const descriptor = this.#require(name);
        await this.#subscriptions.watch(
            descriptor.name,
            descriptor.worker,
            watch.fromSeq,
            watch.signal,
            {
                ...(eventTypes === undefined ? {} : {
                    eventFilter: (event) => eventTypes.has(event.type)
                }),
                onEvent: async (event) => await watch.onEvent(toEvent(event)),
                onGap: async (gap) => {
                    await watch.onGap?.({ ...gap });
                    return gap.nextSeq;
                }
            }
        );
    }

    #require(name: string) {
        const instance = requireName(name);
        const descriptor = this.#instances.get(instance);
        if (descriptor !== undefined) return descriptor;
        throw createError({
            code: errorCodes.instanceMissing,
            details: { instance },
            message: `Instance ${instance} was not found or is disabled.`,
            retryable: false
        });
    }

    #assertAllowed(): void {
        if (this.#allowed) return;
        throw new Error(`Extension ${this.#extensionId} did not declare the instances capability.`);
    }
}

function toCreateResult(value: InstanceCreateResult): ExtensionInstanceCreateResult {
    return {
        enabled: value.enabled,
        ...(value.mcpPath === undefined ? {} : { mcpPath: value.mcpPath }),
        name: value.name,
        ...(value.snapshot === undefined ? {} : { snapshot: toSnapshot(value.snapshot) })
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
        ...(value.effectiveSecurityMode === undefined ? {} : { effectiveSecurityMode: value.effectiveSecurityMode }),
        ...(value.lastErrorCode === undefined ? {} : { lastErrorCode: value.lastErrorCode }),
        ...(value.lastErrorMessage === undefined ? {} : { lastErrorMessage: value.lastErrorMessage }),
        lastSeq: value.lastSeq,
        name: value.name,
        ...(value.pid === undefined ? {} : { pid: value.pid }),
        ready: value.ready,
        status: value.status
    };
}

function toLogEntry(value: InstanceLogEntry): ExtensionInstanceLogEntry {
    return {
        at: value.at,
        ...(value.callId === undefined ? {} : { callId: value.callId }),
        ...(value.ctxId === undefined ? {} : { ctxId: value.ctxId }),
        ...(value.extensionId === undefined ? {} : { extensionId: value.extensionId }),
        instanceName: value.instanceName,
        message: value.message,
        ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
        seq: value.seq,
        ...(value.source === undefined ? {} : { source: value.source }),
        stream: value.stream,
        ...(value.toolName === undefined ? {} : { toolName: value.toolName })
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
        ...(value.data === undefined ? {} : { data: value.data as ExtensionJsonValue }),
        instanceName: value.instanceName,
        seq: value.seq,
        type: value.type
    };
}

function requireEventType(value: string): string {
    if (/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u.test(value)) return value;
    throw new TypeError(`Extension instances event type is invalid: ${value}.`);
}

function requireName(value: string): string {
    if (value.trim().length > 0) return value;
    throw new TypeError("Extension instances name must be a non-empty string.");
}

function toExtensionJson(value: unknown): ExtensionJsonValue {
    return JSON.parse(JSON.stringify(value)) as ExtensionJsonValue;
}
