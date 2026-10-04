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
    controlErrorCodes,
    type InstanceCreateResult,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type InstanceLogEntry,
    type JsonValue,
    runtimeErrorCodes,
} from "@portable-devshell/shared";

import type { InstanceRegistry } from "@portable-devshell/core";
import type { ProcessSubscriptionManager } from "@portable-devshell/core";

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
    instances: InstanceRegistry;
    listConfigured(): readonly ExtensionConfiguredInstance[];
    subscriptions: ProcessSubscriptionManager;
}

/** Read-only Instance observation backed by Control's authoritative registry. */
export class ExtensionInstanceObserveCapabilityControl implements ExtensionInstanceObserveCapability {
    readonly #allowed: boolean;
    readonly #extensionId: string;
    readonly #instances: InstanceRegistry;
    readonly #listConfigured: () => readonly ExtensionConfiguredInstance[];
    readonly #subscriptions: ProcessSubscriptionManager;

    constructor(options: ExtensionInstanceObserveCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#extensionId = options.extensionId;
        this.#instances = options.instances;
        this.#listConfigured = options.listConfigured;
        this.#subscriptions = options.subscriptions;
    }

    async list(): Promise<readonly ExtensionInstanceRecord[]> {
        this.#assertAllowed();
        return this.#listConfigured().map((configured) => {
            return {
                enabled: configured.enabled,
                mcpEnabled: configured.mcpEnabled,
                name: configured.name,
                provider: configured.provider,
            };
        });
    }

    #require(name: string) {
        return requireInstance(this.#instances, name);
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
    instances: InstanceRegistry;
}

/** Instance lifecycle/configuration authority, intentionally separate from observation. */
export class ExtensionInstanceManageCapabilityControl implements ExtensionInstanceManageCapability {
    readonly #allowed: boolean;
    readonly #create: ExtensionInstanceCreatePort;
    readonly #editor: ExtensionInstanceEditorPort;
    readonly #extensionId: string;
    readonly #instances: InstanceRegistry;

    constructor(options: ExtensionInstanceManageCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#create = options.create;
        this.#editor = options.editor;
        this.#extensionId = options.extensionId;
        this.#instances = options.instances;
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

    async disable(name: string): Promise<void> {
        this.#assertAllowed();
        await this.#editor.disableInstance({ instanceName: requireName(name) });
    }

    async delete(name: string): Promise<void> {
        this.#assertAllowed();
        await this.#editor.deleteInstance({ instanceName: requireName(name) });
    }

    #require(name: string) {
        return requireInstance(this.#instances, name);
    }

    #assertAllowed(): void {
        if (this.#allowed) return;
        throw new Error(
            `Extension ${this.#extensionId} did not declare the instance.manage capability.`,
        );
    }
}

function requireInstance(instances: InstanceRegistry, name: string) {
    const instance = requireName(name);
    const descriptor = instances.get(instance);
    if (descriptor !== undefined) return descriptor;
    throw createRemoteError({
        code: controlErrorCodes.instanceNotFound,
        details: { instance },
        message: `Instance ${instance} was not found or is disabled.`,
        retryable: false,
    });
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
