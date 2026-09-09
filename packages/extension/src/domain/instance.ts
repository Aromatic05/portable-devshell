import type { ExtensionJsonValue } from "../ExtensionApi.js";

export type ExtensionInstanceProvider = "docker" | "local" | "podman" | "reverse" | "ssh";
export type ExtensionInstanceRuntimeStatus = "failed" | "ready" | "running" | "stale" | "stopped";
export type ExtensionInstanceDaemonState = "failed" | "running" | "stale" | "starting" | "stopped" | "stopping";
export type ExtensionInstanceConnectionState = "connected" | "connecting" | "disconnected" | "failed" | "reconnecting";

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
    extensionId?: string;
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
    onEvent(event: ExtensionInstanceEvent): Promise<void> | void;
    onGap?(gap: ExtensionInstanceEventGap): Promise<void> | void;
    signal: AbortSignal;
}

/** Host-owned Instance management operations available to an Extension generation. */
export interface ExtensionInstanceCapability {
    create(draft: ExtensionJsonValue): Promise<ExtensionInstanceCreateResult>;
    createSchema(): Promise<ExtensionJsonValue>;
    delete(name: string): Promise<void>;
    disable(name: string): Promise<void>;
    enable(name: string): Promise<void>;
    list(): Promise<readonly ExtensionInstanceRecord[]>;
    readLogs(name: string, query?: ExtensionInstanceLogQuery): Promise<readonly ExtensionInstanceLogEntry[]>;
    refresh(name: string): Promise<ExtensionInstanceSnapshot>;
    snapshot(name: string): Promise<ExtensionInstanceSnapshot>;
    start(name: string): Promise<ExtensionInstanceSnapshot>;
    stop(name: string): Promise<ExtensionInstanceSnapshot>;
    validateCreate(draft: ExtensionJsonValue): Promise<ExtensionJsonValue>;
    watchEvents(name: string, watch: ExtensionInstanceEventWatch): Promise<void>;
}
