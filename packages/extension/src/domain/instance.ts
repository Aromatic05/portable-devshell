import type { ExtensionJsonValue } from "../ExtensionCore.js";

export type ExtensionInstanceProvider =
    "docker" | "local" | "podman" | "reverse" | "ssh";
export type ExtensionInstanceRuntimeStatus =
    "failed" | "ready" | "running" | "stale" | "stopped" | "offline";
export type ExtensionInstanceDaemonState =
    "failed" | "running" | "stale" | "starting" | "stopped" | "stopping" | "unknown";
export type ExtensionInstanceConnectionState =
    "connected" | "connecting" | "disconnected" | "failed" | "reconnecting";

export interface ExtensionInstanceSnapshot {
    connectionState: ExtensionInstanceConnectionState;
    daemonState: ExtensionInstanceDaemonState;
    effectiveSecurityMode?: "disabled" | "workspace";
    lastErrorCode?: string;
    lastErrorMessage?: string;
    lastSeq: number;
    name: string;
    pid?: number;
    ready: boolean;
    status: ExtensionInstanceRuntimeStatus;
}

export interface ExtensionInstanceRecord {
    enabled: boolean;
    mcpEnabled: boolean;
    name: string;
    provider: ExtensionInstanceProvider;
    snapshot?: ExtensionInstanceSnapshot;
}

/** The current host-owned runtime generation for an Instance is being retired. */
export interface ExtensionInstanceGenerationRetiredEvent {
    readonly instance: string;
}

export interface ExtensionInstanceCreateResult {
    enabled: boolean;
    mcpPath?: string;
    name: string;
    snapshot?: ExtensionInstanceSnapshot;
}

export interface ExtensionInstanceLogEntry {
    at: string;
    callId?: string;
    ctxId?: string;
    instanceName: string;
    message: string;
    requestId?: string;
    seq: number;
    source?: string;
    stream: "stderr" | "stdout";
    toolName?: string;
}

export interface ExtensionInstanceLogQuery {
    fromSeq?: number;
    limit?: number;
    maxDecodedBytes?: number;
}

export interface ExtensionInstanceEvent {
    at: string;
    data?: ExtensionJsonValue;
    instanceName: string;
    seq: number;
    type: string;
}

export interface ExtensionInstanceEventGap {
    lastSeq: number;
    nextSeq: number;
}

export interface ExtensionInstanceEventWatch {
    eventTypes?: readonly string[];
    fromSeq: number;
    /** Buffered events and cursor, delivered once before live events; an initial gap rejects. */
    onSeed?(seed: { events: readonly ExtensionInstanceEvent[]; lastSeq: number }): Promise<void> | void;
    onEvent(event: ExtensionInstanceEvent): Promise<void> | void;
    onGap?(gap: ExtensionInstanceEventGap): Promise<void> | void;
    signal: AbortSignal;
}

/** Read-only observation of host-owned Instance state and runtime telemetry. */
export interface ExtensionInstanceObserveCapability {
    list(): Promise<readonly ExtensionInstanceRecord[]>;
    snapshot(name: string): Promise<ExtensionInstanceSnapshot>;
    refresh(name: string): Promise<ExtensionInstanceSnapshot>;
    readLogs(
        name: string,
        query?: ExtensionInstanceLogQuery,
    ): Promise<readonly ExtensionInstanceLogEntry[]>;
    watchEvents(
        name: string,
        watch: ExtensionInstanceEventWatch,
    ): Promise<void>;
}

/** Host-owned Instance lifecycle operations without observation authority. */
export interface ExtensionInstanceManageCapability {
    create(draft: ExtensionJsonValue): Promise<ExtensionInstanceCreateResult>;
    createSchema(): Promise<ExtensionJsonValue>;
    validateCreate(draft: ExtensionJsonValue): Promise<ExtensionJsonValue>;
    delete(name: string): Promise<void>;
    disable(name: string): Promise<void>;
    enable(name: string): Promise<void>;
    start(name: string): Promise<ExtensionInstanceSnapshot>;
    stop(name: string): Promise<ExtensionInstanceSnapshot>;
}

/** Publication of host-owned Instance events by an Extension generation. */
export interface ExtensionInstanceEventPublishCapability {
    appendEvent(
        name: string,
        type: string,
        data?: ExtensionJsonValue,
    ): Promise<void>;
}
